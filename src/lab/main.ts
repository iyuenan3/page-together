import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { AdapterPanel } from '@blocksuite/affine/fragments/adapter-panel';
import { FramePanel } from '@blocksuite/affine/fragments/frame-panel';
import { OutlinePanel } from '@blocksuite/affine/fragments/outline';
import { AffineSchemas } from '@blocksuite/affine/schemas';
import { FeatureFlagService } from '@blocksuite/affine/shared/services';
import { Text, type Store } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import type { DocMode } from '@blocksuite/affine/model';
import '@toeverything/theme/style.css';
import 'katex/dist/katex.min.css';
import { EditorLab } from './editor';
import { ClipboardWhitespaceExtension } from '../editor/clipboard-extension';
import './style.css';

// This upstream test utility belongs only to the lab. Production must implement
// Workspace/Doc with authenticated sources and verified durable restoration.
const workspace = new TestWorkspace();
workspace.storeExtensions = [...new StoreExtensionManager(
  getInternalStoreExtensions()
).get('store'), ClipboardWhitespaceExtension];
workspace.meta.initialize();
workspace.start();

function createDocument(title: string): Store {
  const store = workspace.createDoc().getStore();
  store.load(() => {
    const root = store.addBlock('affine:page', { title: new Text(title) });
    store.addBlock('affine:surface', {}, root);
    const note = store.addBlock('affine:note', {}, root);
    store.addBlock(
      'affine:paragraph',
      { text: new Text('在这里共同记录、整理和创作。') },
      note
    );
    store.addBlock(
      'affine:paragraph',
      { text: new Text('输入 / 打开原生块菜单，或切换到画板体验图形和绘图。') },
      note
    );
  });
  store.get(FeatureFlagService).setFlag('enable_advanced_block_visibility', true);
  store.get(FeatureFlagService).setFlag('enable_callout', true);
  store.resetHistory();
  return store;
}

let current = createDocument('pageTogether 编辑器验证');
const documents = () => Array.from(workspace.docs.values(), doc => doc.getStore());
let mode: DocMode = 'page';
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <aside class="sidebar">
    <div class="brand">pageTogether</div>
    <p class="stage">本地编辑器验证</p>
    <button id="new-doc" class="new-doc">＋ 新建验证文档</button>
    <nav id="documents" aria-label="文档"></nav>
    <p class="lab-note">此页仅用于验证编辑器。内容留在当前内存，刷新后重新开始。</p>
    <details class="capabilities"><summary>已注册的原生模型</summary><ul id="schemas"></ul></details>
  </aside>
  <main class="main">
    <header class="toolbar">
      <div class="mode-tabs" role="group" aria-label="编辑模式">
        <button id="page-mode" aria-pressed="true">正文</button>
        <button id="edgeless-mode" aria-pressed="false">画板</button>
      </div>
      <div class="panel-tools" role="group" aria-label="原生面板">
        <button id="outline-panel">大纲</button>
        <button id="frame-panel">画框</button>
        <button id="adapter-panel">格式</button>
      </div>
      <span class="version">0.22.4 · 内存验证</span>
    </header>
    <div class="work-area">
      <div id="editor-region" class="editor-region"></div>
      <aside id="panel-region" class="native-panel" hidden>
        <div class="panel-heading"><span id="panel-title"></span><button id="close-panel" aria-label="关闭面板">×</button></div>
        <div id="panel-content"></div>
      </aside>
    </div>
  </main>`;

const editor = new EditorLab();
document.querySelector('#editor-region')!.append(editor);
type PanelKind = 'outline' | 'frame' | 'adapter';
let openPanel: PanelKind | undefined;

function updatePanel() {
  if (!openPanel || !editor.std) return;
  const content = document.querySelector('#panel-content')!;
  if (openPanel === 'adapter') {
    const panel = new AdapterPanel();
    panel.store = current;
    content.replaceChildren(panel);
  } else if (openPanel === 'outline') {
    const panel = new OutlinePanel();
    panel.editor = editor.std.host;
    content.replaceChildren(panel);
  } else if (mode === 'edgeless') {
    const panel = new FramePanel();
    panel.host = editor.std.host;
    content.replaceChildren(panel);
  } else {
    content.textContent = '切换到画板后查看原生画框面板。';
  }
}

function showPanel(kind: PanelKind) {
  openPanel = kind;
  document.querySelector<HTMLDivElement>('#panel-region')!.hidden = false;
  document.querySelector('#panel-title')!.textContent = { outline: '原生大纲', frame: '原生画框', adapter: '原生格式面板' }[kind];
  updatePanel();
}

function selectDocument(store: Store) {
  store.load();
  store.get(FeatureFlagService).setFlag('enable_advanced_block_visibility', true);
  store.get(FeatureFlagService).setFlag('enable_callout', true);
  current = store;
  editor.setContext(current, mode);
  renderDocuments();
}

function renderDocuments() {
  const nav = document.querySelector('#documents')!;
  nav.replaceChildren(
    ...documents().map(store => {
      const button = document.createElement('button');
      button.textContent = store.meta?.title || '无标题';
      button.className = store === current ? 'document active' : 'document';
      button.onclick = () => selectDocument(store);
      return button;
    })
  );
}

function setMode(value: DocMode) {
  mode = value;
  document.querySelector('#page-mode')!.setAttribute('aria-pressed', String(mode === 'page'));
  document.querySelector('#edgeless-mode')!.setAttribute('aria-pressed', String(mode === 'edgeless'));
  editor.setContext(current, mode);
}

document.querySelector<HTMLButtonElement>('#new-doc')!.onclick = () => {
  const store = createDocument(`验证文档 ${workspace.docs.size + 1}`);
  selectDocument(store);
};
document.querySelector<HTMLButtonElement>('#page-mode')!.onclick = () => setMode('page');
document.querySelector<HTMLButtonElement>('#edgeless-mode')!.onclick = () => setMode('edgeless');
editor.addEventListener('mode-change', event => setMode((event as CustomEvent<DocMode>).detail));
editor.addEventListener('doc-change', event => {
  const store = workspace.getDoc((event as CustomEvent<string>).detail)?.getStore();
  if (store) selectDocument(store);
});
editor.addEventListener('context-ready', updatePanel);
document.querySelector<HTMLButtonElement>('#outline-panel')!.onclick = () => showPanel('outline');
document.querySelector<HTMLButtonElement>('#frame-panel')!.onclick = () => showPanel('frame');
document.querySelector<HTMLButtonElement>('#adapter-panel')!.onclick = () => showPanel('adapter');
document.querySelector<HTMLButtonElement>('#close-panel')!.onclick = () => {
  openPanel = undefined;
  document.querySelector<HTMLDivElement>('#panel-region')!.hidden = true;
  document.querySelector('#panel-content')!.replaceChildren();
};
workspace.slots.docListUpdated.subscribe(renderDocuments);

document.querySelector('#schemas')!.replaceChildren(
  ...AffineSchemas.map(schema => {
    const item = document.createElement('li');
    item.textContent = schema.model.flavour;
    return item;
  })
);
selectDocument(current);

window.addEventListener('pagehide', () => workspace.forceStop(), { once: true });
