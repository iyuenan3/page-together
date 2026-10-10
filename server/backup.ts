import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { requireThat } from './errors.js';
import { hash, Store } from './store.js';

interface Manifest {
  version: 1;
  databaseHash: string;
  blobs: { key: string; size: number; hash: string }[];
}
function syncFile(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function backup(store: Store, destination: string) {
  // Exclusive destination creation preserves every earlier backup.
  await mkdir(destination, { mode: 0o700 });
  const dbPath = join(destination, 'space.sqlite');
  await store.db.backup(dbPath);
  syncFile(dbPath);
  const snapshot = new Database(dbPath, { readonly: true });
  let blobs: Manifest['blobs'];
  try { blobs = snapshot.prepare('SELECT key,size,hash FROM blobs').all() as Manifest['blobs']; }
  finally { snapshot.close(); }
  await mkdir(join(destination, 'blobs'), { mode: 0o700 });
  for (const blob of blobs) {
    const target = join(destination, 'blobs', blob.key);
    await copyFile(join(store.directory, 'blobs', blob.key), target);
    requireThat(hash(readFileSync(target)) === blob.hash, 500, 'backup_blob_mismatch');
    syncFile(target);
  }
  const manifest: Manifest = { version: 1, databaseHash: hash(readFileSync(dbPath)), blobs };
  // The manifest is published last; incomplete directories cannot be restored.
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  syncFile(join(destination, 'manifest.json'));
  syncFile(join(destination, 'blobs'));
  syncFile(destination);
}
export async function restore(source: string, destination: string) {
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as Manifest;
  requireThat(manifest.version === 1 && Array.isArray(manifest.blobs), 400, 'invalid_backup');
  requireThat(hash(readFileSync(join(source, 'space.sqlite'))) === manifest.databaseHash, 400, 'invalid_backup');
  for (const blob of manifest.blobs) {
    requireThat(/^[A-Za-z0-9_-]{43}=$/.test(blob.key), 400, 'invalid_backup');
    const bytes = readFileSync(join(source, 'blobs', blob.key));
    requireThat(bytes.length === blob.size && hash(bytes) === blob.hash, 400, 'invalid_backup');
  }
  await mkdir(destination, { mode: 0o700 });
  await copyFile(join(source, 'space.sqlite'), join(destination, 'space.sqlite'));
  await mkdir(join(destination, 'blobs'), { mode: 0o700 });
  for (const blob of manifest.blobs) await copyFile(join(source, 'blobs', blob.key), join(destination, 'blobs', blob.key));
  const store = new Store(destination);
  const recoveryCode = randomBytes(32).toString('base64url');
  try {
    requireThat(store.db.pragma('integrity_check', { simple: true }) === 'ok', 400, 'invalid_backup');
    const indexed = store.db.prepare('SELECT key,size,hash FROM blobs ORDER BY key').all();
    requireThat(JSON.stringify(indexed) === JSON.stringify([...manifest.blobs].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)), 400, 'invalid_backup');
    store.db.transaction(() => {
      store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(randomUUID(), 'epoch');
      store.db.prepare('UPDATE settings SET value=? WHERE key=?').run('1', 'paused');
      store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(hash(recoveryCode), 'recovery_hash');
      store.db.prepare('DELETE FROM sessions').run();
      store.db.prepare('DELETE FROM invitations').run();
      store.db.prepare('UPDATE members SET active=0 WHERE owner=0').run();
    }).immediate();
    for (const blob of manifest.blobs) syncFile(join(destination, 'blobs', blob.key));
    syncFile(join(destination, 'blobs'));
    return { recoveryCode, epoch: store.epoch };
  } finally { store.close(); syncFile(destination); }
}
