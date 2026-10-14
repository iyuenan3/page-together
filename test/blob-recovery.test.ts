import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { exportRecoveredBlobs, fileDigest, lockData, recoverBlobFiles } from '../server/blob-recovery.js';
import { hash, Store } from '../server/store.js';

function directory(t: test.TestContext) { const path = mkdtempSync(join(tmpdir(), 'page-together-recovery-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function key(bytes: Uint8Array) { return Buffer.from(hash(bytes), 'hex').toString('base64url') + '='; }

test('orphan published bytes and partial uploads survive repeated startup and exclusive recovery export', t => {
  const data = directory(t), store = new Store(data); t.after(() => store.close()); recoverBlobFiles(store);
  const bytes = Buffer.from('完整崩溃原件'), original = key(bytes);
  writeFileSync(join(data, 'blobs', original), bytes);
  writeFileSync(join(data, 'blobs', '.tmp-' + randomUUID()), 'partial original');
  const result = recoverBlobFiles(store); assert.equal(result.quarantined, 2); assert.equal(result.retained, 2);
  assert.equal(readdirSync(join(data, 'blobs')).length, 0);
  assert.equal((store.db.prepare('SELECT count(*) n FROM blobs').get() as { n: number }).n, 0);
  assert.equal(recoverBlobFiles(store).retained, 2);
  const output = join(data, 'export'); assert.equal(exportRecoveredBlobs(store, output).files, 2);
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.records.find((record: { key: string }) => record.key === original).hash, hash(bytes));
  for (const record of manifest.records) assert.deepEqual(fileDigest(join(output, record.file)), { size: record.size, hash: record.hash, key: record.key });
  assert.throws(() => exportRecoveredBlobs(store, output), /EEXIST/); assert.equal(recoverBlobFiles(store).retained, 2);
});

test('an indexed missing original is restored only from matching bytes, corruption stops startup without changing history', t => {
  const data = directory(t), store = new Store(data); recoverBlobFiles(store);
  const bytes = Buffer.from('已确认保存的原件'), original = key(bytes), temporary = '.tmp-' + randomUUID();
  store.db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(original, bytes.length, hash(bytes));
  writeFileSync(join(data, 'blobs', temporary), bytes);
  assert.equal(recoverBlobFiles(store).restored, 1);
  assert.deepEqual(readFileSync(join(data, 'blobs', original)), bytes);
  writeFileSync(join(data, 'blobs', original), 'corrupt'); store.close();
  assert.throws(() => createApp({ directory: data, origin: 'http://localhost:0' }), /indexed_attachment_corrupt/);
  assert.equal(readFileSync(join(data, 'blobs', original), 'utf8'), 'corrupt');
  const release = lockData(data); release(); // Failed startup releases the directory lease.
  unlinkSync(join(data, 'blobs', original));
  const again = new Store(data); t.after(() => again.close());
  assert.equal(recoverBlobFiles(again).restored, 1, 'retained recovery originals can repair a later missing indexed file');
  writeFileSync(join(data, 'blobs', original), 'second active corruption');
  for (const name of readdirSync(join(data, 'attachment-recovery'))) assert.deepEqual(readFileSync(join(data, 'attachment-recovery', name)), bytes);
  unlinkSync(join(data, 'blobs', original));
  for (const name of readdirSync(join(data, 'attachment-recovery'))) writeFileSync(join(data, 'attachment-recovery', name), 'different');
  assert.throws(() => recoverBlobFiles(again), /indexed_attachment_missing/);
});

test('a live service excludes a second service and offline recovery until its lease is released', async t => {
  const data = directory(t), options = { directory: data, origin: 'http://localhost:0' };
  const first = createApp(options);
  assert.throws(() => createApp(options), /data_directory_in_use/);
  assert.throws(() => lockData(data), /data_directory_in_use/);
  await first.close();
  const second = createApp(options); await second.close();
});

test('a retained upload original is independent of its indexed hardlink and remains exportable during corruption', t => {
  const data = directory(t), store = new Store(data); t.after(() => store.close()); recoverBlobFiles(store);
  const bytes = Buffer.from('不能共用 inode 的已确认原件'), original = key(bytes), temporary = '.tmp-' + randomUUID();
  writeFileSync(join(data, 'blobs', temporary), bytes); linkSync(join(data, 'blobs', temporary), join(data, 'blobs', original));
  store.db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(original, bytes.length, hash(bytes));
  assert.equal(recoverBlobFiles(store).quarantined, 1);
  writeFileSync(join(data, 'blobs', original), 'damaged active bytes');
  const retained = readdirSync(join(data, 'attachment-recovery'))[0];
  assert.deepEqual(readFileSync(join(data, 'attachment-recovery', retained)), bytes);
  assert.throws(() => recoverBlobFiles(store), /indexed_attachment_corrupt/);
  assert.equal(exportRecoveredBlobs(store, join(data, 'export-corrupt')).files, 1);
});
