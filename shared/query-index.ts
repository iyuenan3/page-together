/** Query rows need both document and block identity. Native imports preserve block IDs. */
export const queryRowKey = (document: { id: string }, block: { id: string }) => `${document.id}/${block.id}`;

export class QueryIndex<D extends { id: string }, B extends { id: string }> {
  private documents = new Map<D, { dispose: () => void; blocks: B[] }>();
  constructor(private options: {
    blocks: (document: D) => B[];
    subscribe: (document: D, update: () => void) => () => void;
    changed: (rows: Map<string, { doc: D; model: B }>) => void;
  }) {}
  reconcile(active: Iterable<D>) {
    const documents = new Set(active);
    for (const [doc, entry] of this.documents) if (!documents.has(doc)) { entry.dispose(); this.documents.delete(doc); }
    for (const doc of documents) {
      if (!this.documents.has(doc)) this.documents.set(doc, {
        blocks: [], dispose: this.options.subscribe(doc, () => { this.refresh(doc); this.publish(); }),
      });
      this.refresh(doc);
    }
    this.publish();
  }
  private refresh(doc: D) { const entry = this.documents.get(doc); if (entry) entry.blocks = this.options.blocks(doc); }
  private publish() {
    const rows = new Map<string, { doc: D; model: B }>();
    for (const [doc, entry] of this.documents) for (const model of entry.blocks) rows.set(queryRowKey(doc, model), { doc, model });
    this.options.changed(rows);
  }
  dispose() { for (const entry of this.documents.values()) entry.dispose(); this.documents.clear(); }
}
