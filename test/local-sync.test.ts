import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteDB, openDB } from 'idb';
import * as Y from 'yjs';
import { LocalPersistence, scopeKey } from '../src/app/local.js';
import { DocumentSync } from '../src/app/sync.js';
import { fixture } from './helpers.js';

const scope = { epoch: 'original', generation: 1, docId: 'document' };
async function localFixture(t: test.TestContext) {
  const id = randomUUID(), local = new LocalPersistence(id);
  t.after(() => local.close());
  return local;
}
function update(text: string) {
  const doc = new Y.Doc(); doc.getText('body').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc); doc.destroy(); return bytes;
}
function body(bytes: Uint8Array) {
  const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
  const result = doc.getText('body').toString(); doc.destroy(); return result;
}

test('permission history blocks pending updates even when editing has been restored', async t => {
  const local = await localFixture(t);
  assert.equal(await local.checkAccess(scope, 0), undefined);
  await local.persist(scope, update('撤权期间的离线稿'), true);
  assert.match((await local.checkAccess(scope, 2))!, /暂停上传/);
  assert.match((await local.checkAccess(scope, 2))!, /暂停上传/);
  assert.equal((await local.pending(scope)).length, 1);
  assert.equal(body((await local.load(scope))!), '撤权期间的离线稿');
});

test('session pause survives closing the database and recreating the actual synchronizer', async t => {
  const local = await localFixture(t);
  await local.checkAccess(scope, 0);
  await local.persist(scope, update('会话过期的离线稿'), true);
  await local.blockPending('会话已失效');
  await local.close();
  const reopened = new LocalPersistence(local.memberId);
  const doc = new Y.Doc(), sync = new DocumentSync(doc, scope, reopened, 0);
  t.after(async () => { sync.stop(); doc.destroy(); await reopened.close(); });
  await sync.start();
  assert.equal(sync.state, 'blocked');
  assert.equal(doc.getText('body').toString(), '会话过期的离线稿');
  await sync.retryLocalSave();
  assert.equal(sync.state, 'blocked'); assert.equal((await reopened.pending(scope)).length, 1);
});

test('an actual expired HTTP session persists the pause after recovering the same member identity', async t => {
  let now = Date.now();
  const f = await fixture({ now: () => now }); t.after(f.close);
  const member = await f.member('edit'), local = new LocalPersistence(member.member.id);
  t.after(() => local.close());
  const documentScope = { ...scope, epoch: f.store.epoch };
  await local.checkAccess(documentScope, 0);
  await local.persist(documentScope, update('真实会话过期离线稿'), true);
  const originalFetch = globalThis.fetch;
  let cookie = member.cookie, sessionRequests = 0;
  globalThis.fetch = (input, options) => {
    if (typeof input !== 'string' || !input.startsWith('/api/')) return originalFetch(input, options);
    sessionRequests++;
    return originalFetch(f.origin + input, { ...options, headers: { ...options?.headers, Origin: f.origin, Cookie: cookie } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  now += 31 * 86_400_000;
  const doc = new Y.Doc(), sync = new DocumentSync(doc, documentScope, local, 0);
  t.after(() => { sync.stop(); doc.destroy(); });
  const blocked = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Expired HTTP session did not block')), 4000);
    sync.onState = state => { if (state === 'blocked') { clearTimeout(timeout); resolve(); } };
  });
  await sync.start(); await blocked;
  // Wait for the durable guard, not merely its visible state notification.
  await sync.pause('会话已过期，等待原身份恢复');
  assert.equal(sessionRequests, 1);
  const recoveredOwner = await f.request('/api/auth/recover', '', 'POST', { code: f.recovery });
  assert.equal(recoveredOwner.status, 200);
  const owner = recoveredOwner.headers.get('set-cookie')!.split(';')[0];
  const invite = await (await f.request('/api/invitations', owner, 'POST', { role: 'edit', memberId: member.member.id, recovery: true })).json() as { token: string };
  const response = await f.request('/api/auth/invite', '', 'POST', { token: invite.token, nickname: '原成员' });
  assert.equal(response.status, 200); cookie = response.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await response.json() as { member: { id: string } }).member.id, member.member.id);
  const freshDoc = new Y.Doc(), restarted = new DocumentSync(freshDoc, documentScope, local, 0);
  t.after(() => { restarted.stop(); freshDoc.destroy(); });
  await restarted.start();
  assert.equal(restarted.state, 'blocked'); assert.equal(sessionRequests, 1);
  assert.equal(freshDoc.getText('body').toString(), '真实会话过期离线稿');
  assert.equal((await local.pending(documentScope)).length, 1);
});

