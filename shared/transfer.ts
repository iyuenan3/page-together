import { Unzip, UnzipInflate, zipSync } from 'fflate';

export const TRANSFER_LIMITS = { total: 100_000_000, file: 50_000_000, text: 10_000_000, entries: 2000, documents: 100 };
export function transferPath(name: string) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => ['..', '.', '__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('压缩包包含不安全的路径');
  return name;
}
/** Stream inflation in small input chunks; never trust ZIP's advertised size. */
export function unpackTransfer(input: Uint8Array, limits = TRANSFER_LIMITS) {
  if (input.byteLength > limits.total) throw new Error('压缩包超过导入容量限制');
  const files = new Map<string, Uint8Array>(), seen = new Set<string>();
  let total = 0, failure: Error | undefined;
  const unzip = new Unzip(file => {
    try {
      transferPath(file.name);
      if (seen.has(file.name)) throw new Error('压缩包包含重复文件');
      seen.add(file.name);
      if (seen.size > limits.entries || (file.originalSize ?? 0) > limits.file) throw new Error('压缩包超过文件数量或大小限制');
      const parts: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, data, final) => {
        if (failure) { file.terminate(); return; }
        if (error) { failure = error; file.terminate(); return; }
        total += data.byteLength; size += data.byteLength;
        if (total > limits.total || size > limits.file) { failure = new Error('解压内容超过容量限制'); file.terminate(); return; }
        parts.push(data);
        if (final && !file.name.endsWith('/')) {
          const output = new Uint8Array(size); let offset = 0;
          for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
          files.set(file.name, output);
        }
      };
      file.start();
    } catch (error) { failure = error instanceof Error ? error : new Error('压缩包无效'); file.terminate(); }
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < input.length && !failure; offset += 4096) unzip.push(input.subarray(offset, offset + 4096), offset + 4096 >= input.length);
  if (failure) throw failure;
  if (!files.size || files.size !== [...seen].filter(name => !name.endsWith('/')).length) throw new Error('压缩包为空或不完整');
  return files;
}
export function packTransfer(files: Map<string, Uint8Array>, limits = TRANSFER_LIMITS) {
  const entries: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  if (files.size > limits.entries) throw new Error('导出文件数量超过限制');
  for (const [name, data] of files) {
    transferPath(name); total += data.byteLength;
    if (data.byteLength > limits.file || total > limits.total) throw new Error('导出内容超过容量限制，请分批导出');
    entries[name] = data;
  }
  const zip = zipSync(entries, { level: 0 });
  if (zip.byteLength > limits.total) throw new Error('压缩包超过导出容量限制，请分批导出');
  return zip;
}
type SnapshotBlock = { id?: string; flavour: string; props: Record<string, unknown>; children: SnapshotBlock[] };
/** Normalize only the export copy for 0.22.4's static table adapters. */
export function prepareTextSnapshot(block: SnapshotBlock) {
  if (block.flavour === 'affine:database' && block.props.cells && typeof block.props.cells === 'object') {
    const cells = block.props.cells as Record<string, Record<string, { columnId?: string; value?: unknown }>>;
    // Native processTable always emits the title value first, even after users
    // reorder fields. Match its headers to those values.
    if (Array.isArray(block.props.columns)) {
      const columns = block.props.columns as { id: string; type: string; data?: unknown }[];
      block.props.columns = [...columns.filter(column => column.type === 'title'), ...columns.filter(column => column.type !== 'title')];
      for (const column of columns) if (column.type === 'created-time') {
        // Native static adapters omit computed properties. Materialize this one
        // as text with an explicit timezone, leaving native backup data intact.
        column.type = 'rich-text'; column.data = {};
        for (const child of block.children) {
          const createdAt = child.props['meta:createdAt'];
          if (!child.id || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
          const date = new Date(createdAt + 8 * 60 * 60 * 1000);
          if (!Number.isFinite(date.getTime())) continue;
          const value = date.toISOString().replace('T', ' ').replace('Z', ' +08:00');
          (cells[child.id] ??= {})[column.id] = { columnId: column.id, value: { '$blocksuite:internal:text$': true, delta: [{ insert: value }] } };
        }
      }
    }
    // Empty progress cells otherwise call toString on an undefined value.
    for (const row of Object.values(cells)) {
      for (const [id, cell] of Object.entries(row)) if (cell.value == null) delete row[id];
    }
  }
  block.children.forEach(prepareTextSnapshot);
}
/** Remap document references and query row document prefixes, preserving their cell values. */
export function remapDocumentReferences(block: SnapshotBlock, ids: Map<string, string>) {
  if (['affine:embed-linked-doc', 'affine:embed-synced-doc', 'affine:surface-ref'].includes(block.flavour) && typeof block.props.pageId === 'string') block.props.pageId = ids.get(block.props.pageId) ?? block.props.pageId;
  if (block.flavour === 'affine:data-view' && block.props.cells && typeof block.props.cells === 'object') {
    const key = (row: string) => { const slash = row.indexOf('/'); return slash < 0 ? row : (ids.get(row.slice(0, slash)) ?? row.slice(0, slash)) + row.slice(slash); };
    block.props.cells = Object.fromEntries(Object.entries(block.props.cells).map(([id, cells]) => [key(id), cells]));
  }
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.insert === 'string' && record.attributes && typeof record.attributes === 'object') {
      const reference = (record.attributes as Record<string, unknown>).reference as Record<string, unknown> | undefined;
      if (reference && typeof reference.pageId === 'string') reference.pageId = ids.get(reference.pageId) ?? reference.pageId;
    }
    Object.values(record).forEach(walk);
  };
  walk(block.props);
  block.children.forEach(child => remapDocumentReferences(child, ids));
}

/** Notion links are relative to the containing HTML file, including nested pages. */
export function relativeTransferPath(from: string, to: string) {
  const parent = from.split('/').slice(0, -1), target = to.split('/');
  while (parent.length && target.length && parent[0] === target[0]) { parent.shift(); target.shift(); }
  return [...parent.map(() => '..'), ...target].join('/');
}
