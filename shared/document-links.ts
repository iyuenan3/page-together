export interface DocumentReferenceParams {
  mode?: 'page' | 'edgeless';
  blockIds?: string[];
  elementIds?: string[];
  databaseId?: string;
  databaseRowId?: string;
  xywh?: `[${number},${number},${number},${number}]`;
}
export interface DocumentReference { pageId: string; params?: DocumentReferenceParams }

/** Keep native anchors bounded and discard malformed imported or URL parameters. */
export function referenceParams(value: unknown): DocumentReferenceParams {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>, result: DocumentReferenceParams = {};
  if (source.mode === 'page' || source.mode === 'edgeless') result.mode = source.mode;
  for (const key of ['blockIds', 'elementIds'] as const) {
    const ids = source[key];
    if (Array.isArray(ids)) {
      const valid = [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id.trim() && id.length <= 512))].slice(0, 100);
      if (valid.length) result[key] = valid;
    }
  }
  for (const key of ['databaseId', 'databaseRowId'] as const) if (typeof source[key] === 'string' && source[key].length <= 512 && source[key].trim()) result[key] = source[key];
  if (typeof source.xywh === 'string' && source.xywh.length <= 200) {
    try {
      const bound: unknown = JSON.parse(source.xywh);
      if (Array.isArray(bound) && bound.length === 4 && bound.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e9) && bound[2] > 0 && bound[3] > 0) result.xywh = JSON.stringify(bound) as DocumentReferenceParams['xywh'];
    } catch { /* Invalid bounds must not prevent opening the document. */ }
  }
  return result;
}

/** Native adapters use /workspace/main/:id; the host also accepts ?doc=:id. */
export function documentReferenceFromUrl(value: string, origin: string): DocumentReference | undefined {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return;
    const path = /^\/workspace\/main\/([^/]+)$/.exec(url.pathname);
    const pageId = path ? decodeURIComponent(path[1]) : url.pathname === '/' ? url.searchParams.get('doc') || undefined : undefined;
    if (!pageId) return;
    const source: Record<string, unknown> = Object.fromEntries(url.searchParams);
    for (const key of ['blockIds', 'elementIds']) if (typeof source[key] === 'string') source[key] = source[key].split(',').map(id => id.trim());
    const params = referenceParams(source);
    return { pageId, ...Object.keys(params).length ? { params } : {} };
  } catch { return; }
}

export function documentIdFromUrl(value: string, origin: string) { return documentReferenceFromUrl(value, origin)?.pageId; }

export function documentUrl(pageId: string, params?: DocumentReferenceParams): string {
  const query = new URLSearchParams({ doc: pageId });
  for (const [key, value] of Object.entries(referenceParams(params))) query.set(key, Array.isArray(value) ? value.join(',') : value);
  return '/?' + query.toString();
}
