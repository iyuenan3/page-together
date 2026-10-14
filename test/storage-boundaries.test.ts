import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { backup, restore } from '../server/backup.js';
import { hash, Store } from '../server/store.js';
import { attachmentHeaders, fixture, Peer } from './helpers.js';

const encoded = (data: Uint8Array) => Buffer.from(data).toString('base64');
function durable(store: Store, id: string) {
  const doc = new Y.Doc();
  const row = store.db.prepare('SELECT snapshot FROM documents WHERE id=?').get(id) as { snapshot: Buffer };
  Y.applyUpdate(doc, row.snapshot);
  for (const row of store.db.prepare('SELECT data FROM updates WHERE doc_id=? ORDER BY revision').all(id) as { data: Buffer }[]) Y.applyUpdate(doc, row.data);
  return doc;
}

test('a native document near its byte limit rejects the next delta without receipts, broadcasts or backup contamination', async t => {
  const limit = 8192, f = await fixture({ maxDocumentBytes: limit }); t.after(f.close);
  await f.request('/api/documents', f.owner, 'POST', { id: 'near', title: '配额边界' });
  const scope = { docId: 'near', epoch: f.store.epoch, generation: 1 }, session = hash(f.owner.split('=')[1]);
  f.store.initializeDocument(session, scope, 0);
  const sender = new Peer(f.origin, f.owner), observer = new Peer(f.origin, f.owner);
  t.after(() => { sender.close(); observer.close(); });
  await Promise.all([sender.next('ready'), observer.next('ready')]);
  for (const peer of [sender, observer]) {
    peer.send({ v: 1, type: 'open', requestId: 'open', ...scope, stateVector: encoded(Y.encodeStateVector(new Y.Doc())) });
    await peer.next('sync', 'open');
  }
  const doc = durable(f.store, 'near'); t.after(() => doc.destroy());
  const paragraph = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(block => block.get('sys:flavour') === 'affine:paragraph')!;
  const text = paragraph.get('prop:text') as Y.Text;
  text.insert(0, '富文本原稿', { bold: true, underline: true });
  const target = limit - 16;
  while (Y.encodeStateAsUpdate(doc).length < target) text.insert(text.length, 'x'.repeat(target - Y.encodeStateAsUpdate(doc).length));
  while (Y.encodeStateAsUpdate(doc).length > target) text.delete(text.length - 1, 1);
  const accepted = Y.encodeStateAsUpdate(doc);
  assert(accepted.length / limit >= 0.98 && accepted.length <= limit);
  sender.send({ v: 1, type: 'push', requestId: 'near-save', ...scope, update: encoded(accepted) });
  const receipt = await sender.next('saved', 'near-save');
  assert.equal(receipt.updateHash, hash(accepted)); assert.equal(receipt.revision, 2);
  await observer.next('update');
  const before = durable(f.store, 'near'), bytes = Y.encodeStateAsUpdate(before); before.destroy();
  const vector = Y.encodeStateVector(doc); text.insert(text.length, '不能进入已确认版本'.repeat(8));
  const rejected = Y.encodeStateAsUpdate(doc, vector);
  assert(rejected.length < limit, 'reject total document size, rather than transport payload size');
  sender.send({ v: 1, type: 'push', requestId: 'over-save', ...scope, update: encoded(rejected) });
  assert.equal((await sender.next('error', 'over-save')).code, 'document_too_large');
  observer.send({ v: 1, type: 'open', requestId: 'barrier', ...scope, stateVector: encoded(Y.encodeStateVector(doc)) });
  assert.equal((await observer.next('sync', 'barrier')).revision, receipt.revision);
  assert.equal(sender.count('saved'), 0); assert.equal(observer.count('update'), 0);
  const after = durable(f.store, 'near'); assert.deepEqual(Y.encodeStateAsUpdate(after), bytes); after.destroy();
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM updates WHERE doc_id=?').get('near') as { n: number }).n, 2);
  await f.request('/api/documents', f.owner, 'POST', { id: 'other', title: '继续保存' });
  const other = new Y.Doc(); other.getText('content').insert(0, '其他文档不受影响');
  f.store.push(session, { ...scope, docId: 'other' }, Y.encodeStateAsUpdate(other)); other.destroy();
  const snapshot = join(f.directory, 'boundary-backup'), destination = join(f.directory, 'boundary-restored');
  await backup(f.store, snapshot); await restore(snapshot, destination);
  const restored = new Store(destination); t.after(() => restored.close());
  const readback = durable(restored, 'near'); assert.deepEqual(Y.encodeStateAsUpdate(readback), bytes); readback.destroy();
});

