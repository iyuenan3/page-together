import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { backup, restore } from '../server/backup.js';
import { hash, Store } from '../server/store.js';
import { attachmentHeaders, fixture, Peer } from './helpers.js';
import { blobWriteHeaders } from '../shared/attachments.js';

const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64');
async function open(peer: Peer, scope: { docId: string; epoch: string; generation: number }, doc = new Y.Doc()) {
  peer.send({ v: 1, type: 'open', requestId: 'open-' + randomUUID(), ...scope, stateVector: encoded(Y.encodeStateVector(doc)) });
  const sync = await peer.next('sync');
  Y.applyUpdate(doc, Buffer.from(sync.update, 'base64'));
  return doc;
}

test('module workers and PDF decoders have executable MIME types with nosniff', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'page-together-static-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'worker.mjs'), 'self.onmessage = () => {};');
  await writeFile(join(directory, 'decoder.wasm'), Uint8Array.of(0, 97, 115, 109));
  const f = await fixture({ staticDirectory: directory }); t.after(f.close);
  for (const [path, mime] of [['worker.mjs', 'text/javascript'], ['decoder.wasm', 'application/wasm']]) {
    const response = await fetch(`${f.origin}/${path}`);
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type')?.startsWith(mime));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert((await response.arrayBuffer()).byteLength > 0);
  }
});

test('native document deep links serve the application while document data remains authenticated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'page-together-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>pageTogether</title>');
  const f = await fixture({ staticDirectory: directory }); t.after(f.close);
  assert.equal((await fetch(f.origin + '/workspace/main/native-doc')).status, 200);
  assert.equal(await (await fetch(f.origin + '/workspace/main/native-doc')).text(), '<!doctype html><title>pageTogether</title>');
  assert.equal((await fetch(f.origin + '/workspace/other/native-doc')).status, 404);
  assert.equal((await fetch(f.origin + '/api/documents')).status, 401);
});

test('single-use invitation, expiry, owner protection and current roles', async t => {
  let now = Date.now();
  const f = await fixture({ now: () => now }); t.after(f.close);
  const editor = await f.member('edit'), viewer = await f.member('view');
  const reused = await f.request('/api/auth/invite', '', 'POST', { token: editor.invitation.token, nickname: 'again' });
  assert.equal(reused.status, 401);
  const invite = await (await f.request('/api/invitations', f.owner, 'POST', { role: 'view' })).json() as { token: string };
  now += 8 * 86_400_000;
  assert.equal((await f.request('/api/auth/invite', '', 'POST', { token: invite.token, nickname: 'late' })).status, 401);
  assert.equal((await f.request('/api/documents', viewer.cookie, 'POST', { id: 'forbidden', title: 'x' })).status, 403);
  assert.equal((await f.request('/api/documents', editor.cookie, 'POST', { id: 'doc', title: 'x' })).status, 201);
  assert.equal((await f.request('/api/documents/doc/trash', editor.cookie, 'POST')).status, 403);
  const ownerId = (await (await f.request('/api/session', f.owner)).json() as { member: { id: string } }).member.id;
  assert.equal((await f.request('/api/members/' + ownerId, f.owner, 'PATCH', { role: 'view', active: false })).status, 403);
  assert.equal((await f.request('/api/invitations', f.owner, 'POST', { role: 'manage' })).status, 400);
  assert.equal((await f.request('/api/documents', '', 'GET')).status, 401);
  assert.equal((await f.request('/api/documents', f.owner, 'POST', { id: 'csrf', title: 'x' }, 'https://foreign.example')).status, 403);
  const foreign = new Peer(f.origin, f.owner, 'https://foreign.example');
  const [request, response] = await once(foreign.ws, 'unexpected-response');
  assert.equal(response.statusCode, 403); response.resume(); request.destroy(); foreign.close();
  now += 31 * 86_400_000;
  assert.equal((await f.request('/api/session', f.owner)).status, 401);
});

