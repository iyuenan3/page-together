import { ViewExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalViewExtensions } from '@blocksuite/affine/extensions/view';
import { RefNodeSlotsProvider } from '@blocksuite/affine/inlines/reference';
import type { DocMode } from '@blocksuite/affine/model';
import {
  CommunityCanvasTextFonts,
  DocModeExtension,
  EditorSettingExtension,
  FontConfigExtension,
  FileSizeLimitProvider,
  ParseDocUrlExtension,
} from '@blocksuite/affine/shared/services';
import { BlockStdScope, ShadowlessElement } from '@blocksuite/affine/std';
import type { ExtensionType, Store } from '@blocksuite/affine/store';
import { signal } from '@preact/signals-core';
import { html } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { Subscription } from 'rxjs';
import { MAX_ATTACHMENT_BYTES } from '../../shared/attachments';
import { CompleteFileDropExtension } from './file-drop-extension';
import { PdfEmbedExtension } from './pdf-embed-extension';

const viewManager = new ViewExtensionManager(getInternalViewExtensions());
const primaryModes = new Map<string, DocMode>();
const modeListeners = new Map<string, Set<(mode: DocMode) => void>>();

/** Native view shared by the lab and the authenticated workspace. */
export class EditorView extends ShadowlessElement {
  private store?: Store;
  private mode: DocMode = 'page';
  private scope?: BlockStdScope;
  private referenceSubscription?: Subscription;

  setContext(store: Store, mode: DocMode) {
    if (this.store === store && this.mode === mode) return;
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
          try {
            const target = new URL(url, location.href);
            const docId = target.searchParams.get('doc');
            return target.origin === location.origin && docId
              ? { docId }
              : undefined;
          } catch {
            return undefined;
          }
        },
      }),
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
      extensions: [...viewManager.get(mode), ...common, CompleteFileDropExtension, PdfEmbedExtension],
    });
    this.scope.get(FileSizeLimitProvider).maxFileSize = MAX_ATTACHMENT_BYTES;
    this.referenceSubscription = this.scope
      .get(RefNodeSlotsProvider)
      .docLinkClicked.subscribe(({ pageId }) => {
        this.dispatchEvent(new CustomEvent('doc-change', { detail: pageId }));
      });
    this.requestUpdate();
  }

  get std() {
    return this.scope;
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
        </div>
      `
    );
  }
}

customElements.define('page-together-editor', EditorView);
