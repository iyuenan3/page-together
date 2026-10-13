import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as Y from 'yjs';
import { QueryIndex } from '../shared/query-index.js';
import { LocalPersistence } from '../src/app/local.js';
import { DocumentSync } from '../src/app/sync.js';
import { fixture, Peer } from './helpers.js';

test('query index handles cold loads, duplicate block IDs, type changes, removal and replacement generations', () => {
  type Source = { id: string; blocks: { id: string }[]; changed?: () => void };
  let rows = new Map<string, { doc: Source; model: { id: string } }>(), disposed = 0;
  const index = new QueryIndex<Source, { id: string }>({
    blocks: doc => doc.blocks,
    subscribe: (doc, changed) => { doc.changed = changed; return () => { disposed++; doc.changed = undefined; }; },
    changed: value => { rows = value; },
  });
  const a: Source = { id: 'a', blocks: [] }, b: Source = { id: 'b', blocks: [{ id: 'same' }] };
  index.reconcile([a, b]); assert.deepEqual([...rows.keys()], ['b/same']);
  a.blocks = [{ id: 'same' }]; a.changed!(); assert.equal(rows.size, 2);
  a.blocks = []; a.changed!(); assert.deepEqual([...rows.keys()], ['b/same']);
  const restored: Source = { id: 'b', blocks: [{ id: 'restored' }] };
  index.reconcile([restored]); assert.deepEqual([...rows.keys()], ['b/restored']);
  assert.equal(a.changed, undefined); assert.equal(b.changed, undefined); assert.equal(disposed, 2);
  index.dispose(); assert.equal(restored.changed, undefined); assert.equal(disposed, 3);
});

test('HTTP query reads enforce identity, role, epoch, generation and document lifecycle without sockets', async t => {
  const f = await fixture({ maxConnections: 1 }); t.after(f.close);
  const occupied = new Peer(f.origin, f.owner); t.after(() => occupied.close()); await occupied.next('ready');
  await f.request('/api/documents', f.owner, 'POST', { id: 'query-source', title: '待办来源' });
  const scope = { docId: 'query-source', epoch: f.store.epoch, generation: 1 };
  const member = await f.member('view');
  const doc = new Y.Doc(); t.after(() => doc.destroy()); doc.getText('body').insert(0, '来源正文');
  f.store.push((await import('../server/store.js')).hash(f.owner.split('=')[1]), scope, Y.encodeStateAsUpdate(doc));
  const path = (generation = 1, epoch = scope.epoch) => `/api/documents/query-source/state?epoch=${epoch}&generation=${generation}`;
  assert.equal((await f.request(path())).status, 401);
  const response = await f.request(path(), member.cookie); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const read = await response.json() as { update: string; revision: number; member: { role: string } };
  const replica = new Y.Doc(); t.after(() => replica.destroy()); Y.applyUpdate(replica, Buffer.from(read.update, 'base64'));
  assert.equal(replica.getText('body').toString(), '来源正文'); assert.equal(read.member.role, 'view'); assert.equal(read.revision, 1);
  assert.equal((await f.request(path(2), member.cookie)).status, 409);
  assert.equal((await f.request(path(1, 'old-epoch'), member.cookie)).status, 409);
  assert.equal((await f.request(path(0), member.cookie)).status, 400);
  await f.request('/api/documents/query-source/trash', f.owner, 'POST');
  assert.equal((await f.request(path(), member.cookie)).status, 409);
  await f.request('/api/documents/query-source/restore', f.owner, 'POST');
  assert.equal((await f.request(path(), member.cookie)).status, 409);
  assert.equal((await f.request(path(3), member.cookie)).status, 200);
  await f.request('/api/members/' + member.member.id, f.owner, 'PATCH', { role: 'view', active: false });
  assert.equal((await f.request(path(3), member.cookie)).status, 401);
});

test('actual query read caches a remote document and guards offline drafts when access changes', async t => {
  const f = await fixture(); t.after(f.close);
  const member = await f.member('edit');
  await f.request('/api/documents', f.owner, 'POST', { id: 'query-source', title: '来源' });
  const scope = { docId: 'query-source', epoch: f.store.epoch, generation: 1 };
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (input, options) => {
    if (typeof input !== 'string' || !input.startsWith('/api/')) return original(input, options);
    requests++;
    return original(f.origin + input, { ...options, headers: { ...options?.headers, Cookie: member.cookie, Origin: f.origin } });
  };
  t.after(() => { globalThis.fetch = original; });
  const local = new LocalPersistence(member.member.id), doc = new Y.Doc(), sync = new DocumentSync(doc, scope, local, 0);
  t.after(async () => { sync.stop(); doc.destroy(); await local.close(); });
  await sync.readQuery(true); assert.equal(requests, 1); assert.equal(sync.queryRevision, 0);
  assert.equal((await local.pending(scope)).length, 0);
  doc.getText('body').insert(0, '未上传的离线稿'); await sync.settled();
  assert.equal((await local.pending(scope)).length, 1);
  await f.request('/api/members/' + member.member.id, f.owner, 'PATCH', { role: 'view', active: true });
  await assert.rejects(sync.readQuery(true), /暂停上传/);
  assert.equal(sync.isBlocked, true); assert.equal(doc.getText('body').toString(), '未上传的离线稿');
  assert.equal((await local.pending(scope)).length, 1);
  const fresh = new DocumentSync(new Y.Doc(), scope, new LocalPersistence(randomUUID()), 0);
  t.after(async () => { fresh.stop(); fresh.doc.destroy(); await fresh.local.close(); });
  await assert.rejects(fresh.readQuery(false), /尚未缓存/);
  await assert.rejects(fresh.readQuery(false), /尚未缓存/);
});