test('WebSocket incremental merge, durable receipt, retries and viewer rejection', async t => {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit'), viewer = await f.member('view');
  await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: '协作' });
  const a = new Peer(f.origin, f.owner), b = new Peer(f.origin, editor.cookie), readOnly = new Peer(f.origin, viewer.cookie);
  t.after(() => { a.close(); b.close(); readOnly.close(); });
  await Promise.all([a.next('ready'), b.next('ready'), readOnly.next('ready')]);
  const scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  const first = await open(a, scope), second = await open(b, scope); await open(readOnly, scope);
  first.getText('content').insert(0, '离线甲');
  second.getText('content').insert(0, '在线乙');
  const update = Y.encodeStateAsUpdate(first);
  a.send({ v: 1, type: 'push', requestId: 'save-a', ...scope, update: encoded(update) });
  const receipt = await a.next('saved', 'save-a');
  assert.equal(receipt.updateHash, hash(update)); assert.equal(receipt.revision, 1);
  const peerUpdate = await b.next('update');
  Y.applyUpdate(second, Buffer.from(peerUpdate.update, 'base64'));
  b.send({ v: 1, type: 'push', requestId: 'save-b', ...scope, update: encoded(Y.encodeStateAsUpdate(second)) });
  await b.next('saved', 'save-b');
  Y.applyUpdate(first, Buffer.from((await a.next('update')).update, 'base64'));
  assert.equal(first.getText('content').toString(), second.getText('content').toString());
  assert(first.getText('content').toString().includes('离线甲')); assert(first.getText('content').toString().includes('在线乙'));
  a.send({ v: 1, type: 'push', requestId: 'retry', ...scope, update: encoded(update) });
  assert.equal((await a.next('saved', 'retry')).revision, 2);
  readOnly.send({ v: 1, type: 'push', requestId: 'attack', ...scope, update: encoded(update) });
  assert.equal((await readOnly.next('error', 'attack')).code, 'read_only');
  const fresh = new Y.Doc();
  const durable = f.store.pull(hash(f.owner.split('=')[1]), scope, Y.encodeStateVector(fresh));
  Y.applyUpdate(fresh, durable.update); assert.equal(fresh.getText('content').toString(), first.getText('content').toString());
});

test('failed SQL commit sends no receipt, broadcasts no dirty state and permits retry', async t => {
  const f = await fixture(); t.after(f.close);
  await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: '保存失败' });
  const peer = new Peer(f.origin, f.owner); t.after(() => peer.close()); await peer.next('ready');
  const observer = new Peer(f.origin, f.owner); t.after(() => observer.close()); await observer.next('ready');
  const scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  await open(observer, scope);
  const doc = await open(peer, scope); doc.getText('content').insert(0, '不能假报保存');
  f.store.db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON updates BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
  const message = { v: 1, type: 'push', requestId: 'same-retry', ...scope, update: encoded(Y.encodeStateAsUpdate(doc)) };
  peer.send(message); await peer.next('error', 'same-retry');
  await open(observer, scope);
  assert.equal(peer.count('saved'), 0); assert.equal(observer.count('update'), 0);
  const clean = new Y.Doc(); Y.applyUpdate(clean, f.store.pull(hash(f.owner.split('=')[1]), scope, Y.encodeStateVector(clean)).update);
  assert.equal(clean.getText('content').toString(), '');
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM updates').get() as { n: number }).n, 0);
  f.store.db.exec('DROP TRIGGER fail_write');
  peer.send(message); assert.equal((await peer.next('saved', 'same-retry')).revision, 1);
  peer.send({ ...message, requestId: 'malformed', update: encoded(new Uint8Array([255])) });
  assert.equal((await peer.next('error', 'malformed')).code, 'invalid_update');
});

