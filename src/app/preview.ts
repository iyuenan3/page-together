import { AwarenessStore, StoreContainer, type Doc, type GetStoreOptions, type RemoveStoreOptions, type Store, type Workspace, type YBlock } from '@blocksuite/affine/store';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BlobEngine } from '@blocksuite/affine/sync';
import { ClipboardWhitespaceExtension } from '../editor/clipboard-extension';
import { NoopLogger } from '@blocksuite/affine/global/utils';
import { Awareness } from 'y-protocols/awareness.js';
import * as Y from 'yjs';
import { Subject } from 'rxjs';
import type { DraftRecord } from './draft-data';
import { snapshotText } from './draft-data';
import type { ProductionWorkspace } from './workspace';

/** Isolated native read-only rendering, with no sync provider or write source. */
export class SnapshotDoc implements Doc {
  readonly id = 'preview-' + crypto.randomUUID();
  readonly spaceDoc = new Y.Doc();
  readonly rootDoc = new Y.Doc();
  readonly awarenessStore = new AwarenessStore(new Awareness(this.spaceDoc));
  readonly yBlocks: Y.Map<YBlock>;
  readonly workspace: Workspace;
  readonly ready = true;
  readonly loaded = true;
  readonly meta;
  private container: StoreContainer;
  private stores = new Set<Store>();
  constructor(active: ProductionWorkspace, snapshot: DraftRecord) {
    Y.applyUpdate(this.spaceDoc, snapshot.data);
    this.yBlocks = this.spaceDoc.getMap('blocks');
    this.meta = { id: this.id, title: snapshotText(snapshot.data).title, tags: [], createDate: snapshot.createdAt ?? 0 };
    const readOnly = () => { throw new Error('离线稿预览为只读'); };
    this.workspace = {
      id: 'snapshot', doc: this.rootDoc, meta: active.meta, idGenerator: () => crypto.randomUUID(),
      docs: new Map([[this.id, this]]), slots: { docListUpdated: new Subject<void>() },
      createDoc: readOnly, removeDoc: readOnly, getDoc: id => id === this.id ? this : null, dispose: () => this.dispose(),
      blobSync: new BlobEngine({ name: 'snapshot-read-only', readonly: true,
        get: key => active.local.getBlob(snapshot.scope.epoch, key), set: readOnly, delete: readOnly,
        list: async () => (await active.local.blobs(snapshot.scope.epoch)).map(row => row.blobKey),
      }, [], new NoopLogger()),
    };
    this.container = new StoreContainer(this);
  }
  load() {}
  getStore(options: GetStoreOptions = {}) {
    const store = this.container.getStore({ ...options, id: this.id, readonly: true, extensions: [...new StoreExtensionManager(getInternalStoreExtensions()).get('store'), ClipboardWhitespaceExtension] });
    this.stores.add(store); return store;
  }
  removeStore(options: RemoveStoreOptions) { this.container.removeStore(options); }
  remove() { throw new Error('离线稿预览为只读'); }
  clear() { throw new Error('离线稿预览为只读'); }
  dispose() {
    for (const store of this.stores) store.dispose();
    this.stores.clear(); this.awarenessStore.destroy(); this.spaceDoc.destroy(); this.rootDoc.destroy();
    this.workspace.slots.docListUpdated.complete();
  }
}
