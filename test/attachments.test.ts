import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteDB, openDB } from 'idb';
import { OfflineBlobSource, attachmentKey } from '../src/app/blobs.js';
import { LocalPersistence } from '../src/app/local.js';
import type { Member } from '../shared/protocol.js';
import { hash } from '../server/store.js';
import { fixture } from './helpers.js';

async function client(t: test.TestContext) {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit');
  const { member } = await (await f.request('/api/session', editor.cookie)).json() as { member: Member };
  await f.request('/api/documents', f.owner, 'POST', { id: 'attachments', title: 'attachments' });
  const scope = { docId: 'attachments', epoch: f.store.epoch, generation: 1 };
  const local = new LocalPersistence(member.id); await local.checkAccess(scope, member.accessRevision);
  const references = new Set<string>(), errors: unknown[] = [];
  let uploaded = 0, reads = 0, puts = 0, offline = false;
  let beforePut = async () => {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    if (typeof input !== 'string' || !input.startsWith('/api/')) return originalFetch(input, options);
    if (offline) throw new TypeError('Controlled network offline');
    if (options?.method === 'PUT') { puts++; await beforePut(); }
    if (input.startsWith('/api/blobs/') && options?.method !== 'PUT') reads++;
    return originalFetch(f.origin + input, { ...options, headers: { ...options?.headers, Cookie: editor.cookie, Origin: f.origin } });
  };
  const context = { member, epoch: scope.epoch, local,
    blobScope: (key: string) => references.has(key) ? scope : undefined,
    blobMetadata: () => ({}), updateAccess: (value: Member) => { context.member = value; },
    uploaded: () => { uploaded++; }, changed: () => {}, report: (error: unknown) => errors.push(error),
  };
  const source = new OfflineBlobSource(context);
  t.after(async () => { source.dispose(); await source.settled(); await local.close(); await deleteDB('page-together-v1-' + member.id); globalThis.fetch = originalFetch; });
  const file = (text: string, name = '附件.txt') => new File([text], name, { type: 'text/plain' });
  const queue = async (value: Blob) => { const key = await attachmentKey(value); await source.set(key, value); references.add(key); return key; };
  return { f, editor, local, scope, source, context, references, errors, file, queue,
    uploaded: () => uploaded, reads: () => reads, puts: () => puts,
    offline: (value: boolean) => { offline = value; }, beforePut: (action: () => Promise<void>) => { beforePut = action; },
  };
}

test('native blob source uploads with a scoped receipt, verifies downloads and reopens its offline cache', async t => {
  const c = await client(t), file = c.file('附件完整内容'), key = await c.queue(file);
  await c.source.flush();
  assert.equal(c.puts(), 1); assert.equal(c.uploaded(), 1); assert.equal((await c.local.blobs(c.scope.epoch, true)).length, 0);
  const viewer = await c.f.member('view'), originalFetch = globalThis.fetch;
  const local = new LocalPersistence(viewer.member.id); let reopened: LocalPersistence | undefined;
  const member = (await (await c.f.request('/api/session', viewer.cookie)).json() as { member: Member }).member;
  const context = { ...c.context, member, local, updateAccess: (value: Member) => { context.member = value; } };
  const view = new OfflineBlobSource(context);
  t.after(async () => { view.dispose(); await view.settled(); await local.close(); await reopened?.close(); await deleteDB('page-together-v1-' + viewer.member.id); });
  globalThis.fetch = (input, options) => typeof input === 'string' && input.startsWith('/api/') ? originalFetch(c.f.origin + input, { ...options, headers: { ...options?.headers, Cookie: viewer.cookie, Origin: c.f.origin } }) : originalFetch(input, options);
  const downloaded = await view.get(key); assert.equal(await downloaded!.text(), await file.text());
  assert.equal(await attachmentKey(downloaded!), key);
  assert.equal((await local.blobs())[0].saved, true);
  await assert.rejects(() => view.set(key, file), /read_only/);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal(await (await view.get(key))!.text(), await file.text());
  await local.close(); reopened = new LocalPersistence(viewer.member.id);
  assert.equal(await (await reopened.getBlob(c.scope.epoch, key))!.text(), await file.text());
  assert.equal(c.f.store.listBlobs(hash(c.f.owner.split('=')[1])).length, 1);
});

test('files queued during an in-flight upload drain before the same flush completes', async t => {
  const c = await client(t); let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  c.beforePut(async () => { started(); await gate; });
  await c.queue(c.file('第一个附件')); const first = c.source.flush(); await began;
  await c.queue(c.file('上传期间加入的第二个附件')); const second = c.source.flush(); release();
  await Promise.all([first, second]);
  assert.equal(c.puts(), 2); assert.equal(c.uploaded(), 2); assert.equal((await c.local.blobs(c.scope.epoch, true)).length, 0);
});

