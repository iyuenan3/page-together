import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { LocalPersistence } from '../src/app/local.js';
import { DocumentSync } from '../src/app/sync.js';
import { hash } from '../server/store.js';
import { fixture } from './helpers.js';

async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('State did not converge'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function client(t: test.TestContext) {
  const f = await fixture(); t.after(f.close);
  await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: 'failure' });
  const member = (await (await f.request('/api/session', f.owner)).json() as { member: { id: string } }).member;
  const local = new LocalPersistence(member.id), doc = new Y.Doc(), scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  let pushes = 0;
  class AuthorizedSocket extends WebSocket {
    constructor(url: string) { super(url, { headers: { Cookie: f.owner, Origin: f.origin } }); }
    override send(data: string, options?: any, callback?: any) {
      if (typeof data === 'string' && JSON.parse(data).type === 'push') pushes++;
      super.send(data, options, callback);
    }
  }
  globalThis.WebSocket = AuthorizedSocket as unknown as typeof globalThis.WebSocket;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: f.origin } });
  globalThis.fetch = (input, options) => typeof input === 'string' && input.startsWith('/api/') ? originalFetch(f.origin + input, { ...options, headers: { ...options?.headers, Cookie: f.owner, Origin: f.origin } }) : originalFetch(input, options);
  const sync = new DocumentSync(doc, scope, local, 0);
  t.after(async () => {
    sync.stop(); doc.destroy(); await local.close(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else Reflect.deleteProperty(globalThis, 'location');
  });
  await sync.start(); await until(() => sync.state === 'cloud');
  const cloud = () => { const remote = new Y.Doc(); Y.applyUpdate(remote, f.store.pull(hash(f.owner.split('=')[1]), scope, Y.encodeStateVector(remote)).update); const text = remote.getText('body').toString(); remote.destroy(); return text; };
  return { local, doc, scope, sync, cloud, pushes: () => pushes };
}

test('an actual IndexedDB transaction abort keeps complete memory, latches failure and retries the full document', async t => {
  const c = await client(t);
  const original = IDBObjectStore.prototype.put; let failures = 0;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args);
    if (this.name === 'documents' && failures++ === 0) this.transaction.abort();
    return request;
  };
  t.after(() => { IDBObjectStore.prototype.put = original; });
  c.doc.getText('body').insert(0, '保存失败但内存保留'); await c.sync.settled();
  assert(failures > 0); assert.equal(c.sync.state, 'storage-error'); assert(c.sync.hasStorageFailure);
  assert.equal(c.cloud(), ''); assert.equal(c.pushes(), 0);
  assert.equal((await c.local.pending(c.scope)).length, 0);
  IDBObjectStore.prototype.put = original;
  c.doc.getText('body').insert(c.doc.getText('body').length, '，随后继续编辑'); await c.sync.settled();
  assert.equal(c.sync.state, 'storage-error'); assert.equal(c.cloud(), ''); assert.equal(c.pushes(), 0);
  const exported = new Y.Doc(); Y.applyUpdate(exported, Y.encodeStateAsUpdate(c.doc));
  assert.equal(exported.getText('body').toString(), '保存失败但内存保留，随后继续编辑'); exported.destroy();
  await c.sync.retryLocalSave(); await until(() => c.sync.state === 'cloud');
  assert.equal(c.cloud(), '保存失败但内存保留，随后继续编辑'); assert.equal(c.sync.hasStorageFailure, false);
  assert.equal((await c.local.pending(c.scope)).length, 0);
  await c.local.close(); const reopened = new LocalPersistence(c.local.memberId); t.after(() => reopened.close());
  const durable = new Y.Doc(); Y.applyUpdate(durable, (await reopened.load(c.scope))!);
  assert.equal(durable.getText('body').toString(), c.cloud()); durable.destroy();
});

test('failed local receipt cleanup never reports cloud saved and retries safely after later edits', async t => {
  const c = await client(t), original = IDBDatabase.prototype.transaction; let failures = 0;
  IDBDatabase.prototype.transaction = function(...args: Parameters<IDBDatabase['transaction']>) {
    if (args[0] === 'updates' && args[1] === 'readwrite' && failures++ === 0) throw new DOMException('Controlled quota failure', 'QuotaExceededError');
    return original.apply(this, args);
  };
  t.after(() => { IDBDatabase.prototype.transaction = original; });
  c.doc.getText('body').insert(0, '服务器已收但本机确认失败'); await until(() => c.sync.state === 'storage-error');
  assert(failures > 0); assert.equal(c.cloud(), '服务器已收但本机确认失败'); assert.equal((await c.local.pending(c.scope)).length, 1);
  IDBDatabase.prototype.transaction = original;
  c.doc.getText('body').insert(c.doc.getText('body').length, '，重试前新增'); await c.sync.settled();
  assert.equal(c.sync.state, 'storage-error'); assert.equal(c.pushes(), 1);
  await c.sync.retryLocalSave(); await until(() => c.sync.state === 'cloud');
  assert.equal(c.cloud(), '服务器已收但本机确认失败，重试前新增'); assert.equal((await c.local.pending(c.scope)).length, 0);
});

test('pausing after a failed local write preserves the failure warning and the access guard', async t => {
  const c = await client(t), original = IDBObjectStore.prototype.put; let failures = 0;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args);
    if (this.name === 'documents' && failures++ === 0) this.transaction.abort();
    return request;
  };
  t.after(() => { IDBObjectStore.prototype.put = original; });
  c.doc.getText('body').insert(0, '尚未落盘的完整稿'); await c.sync.settled();
  assert(failures > 0); assert.equal(c.sync.state, 'storage-error');
  IDBObjectStore.prototype.put = original;
  await c.sync.pause('权限记录已变化');
  assert(c.sync.isBlocked); assert(c.sync.hasStorageFailure); assert.equal(c.sync.state, 'storage-error');
  assert.equal(await c.local.checkAccess(c.scope, 1), '权限记录已变化');
  assert.equal(c.doc.getText('body').toString(), '尚未落盘的完整稿'); assert.equal(c.cloud(), '');
});

test('attachment gating retains document references locally until the blob receipt is durable', async t => {
  const c = await client(t); let saved = false, checks = 0;
  c.sync.beforePush = async () => { checks++; return saved; };
  c.doc.getText('body').insert(0, '包含待上传附件的正文'); await c.sync.settled();
  await until(() => checks > 0 && c.sync.state === 'local');
  assert(checks > 0); assert.equal(c.cloud(), ''); assert.equal(c.pushes(), 0); assert((await c.local.pending(c.scope)).length > 0);
  saved = true; await c.sync.retryLocalSave(); await until(() => c.sync.state === 'cloud');
  assert.equal(c.cloud(), '包含待上传附件的正文'); assert.equal((await c.local.pending(c.scope)).length, 0);
});
