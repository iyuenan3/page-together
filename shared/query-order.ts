export type QueryPosition = 'start' | 'end' | { id: string; before: boolean };

/** Missing sources keep their saved place; newly discovered rows follow them. */
export function queryRowsInOrder<T>(rows: readonly T[], order: unknown, id: (row: T) => string): T[] {
  const remaining = new Map(rows.map(row => [id(row), row]));
  const result: T[] = [];
  for (const key of Array.isArray(order) ? order : []) {
    if (typeof key !== 'string') continue;
    const row = remaining.get(key);
    if (row !== undefined) { result.push(row); remaining.delete(key); }
  }
  return [...result, ...remaining.values()];
}

/** Reorder the view's keys, never the blocks in source documents. */
export function moveQueryRow(saved: unknown, live: readonly string[], row: string, position: QueryPosition): string[] | undefined {
  if (!live.includes(row) || typeof position === 'object' && (position.id === row || !live.includes(position.id))) return;
  const previous = [...new Set([...(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === 'string') : []), ...live])];
  const next = previous.filter(key => key !== row);
  const index = position === 'start' ? 0 : position === 'end' ? next.length : next.indexOf(position.id) + (position.before ? 0 : 1);
  next.splice(index, 0, row);
  return next.every((key, index) => key === previous[index]) ? undefined : next;
}
