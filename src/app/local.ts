import { openDB } from 'idb';
import * as Y from 'yjs';
import type { DocumentScope } from '../../shared/protocol';

export const scopeKey = (scope: DocumentScope) => `${scope.epoch}:${scope.generation}:${scope.docId}`;
export class LocalPersistence {
  private database;
  constructor(readonly memberId: string) {
    this.database = openDB('page-together-v1-' + memberId, 1, {
      upgrade(db) {
        db.createObjectStore('documents');
        const updates = db.createObjectStore('updates', { keyPath: 'id' });
        updates.createIndex('scope', 'scope');
        db.createObjectStore('drafts', { keyPath: 'id' });
        db.createObjectStore('blobs', { keyPath: 'key' });
      },
    });
  }
  async load(scope: DocumentScope): Promise<Uint8Array | undefined> {
    return (await this.database).get('documents', scopeKey(scope));
  }
  async persist(scope: DocumentScope, update: Uint8Array, local: boolean) {
    const db = await this.database;
    const tx = db.transaction(['documents', 'updates'], 'readwrite', { durability: 'strict' });
    const key = scopeKey(scope), previous = await tx.objectStore('documents').get(key) as Uint8Array | undefined;
    await tx.objectStore('documents').put(previous ? Y.mergeUpdates([previous, update]) : update, key);
    if (local) await tx.objectStore('updates').put({ id: crypto.randomUUID(), scope: key, update });
    await tx.done;
  }
  async pending(scope: DocumentScope): Promise<{ id: string; update: Uint8Array }[]> {
    return (await this.database).getAllFromIndex('updates', 'scope', scopeKey(scope));
  }
  async acknowledge(ids: string[]) {
    const tx = (await this.database).transaction('updates', 'readwrite', { durability: 'strict' });
    for (const id of ids) await tx.store.delete(id);
    await tx.done;
  }
  async draft(scope: DocumentScope, data: Uint8Array) {
    const db = await this.database;
    const tx = db.transaction('drafts', 'readwrite', { durability: 'strict' });
    await tx.store.put({ id: crypto.randomUUID(), scope: scopeKey(scope), data, createdAt: Date.now() });
    await tx.done;
  }
  async drafts(): Promise<{ id: string; scope: string; data: Uint8Array; createdAt: number }[]> {
    return (await this.database).getAll('drafts');
  }
  async documents(): Promise<{ scope: string; data: Uint8Array }[]> {
    const db = await this.database, tx = db.transaction('documents');
    const keys = await tx.store.getAllKeys(), values = await tx.store.getAll();
    await tx.done;
    return keys.map((key, index) => ({ scope: String(key), data: values[index] }));
  }
  async setBlob(epoch: string, key: string, data: Blob, saved = false) {
    const tx = (await this.database).transaction('blobs', 'readwrite', { durability: 'strict' });
    const previous = await tx.store.get(epoch + ':' + key);
    await tx.store.put({ key: epoch + ':' + key, blobKey: key, epoch, data, saved: saved || previous?.saved === true });
    await tx.done;
  }
  async getBlob(epoch: string, key: string): Promise<Blob | null> {
    return (await (await this.database).get('blobs', epoch + ':' + key))?.data ?? null;
  }
  async blobs(epoch: string, pendingOnly = false): Promise<{ key: string; blobKey: string; epoch: string; data: Blob; saved: boolean }[]> {
    return (await (await this.database).getAll('blobs')).filter(row => row.epoch === epoch && (!pendingOnly || !row.saved));
  }
  async acknowledgeBlob(epoch: string, key: string) {
    const tx = (await this.database).transaction('blobs', 'readwrite', { durability: 'strict' });
    const record = await tx.store.get(epoch + ':' + key);
    if (record) { record.saved = true; await tx.store.put(record); }
    await tx.done;
  }
  async close() { (await this.database).close(); }
}
