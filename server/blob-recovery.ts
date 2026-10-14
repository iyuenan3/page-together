import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { requireThat } from './errors.js';
import type { Store } from './store.js';

const keyPattern = /^[A-Za-z0-9_-]{43}=$/;
const temporaryPattern = /^\.tmp-[a-f0-9-]{36}$/;
const recoveryPattern = /^[a-f0-9-]{36}--(?:\.tmp-[a-f0-9-]{36}|[A-Za-z0-9_-]{43}=)$/;
export function syncPath(path: string) {
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** A service and an offline recovery command must never scan the same live uploads. */
export function lockData(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A separate SQLite lease releases its OS lock on SIGKILL. It never holds a
  // transaction on the content database, and needs no racy stale PID deletion.
  const lease = new Database(join(directory, 'service-lease.sqlite'));
  try { lease.pragma('busy_timeout = 0'); lease.exec('BEGIN EXCLUSIVE'); }
  catch (error) {
    lease.close();
    requireThat((error as { code: string }).code !== 'SQLITE_BUSY', 409, 'data_directory_in_use');
    throw error;
  }
  return () => { if (lease.open) { lease.exec('ROLLBACK'); lease.close(); } };
}

export function fileDigest(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let size = 0, count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null))) { size += count; digest.update(chunk.subarray(0, count)); }
    const hash = digest.digest(); return { size, hash: hash.toString('hex'), key: hash.toString('base64url') + '=' };
  } finally { closeSync(fd); }
}

/** No orphan becomes readable authority without an explicit, currently authorized re-upload. */
export function recoverBlobFiles(store: Store, verifyIndex = true) {
  const blobs = join(store.directory, 'blobs'), recovery = join(store.directory, 'attachment-recovery');
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  mkdirSync(recovery, { recursive: true, mode: 0o700 });
  const indexed = store.db.prepare('SELECT key,size,hash FROM blobs').all() as { key: string; size: number; hash: string }[];
  const known = new Set(indexed.map(row => row.key));
  const candidates = readdirSync(blobs).filter(name => temporaryPattern.test(name) || keyPattern.test(name) && !known.has(name));
  const originals = [
    ...candidates.map(name => ({ name, path: join(blobs, name) })),
    ...readdirSync(recovery).map(name => { requireThat(recoveryPattern.test(name), 500, 'invalid_recovery_file'); return { name, path: join(recovery, name) }; }),
  ];
  const digests = originals.map(original => {
    requireThat(lstatSync(original.path).isFile() && !lstatSync(original.path).isSymbolicLink(), 500, 'orphan_attachment_invalid');
    return { ...original, ...fileDigest(original.path) };
  });
  let restored = 0;
  if (verifyIndex) for (const row of indexed) {
    const path = join(blobs, row.key);
    if (!existsSync(path)) {
      const original = digests.find(candidate => candidate.size === row.size && candidate.hash === row.hash);
      requireThat(original, 500, 'indexed_attachment_missing');
      const temporary = join(blobs, '.tmp-' + randomUUID());
      copyFileSync(original.path, temporary, constants.COPYFILE_EXCL); syncPath(temporary);
      linkSync(temporary, path); syncPath(blobs); unlinkSync(temporary); syncPath(blobs); restored++;
    }
    requireThat(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 500, 'indexed_attachment_invalid');
    const actual = fileDigest(path);
    requireThat(actual.size === row.size && actual.hash === row.hash && actual.key === row.key, 500, 'indexed_attachment_corrupt');
  }
  for (const name of candidates) {
    const path = join(blobs, name);
    requireThat(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 500, 'orphan_attachment_invalid');
    // Detach hardlinks: later damage to the active file must not mutate its
    // retained original. Publish and sync the independent copy before retiring
    // the redundant upload path. An interrupted copy remains available too.
    const target = join(recovery, randomUUID() + '--' + name);
    copyFileSync(path, target, constants.COPYFILE_EXCL); syncPath(target);
    const expected = digests.find(original => original.path === path)!;
    const actual = fileDigest(target);
    requireThat(expected.hash === actual.hash && expected.size === actual.size, 500, 'recovery_copy_mismatch');
    syncPath(recovery); unlinkSync(path); syncPath(blobs);
  }
  return { quarantined: candidates.length, restored, retained: readdirSync(recovery).length };
}

/** Export private recovery originals to a new directory; never alter snapshots or index files. */
export function exportRecoveredBlobs(store: Store, destination: string) {
  // An administrator can export originals even when a damaged indexed file
  // prevents normal startup; this never makes those bytes online authority.
  recoverBlobFiles(store, false);
  const recovery = join(store.directory, 'attachment-recovery');
  mkdirSync(destination, { mode: 0o700 });
  const records = readdirSync(recovery).map(name => {
    const source = join(recovery, name);
    requireThat(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 500, 'orphan_attachment_invalid');
    const data = fileDigest(source), target = name + '.bin';
    copyFileSync(source, join(destination, target), constants.COPYFILE_EXCL); syncPath(join(destination, target));
    const publishedKey = name.slice(38);
    return { file: target, original: name, ...data, verifiedContentAddress: keyPattern.test(publishedKey) && publishedKey === data.key, withinUploadLimit: data.size <= store.options.maxBlobBytes };
  });
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: 1, records }, null, 2), { flag: 'wx', mode: 0o600 });
  syncPath(join(destination, 'manifest.json')); syncPath(destination);
  return { files: records.length };
}