test('document deletion, restore generation and revoked live connections', async t => {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit');
  await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: '生命周期' });
  const peer = new Peer(f.origin, editor.cookie); await peer.next('ready');
  const scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  await open(peer, scope);
  const closed = once(peer.ws, 'close');
  assert.equal((await f.request('/api/documents/doc/trash', f.owner, 'POST')).status, 200);
  await closed;
  assert.throws(() => f.store.push(hash(editor.cookie.split('=')[1]), scope, new Uint8Array([0, 0])), /document_deleted/);
  assert.equal((await f.request('/api/documents/doc/restore', editor.cookie, 'POST')).status, 403);
  await f.request('/api/documents/doc/restore', f.owner, 'POST');
  assert.throws(() => f.store.push(hash(editor.cookie.split('=')[1]), scope, new Uint8Array([0, 0])), /document_generation_changed/);
  const revoked = new Peer(f.origin, editor.cookie); await revoked.next('ready');
  const revokedClosed = once(revoked.ws, 'close');
  await f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role: 'edit', active: false });
  await revokedClosed;
  assert.equal((await f.request('/api/documents', editor.cookie)).status, 401);
});

test('attachment content addressing, limits, access checks and recoverable backup', async t => {
  const f = await fixture({ maxBlobBytes: 64 }); t.after(f.close);
  const headers = await attachmentHeaders(f);
  const viewer = await f.member('view');
  const bytes = Buffer.from('私有测试附件'), key = createHash('sha256').update(bytes).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  async function upload(cookie: string, payload: Buffer, blobKey = key) {
    return fetch(f.origin + '/api/blobs/' + encodeURIComponent(blobKey), { method: 'PUT', headers: { ...headers, Cookie: cookie, Origin: f.origin }, body: payload });
  }
  assert.equal((await upload(viewer.cookie, bytes)).status, 403);
  assert.equal((await upload(f.owner, Buffer.alloc(65))).status, 413);
  assert.equal((await upload(f.owner, Buffer.from('wrong'))).status, 400);
  assert.equal((await upload(f.owner, bytes)).status, 200);
  assert.equal((await f.request('/api/blobs/' + encodeURIComponent(key))).status, 401);
  const downloaded = await f.request('/api/blobs/' + encodeURIComponent(key), viewer.cookie);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const parent = await mkdtemp(join(tmpdir(), 'page-together-backup-test-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const backupPath = join(parent, 'snapshot'), restoredPath = join(parent, 'restored');
  await backup(f.store, backupPath);
  const result = await restore(backupPath, restoredPath);
  const restored = new Store(restoredPath); t.after(() => restored.close());
  assert.notEqual(restored.epoch, f.store.epoch); assert.equal(restored.paused, true);
  assert.throws(() => restored.authenticate(hash(f.owner.split('=')[1])), /session_expired/);
  assert.throws(() => restored.recoverOwner(f.recovery), /invalid_recovery/);
  const newOwner = restored.recoverOwner(result.recoveryCode);
  assert.throws(() => restored.authenticate(hash(newOwner.session)), /space_paused/);
  assert.equal(restored.authenticate(hash(newOwner.session), true).owner, true);
  assert.equal(restored.getMember(viewer.member.id).active, false);
  restored.resume(hash(newOwner.session));
  assert.deepEqual(await readFile(join(restoredPath, 'blobs', key)), bytes);
  assert.equal(restored.blob(hash(newOwner.session), key)?.hash, hash(bytes));
  await assert.rejects(() => restore(backupPath, restoredPath), /EEXIST/);
});

test('owner recovery rotates code and terminates previous owner sessions', async t => {
  const f = await fixture(); t.after(f.close);
  const peer = new Peer(f.origin, f.owner); await peer.next('ready');
  const closed = once(peer.ws, 'close');
  const result = await f.request('/api/auth/recover', '', 'POST', { code: f.recovery });
  assert.equal(result.status, 200); await closed;
  assert.equal((await f.request('/api/session', f.owner)).status, 401);
  assert.equal((await f.request('/api/auth/recover', '', 'POST', { code: f.recovery })).status, 401);
  const rotated = await result.json() as { recoveryCode: string };
  assert.notEqual(rotated.recoveryCode, f.recovery);
});

test('role downgrade closes existing access and an expired live session is stopped', async t => {
  let now = Date.now();
  const f = await fixture({ now: () => now, heartbeatMs: 20 }); t.after(f.close);
  const editor = await f.member('edit');
  const peer = new Peer(f.origin, editor.cookie); await peer.next('ready');
  const closed = once(peer.ws, 'close');
  assert.equal((await f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role: 'view', active: true })).status, 200);
  await closed;
  assert.equal((await f.request('/api/documents', editor.cookie)).status, 200);
  assert.equal((await f.request('/api/documents', editor.cookie, 'POST', { id: 'no-write', title: 'x' })).status, 403);
  const viewer = new Peer(f.origin, editor.cookie); await viewer.next('ready');
  const expired = once(viewer.ws, 'close'); now += 31 * 86_400_000;
  await expired;
  assert.equal((await f.request('/api/session', editor.cookie)).status, 401);
});

