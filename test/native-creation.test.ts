import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { LocalPersistence } from '../src/app/local.js';
import { DocumentSync } from '../src/app/sync.js';

function client(t: test.TestContext, creation: Promise<unknown>) {
  const local = new LocalPersistence(crypto.randomUUID()), doc = new Y.Doc();
  const scope = { epoch: 'native-creation', generation: 1, docId: crypto.randomUUID() };
  const sync = new DocumentSync(doc, scope, local, 3, undefined, creation);
  t.after(async () => { sync.stop(); doc.destroy(); await local.close(); });
  return { local, doc, scope, sync };
}

test('immediate native initialization waits for confirmed creation and records authorization before its first local write', async t => {
  let confirm!: () => void;
  const c = client(t, new Promise<void>(resolve => { confirm = resolve; }));
  c.doc.getText('body').insert(0, '原生入口立即初始化');
  assert.equal((await c.local.pending(c.scope)).length, 0);
  assert.equal(await c.local.load(c.scope), undefined);
  confirm(); await c.sync.settled();
  assert.equal((await c.local.pending(c.scope)).length, 1);
  assert.equal(await c.local.checkAccess(c.scope, 3), undefined);
  assert.equal(c.sync.isBlocked, false);
  const restored = new Y.Doc(); Y.applyUpdate(restored, (await c.local.load(c.scope))!);
  assert.equal(restored.getText('body').toString(), '原生入口立即初始化'); restored.destroy();
});

test('a confirmed new creation never authorizes already queued content without its original permission record', async t => {
  let confirm!: () => void;
  const c = client(t, new Promise<void>(resolve => { confirm = resolve; }));
  const old = new Y.Doc(); old.getText('body').insert(0, '旧未核验内容');
  await c.local.persist(c.scope, Y.encodeStateAsUpdate(old), true); old.destroy();
  c.doc.getText('body').insert(0, '新的初始化');
  confirm(); await c.sync.settled();
  assert.equal(c.sync.isBlocked, true);
  assert.match((await c.local.checkAccess(c.scope, 3))!, /尚未核验/);
  assert.equal((await c.local.pending(c.scope)).length, 2);
});

test('failed HTTP creation retains immediate native content locally and permanently pauses its upload', async t => {
  let reject!: (error: Error) => void;
  const c = client(t, new Promise<void>((_, fail) => { reject = fail; }));
  c.doc.getText('body').insert(0, '创建请求失败仍保留');
  reject(new TypeError('creation unavailable')); await c.sync.settled();
  assert.equal(c.sync.isBlocked, true);
  assert.match((await c.local.checkAccess(c.scope, 3))!, /创建文档未完成/);
  const restored = new Y.Doc(); Y.applyUpdate(restored, (await c.local.load(c.scope))!);
  assert.equal(restored.getText('body').toString(), '创建请求失败仍保留'); restored.destroy();
});
