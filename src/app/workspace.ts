import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { NoopLogger } from '@blocksuite/affine/global/utils';
import {
  AwarenessStore, StoreContainer,
  type Doc, type DocMeta, type DocsPropertiesMeta, type GetStoreOptions,
  type RemoveStoreOptions, type Store, Text, type Workspace, type WorkspaceMeta, type YBlock,
} from '@blocksuite/affine/store';
import { BlobEngine } from '@blocksuite/affine/sync';
import { FeatureFlagService, WriterInfoServiceExtension } from '@blocksuite/affine/shared/services';
import { Subject } from 'rxjs';
import { signal } from '@preact/signals-core';
import { Awareness } from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import { canEdit, type DocumentInfo, type Member } from '../../shared/protocol';
import { api, RequestError } from './api';
import { LocalPersistence, type CachedBlob } from './local';
import { DocumentSync } from './sync';
import { CatalogRefresh } from './catalog';
import { OfflineBlobSource } from './blobs';
import { NativeBlobEngine } from '../editor/blob-engine';
import { ClipboardWhitespaceExtension } from '../editor/clipboard-extension';
import { hasDocumentHistory } from '../../shared/native-document';
import { footnoteReferences, nativeAttachmentKeys } from '../../shared/content-references';

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

export class ProductionDoc implements Doc {
  readonly spaceDoc: Y.Doc;
  readonly rootDoc: Y.Doc;
  readonly awarenessStore: AwarenessStore;
  readonly yBlocks: Y.Map<YBlock>;
  readonly sync: DocumentSync;
  private container: StoreContainer;
  private stores = new Set<Store>();
  private preparation?: Promise<void>;
  private importingSnapshot = false;
  ready = false;
  loaded = false;
  constructor(readonly workspace: ProductionWorkspace, readonly record: DocumentInfo, private creation?: Promise<unknown>) {
    this.spaceDoc = new Y.Doc({ guid: record.id });
    this.rootDoc = workspace.doc;
    this.awarenessStore = new AwarenessStore(new Awareness(this.spaceDoc));
    this.awarenessStore.setLocalStateField('user', { name: workspace.member.nickname });
    this.awarenessStore.awareness.setLocalStateField('memberId', workspace.member.id);
    this.yBlocks = this.spaceDoc.getMap('blocks');
    this.container = new StoreContainer(this);
    this.sync = new DocumentSync(this.spaceDoc, { docId: record.id, epoch: workspace.epoch, generation: record.generation }, workspace.local, workspace.member.accessRevision, this.awarenessStore.awareness, creation);
    this.sync.presence!.onChange = () => workspace.presenceChanged();
    this.sync.onState = () => { workspace.changed(); workspace.blobs.schedule(); };
    this.sync.onAccess = member => workspace.updateAccess(member);
    this.sync.beforePush = async () => {
      const keys = this.blobKeys();
      return !(await workspace.local.blobs(workspace.epoch, true)).some(row => keys.has(row.blobKey)) && ![...workspace.blobs.memory.values()].some(row => !row.saved && keys.has(row.blobKey));
    };
    this.sync.onCatalog = () => void workspace.refresh().catch(error => workspace.report(error));
  }
  get id() { return this.record.id; }
  blobKeys() { return nativeAttachmentKeys(this.yBlocks); }
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
  async ensureInitialized() {
    await this.prepare(); await this.sync.settled();
    if ([...this.yBlocks.values()].some(block => block.get('sys:flavour') === 'affine:page')) return;
    if (!navigator.onLine || !canEdit(this.workspace.member.role)) throw new Error('文档初始化中断，请联网后由编辑或管理成员重新打开');
    if (this.sync.isBlocked || this.sync.hasStorageFailure || this.workspace.getDoc(this.id) !== this) throw new Error('请先保留离线稿并核验当前权限和保存状态');
    // Read the latest authority before deciding whether this is truly empty.
    await this.sync.readQuery(true); await this.sync.settled();
    if ([...this.yBlocks.values()].some(block => block.get('sys:flavour') === 'affine:page')) return;
    if (hasDocumentHistory(this.spaceDoc)) throw new Error('文档已有内容但缺少正文，请保留原稿后人工恢复');
    await api(`documents/${this.id}/initialize`, 'POST', { ...this.sync.scope, accessRevision: this.workspace.member.accessRevision });
    await this.sync.readQuery(true); await this.sync.settled();
  }
  getStore(options: GetStoreOptions = {}) {
    const store = this.container.getStore({ ...options, id: options.id ?? this.id, readonly: options.readonly ?? !canEdit(this.workspace.member.role), extensions: [...this.workspace.extensions, ...options.extensions ?? [],
      WriterInfoServiceExtension({ getWriterInfo: () => this.importingSnapshot ? null : { id: this.workspace.member.id, name: this.workspace.member.nickname } })] });
    const flags = store.get(FeatureFlagService);
    for (const flag of ['enable_advanced_block_visibility', 'enable_callout', 'enable_database_number_formatting', 'enable_block_query'] as const) if (!flags.getFlag(flag)) flags.setFlag(flag, true);
    this.stores.add(store); return store;
  }
  async importSnapshot<T>(apply: () => Promise<T>) {
    // Native block creation otherwise stamps over the source's historical metadata.
    this.importingSnapshot = true;
    try { return await apply(); } finally { this.importingSnapshot = false; }
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
  private queryUsers = 0;
  private queryTimer?: ReturnType<typeof setTimeout>;
  private querying = false;
  private disposed = false;
  readonly queryState = signal('正在读取待办来源');
  private pendingCreations = new Set<string>();
  private catalog = new CatalogRefresh(() => api<DocumentInfo[]>('documents'), records => this.applyCatalog(records));
  readonly id = 'main';
  readonly doc = new Y.Doc({ guid: 'main' });
  readonly docs = new Map<string, ProductionDoc>();
  readonly retired = new Set<ProductionDoc>();
  readonly records = new Map<string, DocumentInfo>();
  readonly slots = { docListUpdated: new Subject<void>() };
  readonly meta: WorkspaceMetaAdapter;
  readonly extensions = [...new StoreExtensionManager(getInternalStoreExtensions()).get('store'), ClipboardWhitespaceExtension];
  readonly local: LocalPersistence;
  readonly blobSync: BlobEngine;
  readonly blobs: OfflineBlobSource;
  idGenerator = () => crypto.randomUUID();
  changed = () => {};
  presenceChanged = () => {};
  accessChanged = (_member: Member) => {};
  report = (_error: unknown) => {};
  constructor(public member: Member, readonly epoch: string, records: DocumentInfo[]) {
    this.local = new LocalPersistence(member.id);
    this.meta = new WorkspaceMetaAdapter(this);
    this.blobs = new OfflineBlobSource(this);
    this.blobSync = new NativeBlobEngine(this.blobs, [], new NoopLogger());
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
    this.pendingCreations.add(id); this.catalog.invalidate();
    const creation = api<DocumentInfo>('documents', 'POST', { id, title: record.title }).finally(() => { this.pendingCreations.delete(id); this.catalog.invalidate(); });
    const doc = this.attach(record, creation);
    this.cacheCatalog(); this.slots.docListUpdated.next(); return doc;
  }
  getDoc(id: string) { return this.docs.get(id) ?? null; }
  watchQueries() {
    this.queryUsers++;
    void this.refreshQueries();
    return () => { if (--this.queryUsers === 0) clearTimeout(this.queryTimer); };
  }
  async editQuerySource(id: string, change: (store: Store) => void) {
    if (navigator.onLine) {
      const session = await api<{ member: Member; epoch: string }>('session');
      if (session.member.id !== this.member.id || session.epoch !== this.epoch) throw new Error('请先恢复当前成员身份');
      this.updateAccess(session.member); await this.refresh();
    }
    const doc = this.docs.get(id);
    if (!doc || !canEdit(this.member.role)) throw new Error('来源已删除或当前没有编辑权限');
    await doc.prepare(); await doc.sync.settled();
    const reason = await this.local.checkAccess(doc.sync.scope, this.member.accessRevision);
    if (reason || this.docs.get(id) !== doc || doc.sync.isBlocked || doc.sync.hasStorageFailure || !canEdit(this.member.role)) throw new Error(reason || '来源状态已变化，请保留离线稿并重新核验');
    const store = doc.getStore(); store.captureSync(); change(store);
    await doc.sync.settled();
  }
  private async refreshQueries() {
    if (this.querying || this.disposed || !this.queryUsers) return;
    this.querying = true; clearTimeout(this.queryTimer);
    let unavailable = 0;
    const online = navigator.onLine;
    let cachedOnly = !online;
    try {
      if (online) try { await this.refresh(); } catch (error) {
        if (error instanceof RequestError && [401, 403, 409].includes(error.status)) throw error;
        // An available network interface does not mean this server is reachable.
        // Read only locally authorized caches when catalog verification fails.
        cachedOnly = true;
      }
      for (const doc of this.docs.values()) {
        if (this.disposed || !this.queryUsers) return;
        if (!cachedOnly && doc.sync.queryRevision === doc.record.revision && !doc.sync.isBlocked) continue;
        try { await doc.sync.readQuery(!cachedOnly); } catch { unavailable++; }
      }
      this.queryState.value = !cachedOnly
        ? unavailable ? `${unavailable} 篇来源暂时无法读取，汇总可能不完整` : `已核对 ${this.docs.size} 篇文档的待办`
        : online ? '来源核验暂时失败，当前仅显示本机已缓存且仍可读取的文档' : '离线汇总仅包含此设备已缓存且仍可读取的文档';
    } catch { this.queryState.value = '来源核验暂时失败，汇总可能不完整，请联网后重试'; }
    finally {
      this.querying = false;
      if (!this.disposed && this.queryUsers) this.queryTimer = setTimeout(() => void this.refreshQueries(), 3000);
    }
  }
  updateAccess(member: Member) {
    this.member = member;
    for (const doc of this.docs.values()) { doc.setReadonly(!canEdit(member.role)); doc.sync.presence?.identity(member); }
    this.accessChanged(member); this.changed();
  }
  blobScope(key: string) {
    for (const doc of this.docs.values()) if (!doc.sync.isBlocked && doc.blobKeys().has(key)) return doc.sync.scope;
    return undefined;
  }
  blobMetadata(key: string) {
    for (const doc of [...this.docs.values(), ...this.retired]) for (const block of doc.yBlocks.values()) if (block.get('prop:sourceId') === key) {
      const name = block.get('prop:name'), type = block.get('prop:type');
      return { name: typeof name === 'string' ? name : undefined, type: typeof type === 'string' ? type : undefined };
    }
    for (const doc of [...this.docs.values(), ...this.retired]) for (const reference of footnoteReferences(doc.yBlocks)) if (reference.type === 'attachment' && reference.blobId === key) {
      const name = reference.fileName, type = reference.fileType;
      return { name: typeof name === 'string' ? name : undefined, type: typeof type === 'string' ? type : undefined };
    }
    return {};
  }
  uploaded() { for (const doc of this.docs.values()) if (doc.loaded || doc.ready) void doc.sync.retryLocalSave(); }
  private attachmentTarget(doc: ProductionDoc) {
    if (!canEdit(this.member.role) || this.docs.get(doc.id) !== doc || doc.sync.isBlocked || doc.sync.hasStorageFailure) throw new Error('请先核验编辑权限、读取当前云端文档并处理保存状态');
  }
  private appendAttachment(doc: ProductionDoc, row: { blobKey: string; data: Blob; name?: string; type?: string }) {
    this.attachmentTarget(doc);
    const store = doc.getStore(); store.load();
    if (!store.root) throw new Error('当前文档尚未加载');
    store.captureSync();
    store.transact(() => {
      const note = store.root!.children.find(block => block.flavour === 'affine:note');
      const parent = note?.id ?? store.addBlock('affine:note', {}, store.root!.id);
      store.addBlock('affine:attachment', { sourceId: row.blobKey, name: row.name || '附件', size: row.data.size, type: row.type || row.data.type || 'application/octet-stream' }, parent);
    });
    this.blobs.schedule();
  }
  async addAttachment(doc: ProductionDoc, file: File) {
    this.attachmentTarget(doc);
    const key = await this.blobSync.set(file);
    this.appendAttachment(doc, { blobKey: key, data: file, name: file.name, type: file.type });
    await doc.sync.settled();
  }
  async resubmitAttachment(doc: ProductionDoc, row: CachedBlob) {
    await this.blobs.session(true); await this.refresh(); this.attachmentTarget(doc);
    if (await this.local.checkAccess(doc.sync.scope, this.member.accessRevision)) throw new Error('请先保留离线稿并读取当前云端文档，再重新提交附件');
    const record = await this.blobs.resubmit(row, doc.sync.scope);
    this.appendAttachment(doc, record); await doc.sync.settled();
    if (doc.sync.hasStorageFailure) throw new Error('附件已保存，但正文仍在内存，请保留页面并重试本机保存');
  }
  async appendDraftText(doc: ProductionDoc, text: string) {
    if (!text.trim() || text.length > 100_000) throw new Error('请填写要合入的文字，单次最多 10 万字');
    const session = await api<{ member: Member; epoch: string }>('session');
    if (session.member.id !== this.member.id || session.epoch !== this.epoch || !canEdit(session.member.role)) throw new Error('请先核验当前身份和编辑权限');
    await this.refresh();
    if (this.docs.get(doc.id) !== doc || doc.sync.isBlocked || doc.sync.hasStorageFailure || session.member.accessRevision !== this.member.accessRevision) throw new Error('请先重试保存或保留离线稿并读取云端，再进行人工合并');
    await doc.sync.settled();
    await this.local.draft(doc.sync.scope, Y.encodeStateAsUpdate(doc.spaceDoc));
    if (this.docs.get(doc.id) !== doc || doc.sync.isBlocked || doc.sync.hasStorageFailure || !canEdit(this.member.role)) throw new Error('当前权限或保存状态已变化，原稿已保留，请重新核验后合并');
    const store = doc.getStore(); store.load();
    if (!store.root) throw new Error('当前文档尚未加载');
    store.captureSync();
    store.transact(() => {
      const note = store.root!.children.find(block => block.flavour === 'affine:note');
      const parent = note?.id ?? store.addBlock('affine:note', {}, store.root!.id);
      for (const line of text.split('\n')) store.addBlock('affine:paragraph', { text: new Text(line) }, parent);
    });
    await doc.sync.settled();
    if (doc.sync.hasStorageFailure) throw new Error('合并内容仍在内存，请保留页面并重试本机保存或导出');
  }
  async reopenCloud(doc: ProductionDoc) {
    await doc.sync.pause('旧稿已保留供导出，不会自动上传');
    await doc.sync.settled();
    await this.local.isolate(doc.sync.scope);
    this.retired.add(doc); doc.setReadonly(true);
    return this.attach(doc.record);
  }
  removeDoc(id: string) {
    if (this.member.role !== 'manage') throw new Error('仅管理者可以删除整篇文档');
    void api('documents/' + id + '/trash', 'POST').then(() => this.refresh()).catch(error => this.report(error));
  }
  catalogChanged = () => {};
  refresh() { return this.catalog.refresh(); }
  private applyCatalog(records: DocumentInfo[]) {
    let catalogChanged = false;
    const active = new Set(records.map(row => row.id));
    for (const [id, doc] of this.docs) if (!active.has(id) && !this.pendingCreations.has(id)) {
      // Retain memory and the persisted draft; stop this document's uploads.
      this.retire(doc, '文档已删除，停止同步。本机内容与离线稿仍可导出');
      this.docs.delete(id); this.records.delete(id); this.meta.docMetaRemoved.next(id); catalogChanged = true;
    }
    for (const record of records) {
      const previous = this.records.get(record.id);
      if (!previous) { this.attach(record); catalogChanged = true; }
      else if (previous.generation > record.generation) continue;
      else if (previous.generation === record.generation) Object.assign(previous, record);
      else {
        this.retire(this.docs.get(record.id)!, '文档已恢复为新代际，旧离线稿保留，请从目录重新打开文档');
        this.attach(record); catalogChanged = true;
      }
    }
    this.cacheCatalog(); this.meta.docMetaUpdated.next(); this.slots.docListUpdated.next();
    if (catalogChanged) this.catalogChanged();
    this.changed(); void this.blobs.flush();
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
    this.disposed = true; clearTimeout(this.queryTimer);
    this.blobs.dispose();
    const docs = [...this.docs.values(), ...this.retired];
    for (const doc of docs) doc.dispose();
    this.doc.destroy();
    void Promise.allSettled([this.blobs.settled(), ...docs.map(doc => doc.sync.settled())]).then(() => this.local.close()).catch(this.report);
    this.slots.docListUpdated.complete();
  }
}