test('authorization revision records transient role changes and revocation across identity recovery', async t => {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit');
  const change = (role: string, active: boolean) => f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role, active });
  const session = async (cookie = editor.cookie) => (await (await f.request('/api/session', cookie)).json() as { member: { accessRevision: number } }).member;
  assert.equal((await session()).accessRevision, 0);
  await change('view', true); await change('edit', true);
  assert.equal((await session()).accessRevision, 2);
  await change('edit', true); assert.equal((await session()).accessRevision, 2);
  await change('edit', false); await change('edit', true);
  assert.equal((await f.request('/api/session', editor.cookie)).status, 401);
  const invitation = await (await f.request('/api/invitations', f.owner, 'POST', { role: 'edit', memberId: editor.member.id, recovery: true })).json() as { token: string };
  const response = await f.request('/api/auth/invite', '', 'POST', { token: invitation.token, nickname: '不能新建身份' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const recovered = await response.json() as { member: { id: string; accessRevision: number } };
  assert.equal(recovered.member.id, editor.member.id); assert.equal(recovered.member.accessRevision, 4);
  assert.equal((await session(cookie)).accessRevision, 4);
});

test('restoring a backup taken before revocation never revives old sessions, invitations or the old epoch', async t => {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit');
  await f.request('/api/documents', f.owner, 'POST', { id: 'old-backup', title: '旧备份' });
  const invitation = await (await f.request('/api/invitations', f.owner, 'POST', { role: 'edit' })).json() as { token: string };
  const scope = { epoch: f.store.epoch, generation: 1, docId: 'old-backup' };
  const doc = new Y.Doc(); t.after(() => doc.destroy()); doc.getText('body').insert(0, '备份正文');
  f.store.push(hash(f.owner.split('=')[1]), scope, Y.encodeStateAsUpdate(doc));
  const parent = await mkdtemp(join(tmpdir(), 'page-together-older-backup-')); t.after(() => rm(parent, { recursive: true, force: true }));
  await backup(f.store, join(parent, 'backup'));
  await f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role: 'edit', active: false });
  const result = await restore(join(parent, 'backup'), join(parent, 'restored'));
  const restored = new Store(join(parent, 'restored')); t.after(() => restored.close());
  assert.equal(restored.getMember(editor.member.id).active, false);
  assert.throws(() => restored.authenticate(hash(editor.cookie.split('=')[1])), /session_expired/);
  assert.throws(() => restored.recoverOwner(f.recovery), /invalid_recovery/);
  const owner = restored.recoverOwner(result.recoveryCode), ownerHash = hash(owner.session);
  assert.throws(() => restored.listDocuments(ownerHash), /space_paused/);
  restored.resume(ownerHash);
  assert.throws(() => restored.redeemInvite(invitation.token, '旧邀请'), /invalid_invitation/);
  restored.changeMember(ownerHash, editor.member.id, 'edit', true);
  assert.throws(() => restored.authenticate(hash(editor.cookie.split('=')[1])), /session_expired/);
  assert.throws(() => restored.push(ownerHash, scope, Y.encodeStateAsUpdate(doc)), /space_epoch_changed/);
  const fresh = new Y.Doc(); t.after(() => fresh.destroy());
  Y.applyUpdate(fresh, restored.pull(ownerHash, { ...scope, epoch: restored.epoch }, Y.encodeStateVector(fresh)).update);
  assert.equal(fresh.getText('body').toString(), '备份正文');
});

