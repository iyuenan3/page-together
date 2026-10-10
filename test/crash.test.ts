import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { Store } from '../server/store.js';
import { Peer } from './helpers.js';

test('SIGKILL after saved receipt preserves content and sessions on a fresh process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'page-together-crash-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const setup = new Store(directory), initial = setup.initialize('崩溃测试');
  const epoch = setup.epoch; setup.close();
  async function start() {
    const process = fork(new URL('./server-process.js', import.meta.url), { env: { ...globalThis.process.env, TEST_DATA_DIR: directory }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(async () => { if (process.exitCode === null && process.signalCode === null) { const exit = once(process, 'exit'); process.kill('SIGTERM'); await exit; } });
    const [message] = await once(process, 'message');
    return { process, origin: (message as { origin: string }).origin };
  }
  const first = await start();
  const auth = await fetch(first.origin + '/api/auth/recover', { method: 'POST', headers: { Origin: first.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: initial.recoveryCode }) });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  await fetch(first.origin + '/api/documents', { method: 'POST', headers: { Origin: first.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'doc', title: '持久性' }) });
  const peer = new Peer(first.origin, cookie); await peer.next('ready');
  const scope = { docId: 'doc', epoch, generation: 1 }, doc = new Y.Doc();
  peer.send({ v: 1, type: 'open', requestId: 'open', ...scope, stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') }); await peer.next('sync');
  doc.getText('content').insert(0, '保存确认之后强制终止');
  peer.send({ v: 1, type: 'push', requestId: 'save', ...scope, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
  await peer.next('saved');
  const exit = once(first.process, 'exit'); first.process.kill('SIGKILL'); await exit; peer.close();
  const second = await start(), reader = new Peer(second.origin, cookie); t.after(() => reader.close());
  assert.equal((await reader.next('ready')).epoch, epoch);
  const fresh = new Y.Doc();
  reader.send({ v: 1, type: 'open', requestId: 'reload', ...scope, stateVector: Buffer.from(Y.encodeStateVector(fresh)).toString('base64') });
  Y.applyUpdate(fresh, Buffer.from((await reader.next('sync')).update, 'base64'));
  assert.equal(fresh.getText('content').toString(), '保存确认之后强制终止');
});
