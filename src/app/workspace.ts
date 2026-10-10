import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { NoopLogger } from '@blocksuite/affine/global/utils';
import {
  AwarenessStore, StoreContainer,
  type Doc, type DocMeta, type DocsPropertiesMeta, type GetStoreOptions,
  type RemoveStoreOptions, type Store, type Workspace, type WorkspaceMeta, type YBlock,
} from '@blocksuite/affine/store';
import { BlobEngine, type BlobSource } from '@blocksuite/affine/sync';
import { Subject } from 'rxjs';
import { Awareness } from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import { canEdit, type DocumentInfo, type Member } from '../../shared/protocol';
import { api, RequestError } from './api';
import { LocalPersistence } from './local';
import { DocumentSync } from './sync';

class WorkspaceMetaAdapter implements WorkspaceMeta {
  docMetaAdded = new Subject<string>();
  docMetaRemoved = new Subject<string>();
  docMetaUpdated = new Subject<void>();
  properties: DocsPropertiesMeta = {};
  constructor(private workspace: ProductionWorkspace) {}
  get docMetas(): DocMeta[] { return [...this.workspace.records.values()].map(row => ({ id: row.id, title: row.title, tags: [], createDate: row.createdAt })); }
  get docs() { return this.docMetas; }
  getDocMeta(id: string) { return this.docMetas.find(row => row.id === id); }
  addDocMeta(meta: DocMeta) { if (!this.workspace.docs.has(meta.id)) this.workspace.createDoc(meta.id); this.setDocMeta(meta.id, meta); }
  setDocMeta(id: string, props: Partial<DocMeta>) {
    const row = this.workspace.records.get(id);
    if (!row || props.title === undefined || props.title === row.title) return;
    row.title = props.title;
    this.docMetaUpdated.next(); this.workspace.cacheCatalog(); this.workspace.changed();
    const doc = this.workspace.docs.get(id);
    if (!doc || !canEdit(this.workspace.member.role)) return;
    for (const block of doc.yBlocks.values()) {
      if (block.get('sys:flavour') !== 'affine:page') continue;
      const title = block.get('prop:title');
      if (title instanceof Y.Text && title.toString() !== props.title) {
        doc.spaceDoc.transact(() => { title.delete(0, title.length); title.insert(0, props.title!); }, doc.spaceDoc.clientID);
      }
    }
  }
  removeDocMeta(id: string) { this.workspace.removeDoc(id); }
  setProperties(properties: DocsPropertiesMeta) { this.properties = properties; }
  initialize() {}
}