test('snapshot compaction preserves Yjs data and rejected large updates leave it unchanged', async t => {
  const f = await fixture({ maxDocumentBytes: 4096 }); t.after(f.close);
  await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: '快照' });
  const session = hash(f.owner.split('=')[1]), scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  const doc = new Y.Doc(); t.after(() => doc.destroy());
  for (let i = 0; i < 40; i++) {
    const vector = Y.encodeStateVector(doc); doc.getText('content').insert(doc.getText('content').length, '中');
    assert.equal(f.store.push(session, scope, Y.encodeStateAsUpdate(doc, vector)).revision, i + 1);
  }
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM updates').get() as { n: number }).n, 8);
  const fresh = new Y.Doc(); t.after(() => fresh.destroy());
  Y.applyUpdate(fresh, f.store.pull(session, scope, Y.encodeStateVector(fresh)).update);
  assert.equal(fresh.getText('content').toString(), '中'.repeat(40));
  fresh.getText('content').insert(0, 'x'.repeat(5000));
  assert.throws(() => f.store.push(session, scope, Y.encodeStateAsUpdate(fresh)), /update_too_large/);
  const final = new Y.Doc(); t.after(() => final.destroy());
  Y.applyUpdate(final, f.store.pull(session, scope, Y.encodeStateVector(final)).update);
  assert.equal(final.getText('content').toString(), '中'.repeat(40));
});

test('quota rejection cleans unpublished attachments and releases the upload slot', async t => {
  const f = await fixture({ maxBlobBytes: 64, blobQuotaBytes: 4 }); t.after(f.close);
  const headers = await attachmentHeaders(f);
  async function put(bytes: Buffer) {
    const key = createHash('sha256').update(bytes).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
    return fetch(f.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { ...headers, Cookie: f.owner, Origin: f.origin }, body: bytes });
  }
  assert.equal((await put(Buffer.from('too big'))).status, 413);
  assert.deepEqual(await readdir(join(f.directory, 'blobs')), []);
  assert.equal((await put(Buffer.from('fits'))).status, 200);
  assert.equal((await readdir(join(f.directory, 'blobs'))).length, 1);
});

test('default attachment limit accepts 50 MB and rejects 50 MB plus one byte', async t => {
  const f = await fixture(); t.after(f.close);
  const headers = await attachmentHeaders(f);
  const bytes = Buffer.alloc(50_000_000, 7);
  const key = createHash('sha256').update(bytes).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  async function put(body: Buffer) {
    return fetch(f.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { ...headers, Cookie: f.owner, Origin: f.origin }, body });
  }
  const accepted = await put(bytes); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { size: number }).size, 50_000_000);
  assert.equal((await put(Buffer.alloc(50_000_001))).status, 413);
  assert.equal((await readdir(join(f.directory, 'blobs'))).length, 1);
});

