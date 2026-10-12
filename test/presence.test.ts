import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate } from 'y-protocols/awareness.js';
import { encodePresence } from '../shared/awareness.js';
import { fixture, Peer } from './helpers.js';

const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
async function open(peer: Peer, scope: { docId: string; epoch: string; generation: number }) {
  peer.send({ v: 1, type: 'open', requestId: 'open-' + scope.docId, ...scope, stateVector: encoded(new Uint8Array([0])) });
  await peer.next('sync'); await peer.next('awareness');
}
function observer(t: test.TestContext) {
  const doc = new Y.Doc(), awareness = new Awareness(doc); awareness.setLocalState(null);
  t.after(() => { awareness.destroy(); doc.destroy(); }); return awareness;
}
async function receive(peer: Peer, awareness: Awareness) {
  const message = await peer.next('awareness'); applyAwarenessUpdate(awareness, Buffer.from(message.update, 'base64'), 'server'); return message;
}
const send = (peer: Peer, scope: object, id: number, clock: number, state: Record<string, unknown> | null) => peer.send({ v: 1, type: 'awareness', requestId: 'presence-' + clock, ...scope, update: encoded(encodePresence(id, clock, state)) });

test('native awareness binds identity, supports viewers, supplies late peers and removes disconnected cursors', async t => {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit'), viewer = await f.member('view');
  await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: 'presence' });
  const scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  const owner = new Peer(f.origin, f.owner), edit = new Peer(f.origin, editor.cookie), view = new Peer(f.origin, viewer.cookie);
  t.after(() => { owner.close(); edit.close(); view.close(); });
  await Promise.all([owner.next('ready'), edit.next('ready'), view.next('ready')]);
  await open(owner, scope); await open(edit, scope); await open(view, scope);
  const awareness = observer(t);
  send(edit, scope, 1001, 1, { user: { name: '伪造所有者' }, memberId: 'forged', role: 'manage', color: 'red', selectionV2: { 'doc:editor': [{ type: 'cursor', x: 12, y: 24 }] } });
  await receive(owner, awareness);
  const state = awareness.getStates().get(1001)!;
  assert.equal(state.user.name, 'edit'); assert.equal(state.memberId, editor.member.id); assert.equal(state.role, 'edit'); assert.match(state.color, /^#[0-9a-f]{6}$/);
  assert.deepEqual(state.selectionV2['doc:editor'], [{ type: 'cursor', x: 12, y: 24 }]);
  send(view, scope, 1002, 1, { selectionV2: { 'doc:viewer': [{ type: 'text', from: { blockId: 'p', index: 0, length: 1 }, to: null }] } });
  await receive(owner, awareness); assert.equal(awareness.getStates().get(1002)!.role, 'view');
  const late = new Peer(f.origin, f.owner); t.after(() => late.close()); await late.next('ready');
  late.send({ v: 1, type: 'open', requestId: 'late', ...scope, stateVector: encoded(new Uint8Array([0])) });
  await late.next('sync'); const lateState = observer(t); await receive(late, lateState);
  assert.equal(lateState.getStates().size, 2);
  const closed = once(edit.ws, 'close'); edit.close(); await closed;
  await receive(owner, awareness); assert(!awareness.getStates().has(1001)); assert(awareness.getStates().has(1002));
  assert.equal((f.store.db.prepare('SELECT revision FROM documents WHERE id=?').get('doc') as { revision: number }).revision, 0);
  assert.equal(owner.count('saved'), 0);
});

test('awareness requires an authorized open scope and cannot impersonate another connection', async t => {
  const f = await fixture(); t.after(f.close);
  const editor = await f.member('edit');
  for (const id of ['doc', 'other']) await f.request('/api/documents', f.owner, 'POST', { id, title: id });
  const scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  const owner = new Peer(f.origin, f.owner), attacker = new Peer(f.origin, editor.cookie);
  t.after(() => { owner.close(); attacker.close(); }); await Promise.all([owner.next('ready'), attacker.next('ready')]);
  send(attacker, scope, 44, 1, {}); assert.equal((await attacker.next('error')).code, 'open_required');
  await open(owner, scope); await open(attacker, scope);
  send(owner, scope, 55, 1, { selectionV2: {} }); await owner.next('awareness');
  send(attacker, { ...scope, docId: 'other' }, 44, 2, {}); assert.equal((await attacker.next('error')).code, 'open_required');
  const closed = once(attacker.ws, 'close'); send(attacker, scope, 55, 100, null);
  assert.equal((await attacker.next('error')).code, 'awareness_client_owned'); await closed;
  const fresh = new Peer(f.origin, f.owner); t.after(() => fresh.close()); await fresh.next('ready');
  fresh.send({ v: 1, type: 'open', requestId: 'fresh', ...scope, stateVector: encoded(new Uint8Array([0])) }); await fresh.next('sync');
  const awareness = observer(t); await receive(fresh, awareness); assert(awareness.getStates().has(55));
});

test('permission changes and session expiry immediately remove presence without a durable document write', async t => {
  let now = Date.now(); const f = await fixture({ now: () => now }); t.after(f.close);
  const editor = await f.member('edit'); await f.request('/api/documents', f.owner, 'POST', { id: 'doc', title: 'doc' });
  const scope = { docId: 'doc', epoch: f.store.epoch, generation: 1 };
  const owner = new Peer(f.origin, f.owner), edit = new Peer(f.origin, editor.cookie); t.after(() => { owner.close(); edit.close(); });
  await Promise.all([owner.next('ready'), edit.next('ready')]); await open(owner, scope); await open(edit, scope);
  const awareness = observer(t); send(edit, scope, 77, 1, {}); await receive(owner, awareness);
  const closed = once(edit.ws, 'close'); await f.request('/api/members/' + editor.member.id, f.owner, 'PATCH', { role: 'view', active: true }); await closed;
  await receive(owner, awareness); assert(!awareness.getStates().has(77));
  const view = new Peer(f.origin, editor.cookie); t.after(() => view.close()); await view.next('ready'); await open(view, scope);
  send(view, scope, 77, 2, {}); await receive(owner, awareness); assert.equal(awareness.getStates().get(77)!.role, 'view');
  const expired = once(view.ws, 'close'); now += 31 * 86400_000; await expired;
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM updates').get() as { n: number }).n, 0);
});