class OfflineBlobSource implements BlobSource {
  name = 'authenticated-indexeddb-blobs';
  private flushing = false;
  constructor(private workspace: ProductionWorkspace) {}
  get readonly() { return !canEdit(this.workspace.member.role); }
  async get(key: string) {
    const local = await this.workspace.local.getBlob(this.workspace.epoch, key);
    if (local) return local;
    const response = await fetch('/api/blobs/' + encodeURIComponent(key), { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new RequestError(response.status, 'blob_read_failed');
    const value = await response.blob();
    try { await this.workspace.local.setBlob(this.workspace.epoch, key, value, true); }
    catch (error) { this.workspace.report(error); }
    return value;
  }
  async set(key: string, value: Blob) {
    if (this.readonly) throw new Error('read_only');
    if (value.size > 50_000_000) throw new Error('单个附件不能超过 50 MB');
    await this.workspace.local.setBlob(this.workspace.epoch, key, value);
    this.workspace.changed(); void this.flush(); return key;
  }
  async delete(_key: string) { throw new Error('附件暂不永久删除'); }
  async list() { return (await this.workspace.local.blobs(this.workspace.epoch)).map(row => row.blobKey); }
  async flush() {
    if (this.flushing || this.readonly) return;
    this.flushing = true;
    try {
      const session = await api<{ epoch: string; member: Member }>('session');
      if (session.member.id !== this.workspace.local.memberId || session.epoch !== this.workspace.epoch || !canEdit(session.member.role)) return;
      for (const record of await this.workspace.local.blobs(this.workspace.epoch, true)) {
        const response = await fetch('/api/blobs/' + encodeURIComponent(record.blobKey), { method: 'PUT', credentials: 'same-origin', body: record.data });
        if (!response.ok) throw new RequestError(response.status, 'blob_upload_failed');
        await this.workspace.local.acknowledgeBlob(this.workspace.epoch, record.blobKey);
      }
    } catch (error) { this.workspace.report(error); }
    finally { this.flushing = false; this.workspace.changed(); }
  }
}

export class ProductionDoc implements Doc {
  readonly spaceDoc: Y.Doc;
  readonly rootDoc: Y.Doc;
  readonly awarenessStore: AwarenessStore;
  readonly yBlocks: Y.Map<YBlock>;
  readonly sync: DocumentSync;
  private container: StoreContainer;
  private stores = new Set<Store>();
  private preparation?: Promise<void>;
  ready = false;
  loaded = false;
  constructor(readonly workspace: ProductionWorkspace, readonly record: DocumentInfo, private creation?: Promise<unknown>) {
    this.spaceDoc = new Y.Doc({ guid: record.id });
    this.rootDoc = workspace.doc;
    this.awarenessStore = new AwarenessStore(new Awareness(this.spaceDoc));
    this.awarenessStore.setLocalStateField('user', { name: workspace.member.nickname });
    this.yBlocks = this.spaceDoc.getMap('blocks');
    this.container = new StoreContainer(this);
    this.sync = new DocumentSync(this.spaceDoc, { docId: record.id, epoch: workspace.epoch, generation: record.generation }, workspace.local);
    this.sync.onState = () => workspace.changed();
    this.sync.onAccess = member => {
      workspace.member = member;
      for (const doc of workspace.docs.values()) doc.setReadonly(!canEdit(member.role));
      workspace.accessChanged(member);
      workspace.changed();
    };
    this.sync.onCatalog = () => void workspace.refresh().catch(error => workspace.report(error));
  }
  get id() { return this.record.id; }
  get meta() { return this.workspace.meta.getDocMeta(this.id); }
  prepare() {
    return this.preparation ??= (this.creation ?? Promise.resolve()).then(() => this.sync.start(!this.creation))
      .then(() => { this.loaded = true; })
      .catch(error => { this.preparation = undefined; throw error; });
  }
  load(init?: () => void) {
    if (!this.ready) { this.ready = true; init?.(); }
    void this.prepare().catch(error => this.workspace.report(error));
  }
  getStore(options: GetStoreOptions = {}) {
    const store = this.container.getStore({ ...options, id: options.id ?? this.id, readonly: options.readonly ?? !canEdit(this.workspace.member.role), extensions: [...this.workspace.extensions, ...options.extensions ?? []] });
    this.stores.add(store); return store;
  }
  setReadonly(readonly: boolean) { for (const store of this.stores) store.readonly = readonly; }
  removeStore(options: RemoveStoreOptions) { this.container.removeStore(options); }
  clear() { if (!canEdit(this.workspace.member.role)) throw new Error('read_only'); this.yBlocks.clear(); }
  remove() { this.workspace.removeDoc(this.id); }
  dispose() {
    this.sync.stop();
    for (const store of this.stores) store.dispose();
    this.stores.clear(); this.awarenessStore.destroy(); this.spaceDoc.destroy();
  }
}

export class ProductionWorkspace implements Workspace {
  readonly id = 'main';
  readonly doc = new Y.Doc({ guid: 'main' });
  readonly docs = new Map<string, ProductionDoc>();
  readonly retired = new Set<ProductionDoc>();
  readonly records = new Map<string, DocumentInfo>();
  readonly slots = { docListUpdated: new Subject<void>() };
  readonly meta: WorkspaceMetaAdapter;
  readonly extensions = new StoreExtensionManager(getInternalStoreExtensions()).get('store');
  readonly local: LocalPersistence;
  readonly blobSync: BlobEngine;
  readonly blobs: OfflineBlobSource;
  idGenerator = () => crypto.randomUUID();
  changed = () => {};
  accessChanged = (_member: Member) => {};
  report = (_error: unknown) => {};
  constructor(public member: Member, readonly epoch: string, records: DocumentInfo[]) {
    this.local = new LocalPersistence(member.id);
    this.meta = new WorkspaceMetaAdapter(this);
    this.blobs = new OfflineBlobSource(this);
    this.blobSync = new BlobEngine(this.blobs, [], new NoopLogger());
    for (const record of records) this.attach(record);
  }
  private attach(record: DocumentInfo, creation?: Promise<unknown>) {
    this.records.set(record.id, record);
    const doc = new ProductionDoc(this, record, creation);
    this.docs.set(doc.id, doc); this.meta.docMetaAdded.next(doc.id); return doc;
  }
  createDoc(id: string = this.idGenerator()) {
    if (!canEdit(this.member.role) || !navigator.onLine) throw new Error('新建文档需要联网和编辑权限');
    if (this.docs.has(id)) return this.docs.get(id)!;
    const record: DocumentInfo = { id, title: '无标题', generation: 1, revision: 0, deleted: false, createdAt: Date.now() };
    const creation = api<DocumentInfo>('documents', 'POST', { id, title: record.title });
    const doc = this.attach(record, creation);
    this.cacheCatalog(); this.slots.docListUpdated.next(); return doc;
  }
  getDoc(id: string) { return this.docs.get(id) ?? null; }
  removeDoc(id: string) {
    if (this.member.role !== 'manage') throw new Error('仅管理者可以删除整篇文档');
    void api('documents/' + id + '/trash', 'POST').then(() => this.refresh()).catch(error => this.report(error));
  }
  async refresh() {
    const records = await api<DocumentInfo[]>('documents');
    const active = new Set(records.map(row => row.id));
    for (const [id, doc] of this.docs) if (!active.has(id)) {
      // Retain memory and the persisted draft; stop this document's uploads.
      this.retire(doc, '文档已删除，停止同步。本机内容与离线稿仍可导出');
      this.docs.delete(id); this.records.delete(id); this.meta.docMetaRemoved.next(id);
    }
    for (const record of records) {
      const previous = this.records.get(record.id);
      if (!previous) this.attach(record);
      else if (previous.generation === record.generation) Object.assign(previous, record);
      else {
        this.retire(this.docs.get(record.id)!, '文档已恢复为新代际，旧离线稿保留，请从目录重新打开文档');
        this.attach(record);
      }
    }
    this.cacheCatalog(); this.meta.docMetaUpdated.next(); this.slots.docListUpdated.next(); this.changed(); void this.blobs.flush();
  }
  private retire(doc: ProductionDoc, reason: string) {
    doc.setReadonly(true); this.retired.add(doc);
    void doc.sync.pause(reason);
  }
  cacheCatalog() {
    try { localStorage.setItem('page-together-catalog-' + this.member.id, JSON.stringify({ epoch: this.epoch, records: [...this.records.values()] })); }
    catch { this.report(new Error('本机目录保存失败')); }
  }
  dispose() {
    const docs = [...this.docs.values(), ...this.retired];
    for (const doc of docs) doc.dispose();
    this.doc.destroy();
    void Promise.allSettled(docs.map(doc => doc.sync.settled())).then(() => this.local.close()).catch(this.report);
    this.slots.docListUpdated.complete();
  }
}