test('streamed uploads recheck permission history and document lifecycle after receiving bytes', async t => {
  for (const transition of ['permission', 'deleted', 'restored'] as const) await t.test(transition, async t => {
    const f = await fixture(); t.after(f.close); const editor = await f.member('edit');
    const headers = await attachmentHeaders(f, editor.cookie), bytes = Buffer.from('上传期间状态变化的完整附件');
    const key = createHash('sha256').update(bytes).digest('base64url') + '=';
    const request = httpRequest(f.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { ...headers, Cookie: editor.cookie, Origin: f.origin, 'Content-Length': bytes.length } });
    const result = new Promise<{ status: number; code: string }>((resolve, reject) => {
      request.on('error', reject); request.on('response', response => {
        let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
        response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode!, code: JSON.parse(data).code }));
      });
    });
    request.write(bytes.subarray(0, 6));
    // Observe a real partial upload on disk before changing server state.
    const deadline = Date.now() + 4000; let received = false;
    while (!received && Date.now() < deadline) {
      const files = await readdir(join(f.directory, 'blobs'));
      received = (await Promise.all(files.map(file => stat(join(f.directory, 'blobs', file))))).some(file => file.size === 6);
      if (!received) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(received);
    if (transition === 'permission') {
      await f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role: 'view', active: true });
      await f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role: 'edit', active: true });
    } else {
      await f.request('/api/documents/attachments/trash', f.owner, 'POST');
      if (transition === 'restored') await f.request('/api/documents/attachments/restore', f.owner, 'POST');
    }
    request.end(bytes.subarray(6)); const rejected = await result;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, transition === 'permission' ? 'access_changed' : transition === 'deleted' ? 'document_deleted' : 'document_generation_changed');
    assert.deepEqual(f.store.listBlobs(hash(f.owner.split('=')[1])), []);
    assert.deepEqual(await readdir(join(f.directory, 'blobs')), []);
  });
});

test('attachment HTTP writes require the exact current member and scope and downloads reject old epochs', async t => {
  const f = await fixture(); t.after(f.close); const headers = await attachmentHeaders(f), bytes = Buffer.from('header validation');
  const key = createHash('sha256').update(bytes).digest('base64url') + '=', session = (await (await f.request('/api/session', f.owner)).json() as { member: { id: string; accessRevision: number } }).member;
  const context = { memberId: session.id, accessRevision: session.accessRevision, docId: 'attachments', epoch: f.store.epoch, generation: 1 };
  const put = (extra: Record<string, string>) => fetch(f.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { Cookie: f.owner, Origin: f.origin, ...extra }, body: bytes });
  assert.equal((await put({})).status, 400);
  for (const changed of [{ memberId: 'wrong' }, { accessRevision: 1 }, { epoch: 'old' }, { generation: 2 }]) assert.equal((await put(blobWriteHeaders({ ...context, ...changed }))).status, 409);
  assert.equal((await put(headers)).status, 200);
  assert.equal((await fetch(f.origin + '/api/blobs/' + encodeURIComponent(key), { headers: { Cookie: f.owner, 'X-PageTogether-Epoch': 'old' } })).status, 409);
});

test('revocation interrupts an existing attachment download stream', async t => {
  const f = await fixture(); t.after(f.close); const headers = await attachmentHeaders(f), bytes = Buffer.alloc(16_000_000, 9);
  const key = createHash('sha256').update(bytes).digest('base64url') + '=';
  assert.equal((await fetch(f.origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', headers: { ...headers, Cookie: f.owner, Origin: f.origin }, body: bytes })).status, 200);
  const viewer = await f.member('view');
  const request = httpRequest(f.origin + '/api/blobs/' + encodeURIComponent(key), { headers: { Cookie: viewer.cookie } });
  const responsePromise = once(request, 'response'); request.end();
  const [response] = await responsePromise; assert.equal(response.statusCode, 200); response.pause();
  let received = 0; response.on('data', (chunk: Buffer) => { received += chunk.length; });
  const closed = new Promise<void>(resolve => { response.on('error', () => {}); response.on('close', resolve); });
  await f.request('/api/members/' + viewer.member.id, f.owner, 'PATCH', { role: 'view', active: false });
  response.resume(); await closed;
  assert(received < bytes.length); assert.equal(response.complete, false);
  assert.equal((await fetch(f.origin + '/api/blobs/' + encodeURIComponent(key), { headers: { Cookie: viewer.cookie } })).status, 401);
});
