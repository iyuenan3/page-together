import { openDB } from 'idb';
import * as Y from 'yjs';
import type { DocumentScope } from '../../shared/protocol.js';

export interface CachedBlob {
  key: string; blobKey: string; epoch: string; data: Blob; saved: boolean;
  id?: string; name?: string; type?: string; createdAt?: number;
  accessRevision?: number; blockedReason?: string; scope?: DocumentScope;
}
export interface ArchivedBlob extends CachedBlob { archiveId: string; archivedAt: number }
export const scopeKey = (scope: DocumentScope) => `${scope.epoch}:${scope.generation}:${scope.docId}`;
// Observe transaction failure immediately, including when an awaited request fails first.
function observed<T extends { done: Promise<void> }>(transaction: T): T { void transaction.done.catch(() => {}); return transaction; }
export class LocalPersistence {
  private database;
  constructor(readonly memberId: string) {
    this.database = openDB('page-together-v1-' + memberId, 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('documents');
          const updates = db.createObjectStore('updates', { keyPath: 'id' });
          updates.createIndex('scope', 'scope');
          db.createObjectStore('drafts', { keyPath: 'id' });
          db.createObjectStore('blobs', { keyPath: 'key' });
        }
        if (oldVersion < 2) db.createObjectStore('access');
        if (oldVersion < 3) db.createObjectStore('blobDrafts', { keyPath: 'archiveId' });
      },
    });
  }
  async load(scope: DocumentScope): Promise<Uint8Array | undefined> {
    return (await this.database).get('documents', scopeKey(scope));
  }
  async persist(scope: DocumentScope, update: Uint8Array, local: boolean) {
    const db = await this.database;
    const tx = observed(db.transaction(['documents', 'updates'], 'readwrite', { durability: 'strict' }));
    const key = scopeKey(scope), previous = await tx.objectStore('documents').get(key) as Uint8Array | undefined;
    await tx.objectStore('documents').put(previous ? Y.mergeUpdates([previous, update]) : update, key);
    if (local) await tx.objectStore('updates').put({ id: crypto.randomUUID(), scope: key, update });
    await tx.done;
  }
  async pending(scope: DocumentScope): Promise<{ id: string; update: Uint8Array }[]> {
    return (await this.database).getAllFromIndex('updates', 'scope', scopeKey(scope));
  }
  async checkAccess(scope: DocumentScope, revision: number): Promise<string | undefined> {
    const tx = observed((await this.database).transaction(['access', 'updates'], 'readwrite', { durability: 'strict' }));
    const key = scopeKey(scope), previous = await tx.objectStore('access').get(key) as { revision: number; reason?: string } | undefined;
    const pending = await tx.objectStore('updates').index('scope').count(key);
    const reason = previous?.reason ?? (pending && previous?.revision !== revision ? '成员权限记录已变化或尚未核验，离线稿保留，暂停上传' : undefined);
    await tx.objectStore('access').put({ revision, reason }, key);
    await tx.done;
    return reason;
  }
  async block(scope: DocumentScope, reason: string) {
    const tx = observed((await this.database).transaction('access', 'readwrite', { durability: 'strict' }));
    const key = scopeKey(scope), previous = await tx.store.get(key);
    await tx.store.put({ ...previous, reason }, key); await tx.done;
  }
  async blockPending(reason: string) {
    const tx = observed((await this.database).transaction(['access', 'updates', 'blobs'], 'readwrite', { durability: 'strict' }));
    const updates = await tx.objectStore('updates').getAll() as { scope: string }[];
    for (const key of new Set(updates.map(row => row.scope))) {
      const previous = await tx.objectStore('access').get(key);
      await tx.objectStore('access').put({ ...previous, reason }, key);
    }
    for (const blob of await tx.objectStore('blobs').getAll()) if (!blob.saved) {
      await tx.objectStore('blobs').put({ ...blob, blockedReason: reason });
    }
    await tx.done;
  }
  async isolate(scope: DocumentScope) {
    // Publish the complete old draft before removing it from the upload queue.
    const tx = observed((await this.database).transaction(['documents', 'updates', 'drafts', 'access'], 'readwrite', { durability: 'strict' }));
    const key = scopeKey(scope), data = await tx.objectStore('documents').get(key);
    const access = await tx.objectStore('access').get(key);
    if (data) await tx.objectStore('drafts').put({ id: crypto.randomUUID(), scope: key, data, createdAt: Date.now(), reason: access?.reason });
    for (const id of await tx.objectStore('updates').index('scope').getAllKeys(key)) await tx.objectStore('updates').delete(id);
    await tx.objectStore('documents').delete(key);
    await tx.objectStore('access').delete(key);
    await tx.done;
  }
  async acknowledge(ids: string[]) {
    const tx = observed((await this.database).transaction('updates', 'readwrite', { durability: 'strict' }));
    for (const id of ids) await tx.store.delete(id);
    await tx.done;
  }
  async draft(scope: DocumentScope, data: Uint8Array) {
    const db = await this.database;
    const tx = observed(db.transaction('drafts', 'readwrite', { durability: 'strict' }));
    await tx.store.put({ id: crypto.randomUUID(), scope: scopeKey(scope), data, createdAt: Date.now() });
    await tx.done;
  }
  async drafts(): Promise<{ id: string; scope: string; data: Uint8Array; createdAt: number; reason?: string }[]> {
    return (await this.database).getAll('drafts');
  }
  async documents(): Promise<{ scope: string; data: Uint8Array }[]> {
    const db = await this.database, tx = observed(db.transaction('documents'));
    const keys = await tx.store.getAllKeys(), values = await tx.store.getAll();
    await tx.done;
    return keys.map((key, index) => ({ scope: String(key), data: values[index] }));
  }
  async setBlob(epoch: string, key: string, data: Blob, saved = false, accessRevision?: number, metadata: Partial<Pick<CachedBlob, 'scope' | 'name' | 'type'>> = {}) {
    const tx = observed((await this.database).transaction('blobs', 'readwrite', { durability: 'strict' }));
    const previous = await tx.store.get(epoch + ':' + key) as CachedBlob | undefined;
    const record: CachedBlob = { ...metadata, ...previous, key: epoch + ':' + key, blobKey: key, epoch, data,
      id: previous?.id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? Date.now(),
      accessRevision: previous?.accessRevision ?? accessRevision, saved: saved || previous?.saved === true };
    await tx.store.put(record);
    await tx.done;
    return record;
  }
  async getBlob(epoch: string, key: string): Promise<Blob | null> {
    return (await (await this.database).get('blobs', epoch + ':' + key))?.data ?? null;
  }
  async blobs(epoch?: string, pendingOnly = false): Promise<CachedBlob[]> {
    return (await (await this.database).getAll('blobs')).filter(row => (!epoch || row.epoch === epoch) && (!pendingOnly || !row.saved));
  }
  async acknowledgeBlob(epoch: string, key: string, expectedId?: string) {
    const tx = observed((await this.database).transaction('blobs', 'readwrite', { durability: 'strict' }));
    const record = await tx.store.get(epoch + ':' + key);
    const matches = record && (!expectedId || record.id === expectedId);
    if (matches) { record.saved = true; await tx.store.put(record); }
    await tx.done;
    return !!matches;
  }
  async bindBlob(epoch: string, key: string, scope: DocumentScope, expectedId?: string) {
    const tx = observed((await this.database).transaction('blobs', 'readwrite', { durability: 'strict' }));
    const record = await tx.store.get(epoch + ':' + key) as CachedBlob | undefined;
    if (record && record.id === expectedId && !record.scope) { record.scope = scope; await tx.store.put(record); }
    await tx.done; return record;
  }
  async blockBlob(epoch: string, key: string, reason: string, expectedId?: string) {
    const tx = observed((await this.database).transaction('blobs', 'readwrite', { durability: 'strict' }));
    const record = await tx.store.get(epoch + ':' + key) as CachedBlob | undefined;
    if (record && (!expectedId || record.id === expectedId) && !record.saved) {
      record.blockedReason ??= reason; await tx.store.put(record);
    }
    await tx.done;
  }
  async blobDrafts(): Promise<ArchivedBlob[]> { return (await this.database).getAll('blobDrafts'); }
  async requeueBlob(original: CachedBlob, scope: DocumentScope, accessRevision: number) {
    const tx = observed((await this.database).transaction(['blobs', 'blobDrafts'], 'readwrite', { durability: 'strict' }));
    await tx.objectStore('blobDrafts').put({ ...original, archiveId: crypto.randomUUID(), archivedAt: Date.now() });
    const key = scope.epoch + ':' + original.blobKey, previous = await tx.objectStore('blobs').get(key) as CachedBlob | undefined;
    if (previous && previous.id !== original.id) await tx.objectStore('blobDrafts').put({ ...previous, archiveId: crypto.randomUUID(), archivedAt: Date.now() });
    const record: CachedBlob = { ...original, id: crypto.randomUUID(), key, epoch: scope.epoch, scope, accessRevision, blockedReason: undefined, saved: false, createdAt: Date.now() };
    await tx.objectStore('blobs').put(record); await tx.done; return record;
  }
  async close() { (await this.database).close(); }
}
