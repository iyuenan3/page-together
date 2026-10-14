import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const assets = files('dist').filter(path => path !== 'dist/sw.js' && !path.endsWith('THIRD_PARTY_LICENSES.txt'));
const index = readFileSync('dist/index.html', 'utf8').replace(/<meta name="page-together-assets" content="[^"]+">/g, '');
const version = createHash('sha256');
for (const path of assets) { version.update(path + '\0'); version.update(path === 'dist/index.html' ? index : readFileSync(path)); }
const cache = 'page-together-assets-' + version.digest('hex').slice(0, 16);
const paths = ['/', ...assets.map(path => '/' + path.slice(5))];
writeFileSync('dist/index.html', index.replace('<head>', '<head><meta name="page-together-assets" content="' + cache + '">'));
const fontConfig = readFileSync('node_modules/@blocksuite/affine-shared/src/services/font-loader/config.ts', 'utf8').split('export const CommunityCanvasTextFonts')[1];
const fonts = [...fontConfig.matchAll(/url: '(https:\/\/fonts\.cdnfonts\.com\/[^']+)'/g)].map(match => match[1]);
if (fonts.length !== 29 || new Set(fonts).size !== 29) throw new Error('Review pinned canvas font resources before building');
writeFileSync('dist/sw.js', `const CACHE=${JSON.stringify(cache)};
const ASSETS=${JSON.stringify(paths)};
const FONTS=${JSON.stringify(fonts)};
const FONT_CACHE='page-together-fonts-blocksuite-0.22.4';
async function installAssets() {
  const existed = (await caches.keys()).includes(CACHE);
  const cache = await caches.open(CACHE);
  try { await cache.addAll(ASSETS); await self.skipWaiting(); }
  catch (error) {
    // A quota-failed upgrade must not replace or erase a usable old build.
    if (!existed) await caches.delete(CACHE);
    throw error;
  }
}
self.addEventListener('install', event => event.waitUntil(installAssets()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim().then(async () => {
  const cache = await caches.open(FONT_CACHE);
  await Promise.allSettled(FONTS.map(async url => {
    if (await cache.match(url)) return;
    const response = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(15000) });
    if (response.ok && response.type !== 'opaque') await cache.put(url, response);
  }));
  await cleanOldAssets();
})));
const reports = new Map();
let cleaning;
function cleanOldAssets() {
  return cleaning ??= (async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const nonce = crypto.randomUUID(), versions = new Map(); reports.set(nonce, versions);
    try {
      for (const client of clients) client.postMessage({ type: 'page-together-cache-query', nonce });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Legacy, silent or newly opened pages keep every old asset cache intact.
      if (live.some(client => !versions.has(client.id))) return;
      const retained = new Set([CACHE, ...live.map(client => versions.get(client.id))]);
      const names = [];
      for (const name of await caches.keys()) if (/^page-together-assets-[a-f0-9]{16}$/.test(name)) {
        // An empty cache may belong to an installing worker. Leave it alone and
        // do not mistake it for the most recent usable history build.
        if (await (await caches.open(name)).match('/')) names.push(name);
      }
      // Keep one prior build for a recently restored history page as well.
      const previous = names.filter(name => name !== CACHE).at(-1); if (previous) retained.add(previous);
      for (const name of names) if (!retained.has(name)) await caches.delete(name);
    } finally { reports.delete(nonce); }
  })().finally(() => { cleaning = undefined; });
}
self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'page-together-cache-version' && event.source?.id && /^page-together-assets-[a-f0-9]{16}$/.test(message.cache)) {
    reports.get(message.nonce)?.set(event.source.id, message.cache);
  } else if (message?.type === 'page-together-cache-cleanup') event.waitUntil(cleanOldAssets());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && FONTS.includes(url.href)) {
    event.respondWith(caches.open(FONT_CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok && response.type !== 'opaque') {
        try { await cache.put(event.request, response.clone()); } catch { /* Font rendering still works if cache storage is unavailable. */ }
      }
      return response;
    }));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const navigate = event.request.mode === 'navigate' && (ASSETS.includes(url.pathname) || url.pathname.startsWith('/workspace/main/') && url.pathname.split('/').length === 4);
  if (!ASSETS.includes(url.pathname) && !url.pathname.startsWith('/assets/') && !navigate) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (event.request.mode === 'navigate') {
      try { return await fetch(event.request); } catch { return await cache.match(url.pathname) || await cache.match('/') || Response.error(); }
    }
    const current = await cache.match(url.pathname);
    if (current) return current;
    // Only retained application caches can supply an old hashed module.
    for (const name of await caches.keys()) if (/^page-together-assets-[a-f0-9]{16}$/.test(name)) {
      const old = await (await caches.open(name)).match(url.pathname); if (old) return old;
    }
    return fetch(event.request);
  }));
});
`);
