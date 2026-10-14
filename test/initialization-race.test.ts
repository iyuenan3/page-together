import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { emptyNativeDocument, nativeRootIds } from '../shared/native-document.js';
import { hash } from '../server/store.js';
import { LocalPersistence } from '../src/app/local.js';
import { DocumentSync } from '../src/app/sync.js';
import { fixture } from './helpers.js';

test('a native creator racing empty recovery cannot publish a second root', async t => {
  const f = await fixture(); t.after(f.close);
  const session = hash(f.owner.split('=')[1]), scope = { docId: 'race', epoch: f.store.epoch, generation: 1 };
  f.store.createDocument(session, scope.docId, '并发初始化');
  const creator = emptyNativeDocument('原生创建方', 'creator', Date.now()); t.after(() => creator.destroy());
  f.store.initializeDocument(session, scope, 0);
  const before = f.store.pull(session, scope, Uint8Array.of(0));
  assert.throws(() => f.store.push(session, scope, Y.encodeStateAsUpdate(creator)), /document_root_conflict/);
  assert.deepEqual(f.store.pull(session, scope, Uint8Array.of(0)), before);
});

test('a real cold HTTP sync retains a racing creator before merging a different initialized root', async t => {
  const f = await fixture(); t.after(f.close);
  const session = hash(f.owner.split('=')[1]), member = f.store.authenticate(session);
  const scope = { docId: 'race', epoch: f.store.epoch, generation: 1 };
  f.store.createDocument(session, scope.docId, '云端恢复方'); f.store.initializeDocument(session, scope, 0);
  const local = new LocalPersistence(member.id), doc = new Y.Doc(), creator = emptyNativeDocument('原生创建方', member.id, Date.now());
  const sync = new DocumentSync(doc, scope, local, 0, undefined, Promise.resolve());
  t.after(async () => { sync.stop(); doc.destroy(); creator.destroy(); await local.close(); });
  const text = [...creator.getMap<Y.Map<unknown>>('blocks').values()].find(block => block.get('sys:flavour') === 'affine:paragraph')!.get('prop:text') as Y.Text;
  text.insert(0, '并发窗口内输入，不能丢失');
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(creator)); await sync.settled();
  const before = Y.encodeStateAsUpdate(doc), cloud = f.store.pull(session, scope, Uint8Array.of(0));
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (input, options) => typeof input === 'string' && input.startsWith('/api/')
    ? fetchOriginal(f.origin + input, { ...options, headers: { ...options?.headers, Origin: f.origin, Cookie: f.owner } }) : fetchOriginal(input, options);
  t.after(() => { globalThis.fetch = fetchOriginal; });
  await assert.rejects(sync.readQuery(true), /初始化/);
  assert.equal(sync.isBlocked, true); assert.equal(nativeRootIds(doc).length, 1);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  const drafts = await local.drafts(); assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].data, before);
  assert.deepEqual(f.store.pull(session, scope, Uint8Array.of(0)), cloud);
});
