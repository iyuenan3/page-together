import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('actual generated worker caches only successful pinned fonts and serves them offline', async () => {
  const generator = readFileSync('scripts/generate-sw.mjs', 'utf8');
  const template = generator.slice(generator.indexOf('`const CACHE='), generator.lastIndexOf('`);') + 1);
  const font = 'https://fonts.cdnfonts.com/s/16009/Poppins-Regular.woff';
  const worker = new Function('cache', 'paths', 'fonts', `return ${template}`)('test-assets', ['/'], [font]);
  const listeners = new Map<string, (event: { request?: Request; respondWith?: (promise: Promise<Response>) => void; waitUntil?: (promise: Promise<unknown>) => void }) => void>();
  const stored = new Map<string, Response>();
  let requests = 0, offline = false;
  const cache = {
    match: async (value: Request | string) => stored.get(typeof value === 'string' ? value : value.url),
    put: async (value: Request | string, response: Response) => { stored.set(typeof value === 'string' ? value : value.url, response); },
  };
  vm.runInNewContext(worker, {
    URL, AbortSignal,
    self: { location: { origin: 'http://localhost' }, addEventListener: (name: string, handler: typeof listeners extends Map<string, infer H> ? H : never) => { listeners.set(name, handler); } },
    caches: { open: async () => cache },
    fetch: async () => { requests++; if (offline) throw new TypeError('offline'); return new Response('font bytes', { status: 200 }); },
  });
  const handle = (url: string) => {
    let result: Promise<Response> | undefined;
    listeners.get('fetch')!({ request: new Request(url), respondWith: promise => { result = promise; } });
    return result;
  };
  assert.equal(await (await handle(font))!.clone().text(), 'font bytes'); assert.equal(requests, 1);
  offline = true;
  assert.equal(await (await handle(font))!.clone().text(), 'font bytes'); assert.equal(requests, 1);
  assert.equal(handle('https://fonts.cdnfonts.com/unlisted.woff'), undefined);
  assert.equal(handle('http://localhost/api/documents'), undefined);
  stored.clear(); offline = false;
  vm.runInNewContext(worker, {
    URL, AbortSignal,
    self: { location: { origin: 'http://localhost' }, addEventListener: (name: string, handler: typeof listeners extends Map<string, infer H> ? H : never) => { listeners.set(name, handler); } },
    caches: { open: async () => cache }, fetch: async () => new Response('missing', { status: 404 }),
  });
  assert.equal((await handle(font))!.status, 404); assert.equal(stored.size, 0);
});
