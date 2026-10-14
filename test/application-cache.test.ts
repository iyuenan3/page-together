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
    caches: { keys: async () => [...names], delete: async (name: string) => names.delete(name), open: async () => ({ match: async () => new Response('complete shell') }) },
  });
  async function cleanup() { let result!: Promise<void>; events.get('message')!({ data: { type: 'page-together-cache-cleanup' }, waitUntil: (value: Promise<void>) => result = value }); await result; }
  clients[0].version = older; await cleanup(); assert(names.has(older));
  clients[0].version = current; clients[0].silent = true; await cleanup(); assert(names.has(older));
  clients[0].silent = false; newcomer = true; await cleanup(); assert(names.has(older));
  clients = [clients[0]]; newcomer = false; await cleanup(); assert(!names.has(older)); assert(names.has(old)); assert(names.has(current)); assert(names.has(other)); assert(names.has('page-together-fonts-blocksuite-0.22.4'));
});

test('quota-failed worker installation removes only a newly created cache and preserves existing resources', async () => {
  for (const existed of [false, true]) {
    const events = new Map<string, (event: any) => void>(), names = new Set([old, other, ...existed ? [current] : []]);
    let activated = 0, installation!: Promise<void>;
    vm.runInNewContext(worker(), {
      self: { addEventListener: (name: string, handler: any) => events.set(name, handler), skipWaiting: () => { activated++; } },
      caches: { keys: async () => [...names], open: async (name: string) => { names.add(name); return { addAll: async () => { throw new DOMException('quota', 'QuotaExceededError'); } }; }, delete: async (name: string) => names.delete(name) },
    });
    events.get('install')!({ waitUntil: (value: Promise<void>) => installation = value });
    await assert.rejects(installation, { name: 'QuotaExceededError' });
    assert.equal(activated, 0); assert(names.has(old)); assert(names.has(other));
    assert.equal(names.has(current), existed, 'an already existing active build must not be removed');
  }
});

test('an incomplete cache does not displace the last usable build or get deleted during another installation', async () => {
  const incomplete = 'page-together-assets-4444444444444444';
  const events = new Map<string, (event: any) => void>(), names = new Set([older, old, current, incomplete, other]);
  vm.runInNewContext(worker(), {
    URL, crypto, setTimeout: (callback: () => void) => queueMicrotask(callback),
    self: { location: { origin: 'http://localhost' }, clients: { matchAll: async () => [{ id: 'page', postMessage: (message: { nonce: string }) => events.get('message')!({ data: { type: 'page-together-cache-version', nonce: message.nonce, cache: current }, source: { id: 'page' } }) }] }, addEventListener: (name: string, handler: any) => events.set(name, handler) },
    caches: { keys: async () => [...names], open: async (name: string) => ({ match: async () => name === incomplete ? undefined : new Response('usable shell') }), delete: async (name: string) => names.delete(name) },
  });
  let cleaning!: Promise<void>; events.get('message')!({ data: { type: 'page-together-cache-cleanup' }, waitUntil: (value: Promise<void>) => cleaning = value }); await cleaning;
  assert(names.has(old), 'failed/inflight install is not the prior usable build');
  assert(names.has(incomplete), 'cleanup must not delete a cache that another worker is installing');
  assert(!names.has(older)); assert(names.has(current)); assert(names.has(other));
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
