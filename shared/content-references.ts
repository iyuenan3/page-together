import * as Y from 'yjs';

/** Traverse native rich-text values without projecting Y.Text into plain strings. */
export function footnoteReferences(value: unknown): Record<string, unknown>[] {
  const pending = [value], found: Record<string, unknown>[] = [];
  const enqueue = (values: Iterable<unknown>) => { for (const value of values) pending.push(value); };
  while (pending.length) {
    const item = pending.pop();
    if (item instanceof Y.Text) enqueue(item.toDelta());
    else if (item instanceof Y.Map) enqueue(item.values());
    else if (item instanceof Y.Array) enqueue(item.toArray());
    else if (Array.isArray(item)) enqueue(item);
    else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.insert === 'string') {
        const attributes = record.attributes as { footnote?: { reference?: Record<string, unknown> } } | undefined;
        const reference = attributes?.footnote?.reference;
        if (reference && typeof reference === 'object') found.push(reference);
      }
      enqueue(Object.values(record));
    }
  }
  return found;
}

type SnapshotBlock = { props: Record<string, unknown>; children: SnapshotBlock[] };
export function snapshotAttachmentKeys(root: SnapshotBlock) {
  const keys = new Set<string>(), pending = [root];
  while (pending.length) {
    const block = pending.pop()!, key = block.props.sourceId;
    if (typeof key === 'string' && key) keys.add(key);
    for (const reference of footnoteReferences(block.props)) if (reference.type === 'attachment' && typeof reference.blobId === 'string' && reference.blobId) keys.add(reference.blobId);
    pending.push(...block.children);
  }
  return keys;
}

export function nativeAttachmentKeys(blocks: { values(): Iterable<{ get(prop: string): unknown }> }) {
  const keys = new Set<string>();
  for (const block of blocks.values()) {
    const key = block.get('prop:sourceId');
    if (typeof key === 'string' && key) keys.add(key);
  }
  for (const reference of footnoteReferences(blocks)) if (reference.type === 'attachment' && typeof reference.blobId === 'string' && reference.blobId) keys.add(reference.blobId);
  return keys;
}
