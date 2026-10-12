/** Native adapters use /workspace/main/:id; the host also accepts ?doc=:id. */
export function documentIdFromUrl(value: string, origin: string): string | undefined {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return;
    const path = /^\/workspace\/main\/([^/]+)$/.exec(url.pathname);
    return path ? decodeURIComponent(path[1]) : url.pathname === '/' ? url.searchParams.get('doc') || undefined : undefined;
  } catch { return; }
}
