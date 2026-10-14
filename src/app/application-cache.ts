/** Each page reports the exact build it loaded, including after worker takeover. */
export function observeApplicationCache() {
  const cache = document.querySelector<HTMLMetaElement>('meta[name="page-together-assets"]')?.content;
  if (!cache || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'page-together-cache-query') event.source?.postMessage({ type: 'page-together-cache-version', cache, nonce: event.data.nonce });
  });
  const cleanup = () => navigator.serviceWorker.controller?.postMessage({ type: 'page-together-cache-cleanup' });
  navigator.serviceWorker.addEventListener('controllerchange', cleanup);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') cleanup(); });
  void navigator.serviceWorker.ready.then(cleanup);
}