test('offline uploads retain their creating scope across a browser restart and then merge normally', async t => {
  const c = await client(t); c.offline(true); await c.queue(c.file('断网新增并关闭页面'));
  await c.source.flush(); assert.equal(c.puts(), 0);
  assert.deepEqual((await c.local.blobs(c.scope.epoch, true))[0].scope, c.scope);
  c.source.dispose(); await c.source.settled(); await c.local.close();
  const reopened = new LocalPersistence(c.context.member.id), source = new OfflineBlobSource({ ...c.context, local: reopened });
  try {
    c.offline(false); await source.flush();
    assert.equal(c.puts(), 1); assert.equal((await reopened.blobs(c.scope.epoch, true)).length, 0);
  } finally { source.dispose(); await source.settled(); await reopened.close(); }
});

test('permission history pauses old attachments until explicit resubmission preserves the original', async t => {
  const c = await client(t), key = await c.queue(c.file('撤权期间的原附件', '原附件.txt'));
  await c.f.request('/api/members/' + c.editor.member.id, c.f.owner, 'PATCH', { role: 'view', active: true });
  await c.f.request('/api/members/' + c.editor.member.id, c.f.owner, 'PATCH', { role: 'edit', active: true });
  await c.source.flush();
  const original = (await c.local.blobs(c.scope.epoch, true))[0];
  assert.match(original.blockedReason!, /权限记录已变化/); assert.equal(c.puts(), 0);
  await c.source.flush(); assert.equal(c.puts(), 0);
  await c.source.resubmit(original, c.scope);
  assert.equal(c.puts(), 1); assert.equal((await c.local.blobs(c.scope.epoch, true)).length, 0);
  const archive = (await c.local.blobDrafts())[0];
  assert.equal(archive.id, original.id); assert.equal(archive.accessRevision, 0); assert.equal(archive.blockedReason, original.blockedReason);
  assert.equal(await archive.data.text(), '撤权期间的原附件'); assert.equal(archive.name, '原附件.txt');
  assert.equal((await c.local.blobs(c.scope.epoch))[0].accessRevision, 2);
  assert.equal(await (await c.source.get(key))!.text(), '撤权期间的原附件');
});

test('restored-space attachments stay isolated and explicit resubmission targets only the current scope', async t => {
  const c = await client(t), file = c.file('恢复前附件'), key = await attachmentKey(file), old = { ...c.scope, epoch: 'old-space', generation: 4 };
  await c.local.setBlob(old.epoch, key, file, false, 0, { scope: old, name: file.name });
  await c.source.flush(); assert.equal(c.puts(), 0);
  const original = (await c.local.blobs(old.epoch))[0]; await c.source.resubmit(original, c.scope);
  assert.equal(c.puts(), 1); assert.equal((await c.local.blobs(old.epoch))[0].saved, false);
  assert.equal((await c.local.blobs(c.scope.epoch))[0].saved, true);
  assert.equal((await c.local.blobDrafts())[0].epoch, old.epoch);
});

test('an actual blob transaction abort retains the File in memory and retries without pretending it was attached', async t => {
  const c = await client(t), file = c.file('配额失败的原始文件', '未落盘.txt'), key = await attachmentKey(file);
  const original = IDBObjectStore.prototype.put; let failures = 0;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args); if (this.name === 'blobs' && failures++ === 0) this.transaction.abort(); return request;
  };
  t.after(() => { IDBObjectStore.prototype.put = original; });
  await assert.rejects(() => c.source.set(key, file)); assert(failures > 0); assert(c.source.hasStorageFailure);
  assert.equal(await c.source.memory.get(key)!.data.text(), await file.text()); assert.equal(c.puts(), 0);
  IDBObjectStore.prototype.put = original;
  await c.source.retryLocalSave(); assert.equal(c.source.hasStorageFailure, false); assert.equal(c.puts(), 0);
  assert.equal(c.source.blobState$(key).value.errorMessage, null); assert.equal(c.source.blobState$(key).value.needUpload, true);
  const retained = (await c.local.blobs(c.scope.epoch))[0]; assert.equal(retained.name, file.name);
  await c.source.resubmit(retained, c.scope); assert.equal(c.puts(), 1); assert.equal((await c.local.blobDrafts()).length, 1);
});