test('explicit cloud reload archives the full draft and never queues it for upload again', async t => {
  const local = await localFixture(t);
  await local.checkAccess(scope, 0);
  await local.persist(scope, update('必须保留的离线稿'), true);
  await local.block(scope, '已撤权');
  await local.isolate(scope);
  assert.equal((await local.pending(scope)).length, 0);
  assert.equal(await local.load(scope), undefined);
  const drafts = await local.drafts();
  assert.equal(drafts.length, 1); assert.equal(body(drafts[0].data), '必须保留的离线稿');
  assert.equal(drafts[0].reason, '已撤权');
  assert.equal(await local.checkAccess(scope, 2), undefined);
  await local.persist(scope, update('新的云端正文'), false);
  assert.equal((await local.pending(scope)).length, 0);
  assert.equal(body((await local.drafts())[0].data), '必须保留的离线稿');
});

test('a new backup epoch keeps original pending documents and all old attachments exportable', async t => {
  const local = await localFixture(t), restored = { ...scope, epoch: 'restored' };
  await local.checkAccess(scope, 0);
  await local.persist(scope, update('备份之后的离线稿'), true);
  await local.setBlob(scope.epoch, 'attachment', new Blob(['旧代际附件']), false, 0);
  await local.checkAccess(restored, 0);
  assert.equal(await local.load(restored), undefined);
  assert.equal((await local.pending(restored)).length, 0);
  await local.persist(restored, update('备份里的正文'), false);
  assert.equal((await local.documents()).length, 2);
  assert.equal(body((await local.load(scope))!), '备份之后的离线稿');
  assert.equal((await local.pending(scope)).length, 1);
  assert.equal((await local.blobs(restored.epoch)).length, 0);
  assert.equal(await (await local.blobs())[0].data.text(), '旧代际附件');
});

test('expired identity blocks attachments as well as every pending document', async t => {
  const local = await localFixture(t), second = { ...scope, docId: 'second' };
  for (const doc of [scope, second]) { await local.checkAccess(doc, 0); await local.persist(doc, update(doc.docId), true); }
  await local.setBlob(scope.epoch, 'attachment', new Blob(['pending']), false, 0);
  await local.blockPending('身份失效');
  for (const doc of [scope, second]) assert.equal(await local.checkAccess(doc, 0), '身份失效');
  await local.setBlob(scope.epoch, 'attachment', new Blob(['pending']), false, 0);
  assert.equal((await local.blobs(scope.epoch, true))[0].blockedReason, '身份失效');
});

test('version-one IndexedDB migration preserves content and fails closed for unverified pending updates', async t => {
  const id = randomUUID(), name = 'page-together-v1-' + id;
  const db = await openDB(name, 1, { upgrade(db) {
    db.createObjectStore('documents');
    db.createObjectStore('updates', { keyPath: 'id' }).createIndex('scope', 'scope');
    db.createObjectStore('drafts', { keyPath: 'id' }); db.createObjectStore('blobs', { keyPath: 'key' });
  } });
  const bytes = update('升级前的离线稿');
  await db.put('documents', bytes, scopeKey(scope));
  await db.put('updates', { id: randomUUID(), scope: scopeKey(scope), update: bytes }); db.close();
  const local = new LocalPersistence(id);
  t.after(async () => { await local.close(); await deleteDB(name); });
  assert.match((await local.checkAccess(scope, 0))!, /尚未核验/);
  assert.equal(body((await local.load(scope))!), '升级前的离线稿');
  assert.equal((await local.pending(scope)).length, 1);
});

test('ordinary reconnect leaves verified pending updates eligible for automatic merge', async t => {
  const local = await localFixture(t);
  await local.checkAccess(scope, 0); await local.persist(scope, update('正常离线稿'), true);
  await local.close();
  const reopened = new LocalPersistence(local.memberId);
  t.after(() => reopened.close());
  assert.equal(await reopened.checkAccess(scope, 0), undefined);
  assert.equal((await reopened.pending(scope)).length, 1);
});
