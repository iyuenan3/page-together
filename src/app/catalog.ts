/** Coalesce catalog broadcasts and discard reads spanning a local mutation. */
export class CatalogRefresh<T> {
  private running?: Promise<void>;
  private requested = false;
  private version = 0;
  constructor(private read: () => Promise<T>, private apply: (records: T) => void) {}
  invalidate() { this.version++; }
  refresh(): Promise<void> {
    this.requested = true;
    return this.running ??= this.drain().finally(() => { this.running = undefined; });
  }
  private async drain() {
    while (this.requested) {
      this.requested = false;
      const version = this.version, records = await this.read();
      if (version !== this.version) { this.requested = true; continue; }
      this.apply(records);
    }
  }
}
