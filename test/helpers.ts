import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import type { ServerMessage } from '../shared/protocol.js';

export async function fixture(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'page-together-test-'));
  const app = createApp({ directory, origin: 'http://127.0.0.1:0', heartbeatMs: 100, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  app.setOrigin(origin);
  const initial = app.store.initialize('测试所有者');
  async function request(path: string, cookie = '', method = 'GET', data?: unknown, requestOrigin = origin) {
    return fetch(origin + path, {
      method,
      headers: { Origin: requestOrigin, Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  const ownerResponse = await request('/api/auth/recover', '', 'POST', { code: initial.recoveryCode });
  assert.equal(ownerResponse.status, 200);
  const owner = ownerResponse.headers.get('set-cookie')!.split(';')[0];
  const recovery = (await ownerResponse.json() as { recoveryCode: string }).recoveryCode;
  async function member(role: 'edit' | 'view') {
    const inviteResponse = await request('/api/invitations', owner, 'POST', { role });
    assert.equal(inviteResponse.status, 201);
    const invitation = await inviteResponse.json() as { token: string; id: string };
    const response = await request('/api/auth/invite', '', 'POST', { token: invitation.token, nickname: role });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie')!.split(';')[0], ...await response.json() as { member: { id: string } }, invitation };
  }
  async function close() { await app.close(); await rm(directory, { recursive: true, force: true }); }
  return { ...app, directory, origin, owner, recovery, request, member, close };
}

export class Peer {
  readonly ws: WebSocket;
  private messages: ServerMessage[] = [];
  private waiting = new Set<() => void>();
  constructor(origin: string, cookie: string, requestOrigin = origin) {
    this.ws = new WebSocket(origin.replace('http', 'ws') + '/api/sync', { headers: { Origin: requestOrigin, Cookie: cookie } });
    this.ws.on('message', data => { this.messages.push(JSON.parse(data.toString())); for (const wake of this.waiting) wake(); });
    this.ws.on('error', () => {});
  }
  send(message: unknown) { this.ws.send(JSON.stringify(message)); }
  count(type: ServerMessage['type']) { return this.messages.filter(message => message.type === type).length; }
  async next(type: ServerMessage['type'], requestId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.waiting.delete(check); reject(new Error('Timed out waiting for ' + type)); }, 4000);
      const check = () => {
        const index = this.messages.findIndex(message => message.type === type && (requestId === undefined || ('requestId' in message && message.requestId === requestId)));
        if (index < 0) return;
        const [message] = this.messages.splice(index, 1);
        clearTimeout(timeout); this.waiting.delete(check); resolve(message);
      };
      this.waiting.add(check); check();
    });
  }
  close() { this.ws.terminate(); }
}