test('a failed local blob receipt remains pending and requires explicit local retry', async t => {
  const c = await client(t), key = await c.queue(c.file('已提交但本机确认失败'));
  const original = IDBObjectStore.prototype.put; let failures = 0;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const row = args[0] as { saved?: boolean }; const request = original.apply(this, args);
    if (this.name === 'blobs' && row.saved === true && failures++ === 0) this.transaction.abort(); return request;
  };
  t.after(() => { IDBObjectStore.prototype.put = original; });
  await c.source.flush(); assert(failures > 0); assert(c.source.hasStorageFailure);
  assert.equal((await c.local.blobs(c.scope.epoch, true)).length, 1);
  assert.equal(c.f.store.listBlobs(hash(c.f.owner.split('=')[1])).length, 1);
  IDBObjectStore.prototype.put = original;
  await c.source.flush(); assert.equal(c.puts(), 1);
  await c.source.retryLocalSave(); assert.equal(c.source.hasStorageFailure, false);
  assert.equal(c.puts(), 2); assert.equal((await c.local.blobs(c.scope.epoch, true)).length, 0);
  assert.equal(await (await c.source.get(key))!.text(), '已提交但本机确认失败');
});

test('schema 3 retains version 2 data and archiving aborts atomically without accepting an old receipt', async t => {
  const id = crypto.randomUUID(), name = 'page-together-v1-' + id, scope = { epoch: 'epoch', generation: 1, docId: 'doc' };
  const old = await openDB(name, 2, { upgrade(db) {
    db.createObjectStore('documents'); const updates = db.createObjectStore('updates', { keyPath: 'id' }); updates.createIndex('scope', 'scope');
    db.createObjectStore('drafts', { keyPath: 'id' }); db.createObjectStore('blobs', { keyPath: 'key' }); db.createObjectStore('access');
  } });
  await old.put('documents', new Uint8Array([1, 2, 3]), 'epoch:1:doc');
  await old.put('blobs', { key: 'epoch:key', epoch: 'epoch', blobKey: 'key', data: new Blob(['原始附件']), saved: false, blockedReason: '旧暂停原因' }); old.close();
  const local = new LocalPersistence(id); t.after(async () => { await local.close(); await deleteDB(name); });
  assert.deepEqual(await local.load(scope), new Uint8Array([1, 2, 3]));
  const original = (await local.blobs())[0]; assert.equal(await original.data.text(), '原始附件');
  const put = IDBObjectStore.prototype.put; let failures = 0;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const result = put.apply(this, args); if (this.name === 'blobDrafts' && failures++ === 0) this.transaction.abort(); return result;
  };
  t.after(() => { IDBObjectStore.prototype.put = put; });
  await assert.rejects(() => local.requeueBlob(original, scope, 2)); assert(failures > 0);
  assert.equal((await local.blobs())[0].blockedReason, original.blockedReason); assert.equal((await local.blobDrafts()).length, 0);
  IDBObjectStore.prototype.put = put;
  const first = await local.requeueBlob(original, scope, 2), second = await local.requeueBlob(first, scope, 2);
  assert.equal(await local.acknowledgeBlob(scope.epoch, original.blobKey, first.id), false);
  assert.equal((await local.blobs())[0].id, second.id); assert.equal((await local.blobs())[0].saved, false);
  assert.equal((await local.blobDrafts()).length, 2);
});

test('a server quota rejection retains the original upload and a later retry is idempotent', async t => {
  const c = await client(t), file = c.file('服务端配额不足的原始附件'), key = await c.queue(file);
  c.f.store.options.blobQuotaBytes = file.size - 1;
  await c.source.flush(); const retained = (await c.local.blobs(c.scope.epoch, true))[0];
  assert.equal(retained.blobKey, key); assert.equal(await retained.data.text(), await file.text());
  assert.equal(retained.blockedReason, undefined); assert.match(c.source.blobState$(key).value.errorMessage!, /配额不足/);
  assert.deepEqual(c.f.store.listBlobs(hash(c.f.owner.split('=')[1])), []);
  c.f.store.options.blobQuotaBytes = file.size;
  assert.equal(await c.source.upload(key), true); assert.equal(c.puts(), 2);
  assert.equal((await c.local.blobs(c.scope.epoch))[0].id, retained.id);
});

test('an independently authorized download rejects corrupt bytes before caching them', async t => {
  const c = await client(t), file = c.file('需要校验的附件'), key = await c.queue(file); await c.source.flush();
  await writeFile(join(c.f.directory, 'blobs', key), Buffer.alloc(file.size, 42));
  const viewer = await c.f.member('view'), member = (await (await c.f.request('/api/session', viewer.cookie)).json() as { member: Member }).member;
  const local = new LocalPersistence(member.id), source = new OfflineBlobSource({ ...c.context, member, local, updateAccess: () => {} });
  const original = globalThis.fetch;
  globalThis.fetch = (input, options) => typeof input === 'string' && input.startsWith('/api/') ? original(c.f.origin + input, { ...options, headers: { ...options?.headers, Cookie: viewer.cookie, Origin: c.f.origin } }) : original(input, options);
  try {
    await assert.rejects(() => source.get(key), /校验失败/); assert.equal((await local.blobs()).length, 0);
    assert.equal(source.blobState$(key).value.needDownload, true);
  } finally { source.dispose(); await source.settled(); await local.close(); await deleteDB('page-together-v1-' + member.id); }
});
