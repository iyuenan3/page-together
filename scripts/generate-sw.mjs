import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const assets = files('dist').filter(path => path !== 'dist/sw.js' && !path.endsWith('THIRD_PARTY_LICENSES.txt'));
const version = createHash('sha256');
for (const path of assets) version.update(readFileSync(path));
const cache = 'page-together-assets-' + version.digest('hex').slice(0, 16);
const paths = ['/', ...assets.map(path => '/' + path.slice(5))];
const fontConfig = readFileSync('node_modules/@blocksuite/affine-shared/src/services/font-loader/config.ts', 'utf8').split('export const CommunityCanvasTextFonts')[1];
const fonts = [...fontConfig.matchAll(/url: '(https:\/\/fonts\.cdnfonts\.com\/[^']+)'/g)].map(match => match[1]);
if (fonts.length !== 29 || new Set(fonts).size !== 29) throw new Error('Review pinned canvas font resources before building');
writeFileSync('dist/sw.js', `const CACHE=${JSON.stringify(cache)};
const ASSETS=${JSON.stringify(paths)};
const FONTS=${JSON.stringify(fonts)};
const FONT_CACHE='page-together-fonts-blocksuite-0.22.4';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim().then(async () => {
  const cache = await caches.open(FONT_CACHE);
  await Promise.allSettled(FONTS.map(async url => {
    if (await cache.match(url)) return;
    const response = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(15000) });
    if (response.ok && response.type !== 'opaque') await cache.put(url, response);
  }));
})));
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
  if (!ASSETS.includes(url.pathname) && !url.pathname.startsWith('/assets/')) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    if (event.request.mode === 'navigate') {
      try { return await fetch(event.request); } catch { return await cache.match(url.pathname) || Response.error(); }
    }
    return await cache.match(url.pathname) || await caches.match(event.request) || fetch(event.request);
  }));
});
`);
