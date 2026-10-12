import * as Y from 'yjs';
import type { DocumentScope } from '../../shared/protocol.js';

export interface DraftRecord { id: string; scope: DocumentScope; data: Uint8Array; createdAt?: number; reason?: string; source: 'draft' | 'cache' | 'memory' }
export function parseScope(value: string): DocumentScope | undefined {
  const [epoch, generation, docId, extra] = value.split(':');
  return epoch && docId && extra === undefined && Number.isSafeInteger(Number(generation)) && Number(generation) > 0 ? { epoch, generation: Number(generation), docId } : undefined;
}
export function snapshotText(data: Uint8Array) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, data);
    const blocks = doc.getMap<Y.Map<unknown>>('blocks'), visited = new Set<string>(), lines: string[] = [];
    let title = '无标题';
    for (const block of blocks.values()) if (block.get('sys:flavour') === 'affine:page') title = String(block.get('prop:title') ?? '无标题');
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const block = blocks.get(id); if (!block) return;
      for (const prop of ['prop:title', 'prop:text', 'prop:caption']) {
        const value = block.get(prop);
        if ((value instanceof Y.Text || typeof value === 'string') && String(value)) lines.push(String(value));
      }
      const children = block.get('sys:children');
      if (children instanceof Y.Array) for (const child of children.toArray()) if (typeof child === 'string') visit(child);
    };
    for (const [id, block] of blocks) if (block.get('sys:flavour') === 'affine:page') visit(id);
    return { title, text: lines.join('\n') };
  } finally { doc.destroy(); }
}
/** A text aid, not a semantic merge of rich blocks or canvas objects. */
export function textDifference(older: string, current: string) {
  const difference = (left: string, right: string) => {
    const counts = new Map<string, number>();
    for (const line of right.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    return left.split('\n').filter(line => {
      const count = counts.get(line) ?? 0;
      if (count) { counts.set(line, count - 1); return false; }
      return line.trim().length > 0;
    }).join('\n');
  };
  return { draftOnly: difference(older, current), currentOnly: difference(current, older) };
}
