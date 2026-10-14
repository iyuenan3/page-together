import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store, hash } from '../server/store.js';
import { exportRecoveredBlobs } from '../server/blob-recovery.js';
import { blobWriteHeaders } from '../shared/attachments.js';
import { backup, restore } from '../server/backup.js';

test('SIGKILL between durable file publication and SQL index preserves originals for authorized resubmission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'page-together-upload-kill-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const setup = new Store(directory), initial = setup.initialize('崩溃原件');
  const owner = setup.recoverOwner(initial.recoveryCode), sessionHash = hash(owner.session);
  setup.createDocument(sessionHash, 'crash', '原件');
  const headers = { Origin: '', Cookie: 'pt_session=' + owner.session, ...blobWriteHeaders({ docId: 'crash', epoch: setup.epoch, generation: 1, memberId: owner.member.id, accessRevision: 0 }) };
  setup.close();
  async function start(crash: boolean) {
    const child = fork(new URL('./server-process.js', import.meta.url), { env: { ...process.env, TEST_DATA_DIR: directory, TEST_CRASH_BLOB_COMMIT: crash ? '1' : '0' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } });
    const [message] = await once(child, 'message');
    return { child, origin: (message as { origin: string }).origin };
  }
  const bytes = Buffer.alloc(128 * 1024, 0x47), key = Buffer.from(hash(bytes), 'hex').toString('base64url') + '=';
  const first = await start(true), killed = once(first.child, 'exit');
  const failed = fetch(first.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { ...headers, Origin: first.origin }, body: bytes }).catch(() => undefined);
  await killed; assert.equal(first.child.signalCode, 'SIGKILL'); assert.equal(await failed, undefined);
  assert.equal(readdirSync(join(directory, 'blobs')).length, 2, 'both temporary and published hardlinks actually exist after SIGKILL');
  const second = await start(false);
  assert.equal(readdirSync(join(directory, 'blobs')).length, 0);
  const retained = readdirSync(join(directory, 'attachment-recovery')); assert.equal(retained.length, 2);
  for (const name of retained) assert.deepEqual(readFileSync(join(directory, 'attachment-recovery', name)), bytes);
  assert.equal((await fetch(second.origin + '/api/blobs/' + encodeURIComponent(key), { headers: { ...headers, Origin: second.origin } })).status, 404);
  const receipt = await fetch(second.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { ...headers, Origin: second.origin }, body: bytes });
  assert.equal(receipt.status, 200); assert.equal((await receipt.json() as { saved: boolean }).saved, true);
  const downloaded = await fetch(second.origin + '/api/blobs/' + encodeURIComponent(key), { headers: { ...headers, Origin: second.origin } });
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const exit = once(second.child, 'exit'); second.child.kill('SIGTERM'); await exit;
  const saved = new Store(directory); t.after(() => saved.close());
  const exported = join(directory, 'recovered'); assert.equal(exportRecoveredBlobs(saved, exported).files, 2);
  const backupDir = join(directory, 'backup'); await backup(saved, backupDir);
  const restoredDir = join(directory, 'restored'); await restore(backupDir, restoredDir);
  assert.equal(readdirSync(join(restoredDir, 'attachment-recovery')).length, 2);
  assert.deepEqual(readFileSync(join(restoredDir, 'blobs', key)), bytes);
});
