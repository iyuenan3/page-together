import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const current = 'page-together-assets-1111111111111111', old = 'page-together-assets-2222222222222222', other = 'private-cache';
const older = 'page-together-assets-3333333333333333';
function worker() {
  const generator = readFileSync('scripts/generate-sw.mjs', 'utf8');
  const template = generator.slice(generator.indexOf('`const CACHE='), generator.lastIndexOf('`);') + 1);
  return new Function('cache', 'paths', 'fonts', `return ${template}`)(current, ['/', '/index.html', '/assets/current.js'], []);
}
test('worker cleanup keeps old, silent and new clients, deletes only unneeded application resources', async () => {
  const events = new Map<string, (event: any) => void>(), names = new Set([older, old, current, other, 'page-together-fonts-blocksuite-0.22.4']);
  let clients = [{ id: 'one', version: current, silent: false }], newcomer = false;
  const windows = () => clients.map(client => ({ id: client.id, postMessage: (message: { nonce: string }) => {
    if (!client.silent) events.get('message')!({ data: { type: 'page-together-cache-version', nonce: message.nonce, cache: client.version }, source: { id: client.id } });
  } }));
  vm.runInNewContext(worker(), {
    URL, crypto, setTimeout: (callback: () => void) => { if (newcomer) clients.push({ id: 'new', version: current, silent: true }); queueMicrotask(callback); },
    self: { location: { origin: 'http://localhost' }, clients: { matchAll: async () => windows() }, addEventListener: (name: string, handler: any) => events.set(name, handler) },
    caches: { keys: async () => [...names], delete: async (name: string) => names.delete(name) },
  });
  async function cleanup() { let result!: Promise<void>; events.get('message')!({ data: { type: 'page-together-cache-cleanup' }, waitUntil: (value: Promise<void>) => result = value }); await result; }
  clients[0].version = older; await cleanup(); assert(names.has(older));
  clients[0].version = current; clients[0].silent = true; await cleanup(); assert(names.has(older));
  clients[0].silent = false; newcomer = true; await cleanup(); assert(names.has(older));
  clients = [clients[0]]; newcomer = false; await cleanup(); assert(!names.has(older)); assert(names.has(old)); assert(names.has(current)); assert(names.has(other)); assert(names.has('page-together-fonts-blocksuite-0.22.4'));
});

test('offline deep links use the current application shell and never a foreign cache', async () => {
  const events = new Map<string, (event: any) => void>();
  vm.runInNewContext(worker(), {
    URL,
    self: { location: { origin: 'http://localhost' }, addEventListener: (name: string, handler: any) => events.set(name, handler) },
    caches: { open: async (name: string) => { assert.equal(name, current); return { match: async (path: string) => path === '/' ? new Response('current shell') : undefined }; } },
    fetch: async () => { throw new TypeError('offline'); },
  });
  let response!: Promise<Response>;
  events.get('fetch')!({ request: { method: 'GET', url: 'http://localhost/workspace/main/cold', mode: 'navigate' }, respondWith: (value: Promise<Response>) => response = value });
  assert.equal(await (await response).text(), 'current shell');
});
