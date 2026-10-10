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
writeFileSync('dist/sw.js', `const CACHE=${JSON.stringify(cache)};
const ASSETS=${JSON.stringify(paths)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
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
