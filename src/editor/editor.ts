import { ViewExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalViewExtensions } from '@blocksuite/affine/extensions/view';
import { RefNodeSlotsProvider } from '@blocksuite/affine/inlines/reference';
import type { DocMode } from '@blocksuite/affine/model';
import { Bound } from '@blocksuite/affine/global/gfx';
import { HighlightSelection } from '@blocksuite/affine/shared/selection';
import { GfxControllerIdentifier } from '@blocksuite/affine/std/gfx';
import {
  CommunityCanvasTextFonts,
  DocModeExtension,
  EditorSettingExtension,
  FontConfigExtension,
  FileSizeLimitProvider,
  ParseDocUrlExtension,
  GenerateDocUrlExtension,
} from '@blocksuite/affine/shared/services';
import { BlockStdScope, ShadowlessElement } from '@blocksuite/affine/std';
import type { ExtensionType, Store } from '@blocksuite/affine/store';
import { signal } from '@preact/signals-core';
import { html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { Subscription } from 'rxjs';
import { MAX_ATTACHMENT_BYTES } from '../../shared/attachments';
import { documentReferenceFromUrl, documentUrl, referenceParams, type DocumentReferenceParams } from '../../shared/document-links';
import { CompleteFileDropExtension } from './file-drop-extension';
import { PdfEmbedExtension } from './pdf-embed-extension';
import { WorkspaceDataViewExtension } from './workspace-data-view';
import { FontStatusExtension } from './font-status';
import './data-view-image';

const viewManager = new ViewExtensionManager(getInternalViewExtensions());
const primaryModes = new Map<string, DocMode>();
const modeListeners = new Map<string, Set<(mode: DocMode) => void>>();

/** Native view shared by the lab and the authenticated workspace. */
export class EditorView extends ShadowlessElement {
  private store?: Store;
  private mode: DocMode = 'page';
  private scope?: BlockStdScope;
  private referenceSubscription?: Subscription;
  private navigation = 0;
  private fonts = { total: 0, loaded: 0, failed: 0 };

  constructor() {
    super();
    this.addEventListener('font-status', event => {
      if (!this.scope || event.target !== this.scope.host) return;
      this.fonts = (event as CustomEvent<typeof this.fonts>).detail;
      // A standard scope render creates a new host. Updating the badge must not
      // remount that host and restart the font loader in a feedback loop.
      const badge = this.querySelector('.canvas-font-status');
      if (badge) {
        badge.setAttribute('data-loaded', String(this.fonts.loaded)); badge.setAttribute('data-total', String(this.fonts.total));
        badge.textContent = this.fontLabel();
      }
    });
  }

  setContext(store: Store, mode: DocMode, refreshReferences = false) {
    if (this.store === store && this.mode === mode && !refreshReferences) return;
    this.navigation++;
    this.scope?.selection.clear();
    this.store = store;
    this.mode = mode;
    this.referenceSubscription?.unsubscribe();

    const setPrimaryMode = (value: DocMode, id: string) => {
      primaryModes.set(id, value);
      modeListeners.get(id)?.forEach(listener => listener(value));
    };
    const common: ExtensionType[] = [
      FontConfigExtension(CommunityCanvasTextFonts),
      EditorSettingExtension({ setting$: signal({}) }),
      ParseDocUrlExtension({
        parseDocUrl: url => {
          const reference = documentReferenceFromUrl(url, location.origin);
          return reference ? { docId: reference.pageId, ...reference.params } : undefined;
        },
      }),
      GenerateDocUrlExtension({ generateDocUrl: (id, params) => new URL(documentUrl(id, params), location.origin).href }),
      DocModeExtension({
        getEditorMode: () => this.mode,
        setEditorMode: value => {
          this.dispatchEvent(new CustomEvent('mode-change', { detail: value }));
        },
        getPrimaryMode: id => primaryModes.get(id) ?? 'page',
        setPrimaryMode,
        togglePrimaryMode: id => {
          const value = primaryModes.get(id) === 'edgeless' ? 'page' : 'edgeless';
          setPrimaryMode(value, id);
          return value;
        },
        onPrimaryModeChange: (listener, id) => {
          const listeners = modeListeners.get(id) ?? new Set();
          listeners.add(listener);
          modeListeners.set(id, listeners);
          return new Subscription(() => listeners.delete(listener));
        },
      }),
    ];
    this.scope = new BlockStdScope({
      store,
      extensions: [...viewManager.get(mode), ...common, CompleteFileDropExtension, PdfEmbedExtension, WorkspaceDataViewExtension, FontStatusExtension],
    });
    this.fonts = { total: 0, loaded: 0, failed: 0 };
    this.scope.get(FileSizeLimitProvider).maxFileSize = MAX_ATTACHMENT_BYTES;
    this.referenceSubscription = this.scope
      .get(RefNodeSlotsProvider)
      .docLinkClicked.subscribe(({ pageId, params, host }) => {
        if (host !== this.scope?.host && !this.scope?.host.contains(host)) return;
        this.dispatchEvent(new CustomEvent('doc-change', { detail: { pageId, params: referenceParams(params) } }));
      });
    this.requestUpdate();
  }

  get std() {
    return this.scope;
  }
  private fontLabel() { return this.fonts.failed ? '部分字体未加载，可能显示备用字体' : this.fonts.total && this.fonts.loaded === this.fonts.total ? '7 种原生字体已加载' : '正在加载原生字体'; }
  async focusReference(value: DocumentReferenceParams) {
    const scope = this.scope, navigation = ++this.navigation, params = referenceParams(value);
    await this.updateComplete;
    if (!scope || scope !== this.scope || navigation !== this.navigation) return;
    await scope.host.updateComplete;
    // Allow the native root, notes and anchoring widget to finish their first render.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (scope !== this.scope || navigation !== this.navigation || !this.isConnected) return;
    const mode = this.mode;
    if (params.databaseRowId) {
      const row = scope.store.getModelById(params.databaseRowId);
      const database = params.databaseId ? scope.store.getModelById(params.databaseId) : row && scope.store.getParent(row);
      if (!row || database?.flavour !== 'affine:database' || scope.store.getParent(row)?.id !== database.id) return false;
      const component = scope.view.getBlock(database.id);
      await component?.updateComplete;
      const renderer = component?.querySelector('affine-data-view-renderer');
      if (!renderer) return false;
      const manager = renderer.logic.config.dataSource.viewManager;
      const view = manager.currentView$.value;
      if (!view) return false;
      scope.selection.set([new HighlightSelection({ mode, blockIds: [database.id] })]);
      renderer.openDetailPanel({ view, rowId: row.id });
      return true;
    }
    const ids = mode === 'edgeless' ? params.elementIds ?? params.blockIds : params.blockIds;
    const id = ids?.[0] ?? params.databaseRowId ?? params.databaseId;
    if (id) {
      const exists = mode === 'edgeless' ? scope.get(GfxControllerIdentifier).getElementById(id) : scope.view.getBlock(id);
      if (!exists) return false;
      scope.selection.set([new HighlightSelection({ ...params, mode, ...mode === 'edgeless' ? { elementIds: [id] } : { blockIds: [id] } })]);
    } else if (mode === 'edgeless' && params.xywh) {
      scope.get(GfxControllerIdentifier).viewport.setViewportByBound(Bound.deserialize(params.xywh), [20, 20, 100, 20]);
    }
    return true;
  }
  override disconnectedCallback() {
    this.scope?.selection.clearRemote();
    this.referenceSubscription?.unsubscribe();
    super.disconnectedCallback();
  }

  override updated() {
    this.dispatchEvent(new Event('context-ready'));
  }

  override render() {
    if (!this.store || !this.scope) return html``;
    const page = this.mode === 'page';
    return keyed(
      `${this.store.id}:${this.mode}`,
      html`
        <div
          class=${page ? 'affine-page-viewport' : 'affine-edgeless-viewport'}
          data-theme="light"
        >
          ${page ? html`<doc-title .doc=${this.store}></doc-title>` : null}
          <div class=${page ? 'page-editor' : 'edgeless-editor-container'}>
            ${this.scope.render()}
          </div>
          ${page ? null : html`<span class="canvas-font-status" role="status" aria-label="原生字体" data-loaded=${this.fonts.loaded} data-total=${this.fonts.total}>
            ${this.fontLabel()}
          </span>`}
        </div>
      `
    );
  }
}

customElements.define('page-together-editor', EditorView);