test('document count includes the recycle bin and retains existing documents on a full-space rejection', async t => {
  const f = await fixture({ maxDocuments: 3 }); t.after(f.close);
  for (const id of ['one', 'two', 'three']) assert.equal((await f.request('/api/documents', f.owner, 'POST', { id, title: id })).status, 201);
  await f.request('/api/documents/one/trash', f.owner, 'POST');
  const before = f.store.db.prepare('SELECT * FROM documents ORDER BY id').all();
  const rejected = await f.request('/api/documents', f.owner, 'POST', { id: 'four', title: '超额' });
  assert.equal(rejected.status, 413); assert.equal((await rejected.json() as { code: string }).code, 'document_quota');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM documents ORDER BY id').all(), before);
  assert.equal((await f.request('/api/documents', f.owner, 'POST', { id: 'two', title: '重复创建' })).status, 201);
  assert.equal((await f.request('/api/documents/one/restore', f.owner, 'POST')).status, 200);
  const rows = f.store.db.prepare('SELECT id,title,deleted FROM documents ORDER BY id').all();
  assert.deepEqual(rows, ['one', 'three', 'two'].map(id => ({ id, title: id, deleted: 0 })));
});

test('concurrent final attachments cannot overcommit a nearly full space and confirmed originals survive backup restore', async t => {
  const f = await fixture({ maxBlobBytes: 10_000, blobQuotaBytes: 20_000 }); t.after(f.close);
  const headers = await attachmentHeaders(f), viewer = await f.member('view');
  const keyFor = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const originals = [Buffer.alloc(9000, 1), Buffer.alloc(9000, 2)], final = [Buffer.alloc(1500, 3), Buffer.alloc(1500, 4)];
  const upload = (bytes: Buffer, cookie = f.owner) => fetch(f.origin + '/api/blobs/' + encodeURIComponent(keyFor(bytes)), { method: 'PUT', headers: { ...headers, Cookie: cookie, Origin: f.origin }, body: bytes });
  for (const bytes of originals) { const response = await upload(bytes); assert.equal(response.status, 200); await response.json(); }
  const responses = await Promise.all(final.map(bytes => upload(bytes)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 413]);
  const failed = responses.findIndex(response => response.status === 413), winner = 1 - failed;
  assert.equal((await responses[failed].json() as { code: string }).code, 'blob_quota'); await responses[winner].json();
  const expected = [...originals, final[winner]], keys = expected.map(keyFor).sort();
  assert.deepEqual((await readdir(join(f.directory, 'blobs'))).sort(), keys, 'rejected final file and upload temporary file must not remain authoritative');
  const session = hash(f.owner.split('=')[1]);
  const rows = f.store.listBlobs(session).map(key => f.store.blob(session, key)!);
  assert.equal(rows.reduce((sum, row) => sum + row.size, 0), 19_500); assert.equal(rows.length, 3);
  const repeat = await upload(final[winner]); assert.equal(repeat.status, 200); await repeat.json();
  const denied = await upload(final[winner], viewer.cookie); assert.equal(denied.status, 403); await denied.json();
  for (const bytes of expected) {
    const response = await f.request('/api/blobs/' + encodeURIComponent(keyFor(bytes)), viewer.cookie);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  const snapshot = join(f.directory, 'attachments-backup'), destination = join(f.directory, 'attachments-restored');
  await backup(f.store, snapshot); await restore(snapshot, destination);
  const restored = new Store(destination); t.after(() => restored.close());
  assert.deepEqual(restored.db.prepare('SELECT key,size,hash FROM blobs ORDER BY key').all(), f.store.db.prepare('SELECT key,size,hash FROM blobs ORDER BY key').all());
  assert.deepEqual((await readdir(join(destination, 'blobs'))).sort(), keys);
  for (const bytes of expected) assert.deepEqual(await readFile(join(destination, 'blobs', keyFor(bytes))), bytes);
});
