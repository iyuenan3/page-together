import { docLinkBaseURLMiddleware, FULL_FILE_PATH_KEY, HtmlAdapter, MarkdownAdapter, NotionHtmlAdapter, PlainTextAdapter, titleMiddleware } from '@blocksuite/affine/shared/adapters';
import { DocSnapshotSchema, extMimeMap, getAssetName, type BlockSnapshot, type DocSnapshot, type Store, type Transformer, type TransformerMiddleware } from '@blocksuite/affine/store';
import { TRANSFER_LIMITS, packTransfer, prepareTextSnapshot, relativeTransferPath, remapDocumentReferences, unpackTransfer } from '../../shared/transfer';
import { canEdit } from '../../shared/protocol';
import type { ProductionDoc, ProductionWorkspace } from './workspace';
import { attachmentKey } from './blobs';
import { ExportManager } from '@blocksuite/affine/blocks/surface';
import type { BlockStdScope } from '@blocksuite/affine/std';

const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', { fatal: true });
function safeName(name: string) { return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100) || '无标题'; }
function blob(data: Uint8Array, type = 'application/zip') { return new Blob([new Uint8Array(data).buffer], { type }); }
function save(name: string, data: Blob) {
  const url = URL.createObjectURL(data), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const textSnapshotMiddleware: TransformerMiddleware = ({ slots }) => {
  const subscription = slots.afterExport.subscribe(payload => { if (payload.type === 'page') prepareTextSnapshot(payload.snapshot.blocks); });
  return () => subscription.unsubscribe();
};
export function adapterMiddlewares(workspace: ProductionWorkspace, textOnly = false) { return [docLinkBaseURLMiddleware(workspace.id), titleMiddleware(workspace.meta.docMetas), ...textOnly ? [textSnapshotMiddleware] : []]; }
function getJob(workspace: ProductionWorkspace, store: Store, textOnly = false) { return store.getTransformer(adapterMiddlewares(workspace, textOnly)); }
function visit(block: BlockSnapshot, action: (block: BlockSnapshot) => void) { action(block); block.children.forEach(child => visit(child, action)); }
async function assetsFor(job: Transformer, snapshots: DocSnapshot[]) {
  const keys = new Set<string>();
  for (const snapshot of snapshots) visit(snapshot.blocks, block => { if (typeof block.props.sourceId === 'string' && block.props.sourceId) keys.add(block.props.sourceId); });
  for (const key of keys) {
    await job.assetsManager.readFromBlob(key);
    if (!job.assets.has(key)) throw new Error('有附件无法读取，导出已停止。请恢复附件后重试。');
  }
  return keys;
}
async function exportNative(workspace: ProductionWorkspace, docs: ProductionDoc[]) {
  if (!docs.length || docs.length > TRANSFER_LIMITS.documents) throw new Error('每次原生导出需要 1 至 100 篇文档');
  const files = new Map<string, Uint8Array>(), manifest: { key: string; path: string; type: string; name?: string }[] = [];
  for (const doc of docs) {
    await doc.prepare();
    const job = getJob(workspace, doc.getStore());
    try {
      const snapshot = job.docToSnapshot(doc.getStore());
      if (!snapshot) throw new Error('文档无法转换，导出已停止');
      const data = utf8.encode(JSON.stringify(snapshot));
      if (data.byteLength > TRANSFER_LIMITS.text) throw new Error('单篇原生文档超过 10 MB，导出已停止');
      files.set(`${safeName(snapshot.meta.title)}-${doc.id}.snapshot.json`, data);
      for (const key of await assetsFor(job, [snapshot])) {
        const asset = job.assets.get(key)!, path = `assets/${key}`;
        if (!files.has(path)) {
          files.set(path, new Uint8Array(await asset.arrayBuffer()));
          manifest.push({ key, path, type: asset.type, name: asset instanceof File ? asset.name : undefined });
        }
      }
    } finally { job[Symbol.dispose](); }
  }
  files.set('pageTogether.json', utf8.encode(JSON.stringify({ format: 1, blockSuite: '0.22.4', assets: manifest })));
  save(docs.length === 1 ? `${safeName(docs[0].record.title)}.bs.zip` : 'pageTogether.bs.zip', blob(packTransfer(files)));
}
async function exportText(workspace: ProductionWorkspace, doc: ProductionDoc, format: 'md' | 'html' | 'txt') {
  const store = doc.getStore(), job = getJob(workspace, store, true);
  try {
    const adapter = format === 'md' ? new MarkdownAdapter(job, store.provider) : format === 'html' ? new HtmlAdapter(job, store.provider) : new PlainTextAdapter(job, store.provider);
    const result = await adapter.fromDoc(store);
    if (!result) throw new Error('文档无法转换');
    if (utf8.encode(result.file).byteLength > TRANSFER_LIMITS.text) throw new Error('单篇文档超过 10 MB，导出已停止');
    const name = `${safeName(doc.record.title)}.${format}`;
    if (result.assetsIds.length) {
      const files = new Map<string, Uint8Array>([[name, utf8.encode(result.file)]]);
      for (const key of result.assetsIds) {
        await job.assetsManager.readFromBlob(key);
        const asset = job.assets.get(key);
        if (!asset) throw new Error('有附件无法读取，导出已停止');
        // Native image adapters emit assets/<name>; pathBlobIdMap also holds
        // temporary import IDs that are unrelated to the exported URL.
        files.set('assets/' + getAssetName(job.assets, key), new Uint8Array(await asset.arrayBuffer()));
      }
      save(`${safeName(doc.record.title)}.${format}.zip`, blob(packTransfer(files)));
    } else save(name, new Blob([result.file], { type: format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' }));
  } finally { job[Symbol.dispose](); }
}
function validateSnapshot(snapshot: DocSnapshot, store: Store) {
  DocSnapshotSchema.parse(snapshot);
  if (snapshot.blocks.flavour !== 'affine:page') throw new Error('原生文件没有文档根节点');
  const ids = new Set<string>();
  const validate = (block: BlockSnapshot, parent?: BlockSnapshot) => {
    const schema = store.schema.flavourSchemaMap.get(block.flavour);
    if (!schema || block.version !== undefined && block.version !== schema.version) throw new Error('文件包含不兼容的块类型或版本');
    if (ids.has(block.id) || ids.size >= 20000) throw new Error('文件包含重复块或块数量过多');
    ids.add(block.id);
    store.schema.validate(block.flavour, parent?.flavour, block.children.map(child => child.flavour));
    block.children.forEach(child => validate(child, block));
  };
  validate(snapshot.blocks);
}
async function importFiles(workspace: ProductionWorkspace, current: ProductionDoc, file: File, notion: boolean) {
  if (!navigator.onLine || !canEdit(workspace.member.role)) throw new Error('导入新文档需要联网和编辑权限');
  await workspace.blobs.session(true);
  if (file.size > TRANSFER_LIMITS.total) throw new Error('导入文件超过 100 MB');
  const isZip = file.name.toLowerCase().endsWith('.zip');
  const files = isZip ? unpackTransfer(new Uint8Array(await file.arrayBuffer())) : new Map([[file.name, new Uint8Array(await file.arrayBuffer())]]);
  if ([...files].some(([name]) => name.toLowerCase().endsWith('.zip'))) throw new Error('请先解开嵌套 ZIP，再分别导入');
  const store = current.getStore(), job = getJob(workspace, store);
  const snapshots: DocSnapshot[] = [];
  try {
    const manifestData = files.get('pageTogether.json');
    if (manifestData) {
      const manifest = JSON.parse(text.decode(manifestData));
      if (manifest.format !== 1 || manifest.blockSuite !== '0.22.4' || !Array.isArray(manifest.assets)) throw new Error('原生备份版本不兼容');
      for (const asset of manifest.assets) {
        if (typeof asset.key !== 'string' || typeof asset.path !== 'string' || typeof asset.type !== 'string' || !files.has(asset.path)) throw new Error('原生备份缺少附件');
        const data = files.get(asset.path)!;
        job.assets.set(asset.key, new File([blob(data)], typeof asset.name === 'string' ? asset.name : asset.key, { type: asset.type }));
      }
    }
    const documents = [...files].filter(([name]) => !name.startsWith('__MACOSX/') && /\.(md|markdown|html?|txt|json)$/i.test(name) && !['pageTogether.json', 'info.json'].includes(name));
    if (!documents.length || documents.length > TRANSFER_LIMITS.documents) throw new Error('每次导入需要 1 至 100 篇支持格式的文档');
    const native = documents.every(([name]) => name.endsWith('.snapshot.json') || !isZip && name.endsWith('.json'));
    if (!native && (manifestData || documents.some(([name]) => /\.json$/i.test(name)))) throw new Error('请把原生备份和其他格式分开导入');
    if (!native) {
      for (const [path, data] of files) {
        if (documents.some(([name]) => name === path)) continue;
        const key = await attachmentKey(blob(data));
        job.assets.set(key, new File([blob(data)], path.split('/').at(-1)!, { type: extMimeMap.get(path.split('.').at(-1)!) ?? '' }));
        job.assetsManager.getPathBlobIdMap().set(path, key);
      }
    }
    const pageMap = new Map(documents.map(([path]) => [path, workspace.idGenerator()]));
    for (const [path, data] of documents) {
      if (data.byteLength > TRANSFER_LIMITS.text) throw new Error('单篇文档超过 10 MB');
      let snapshot: DocSnapshot;
      if (native) snapshot = JSON.parse(text.decode(data));
      else {
        job.adapterConfigs.set(FULL_FILE_PATH_KEY, path);
        const contents = text.decode(data);
        snapshot = /\.html?$/i.test(path)
            ? await (notion ? new NotionHtmlAdapter(job, store.provider).toDocSnapshot({ file: contents, assets: job.assetsManager, pageMap: new Map([...pageMap].map(([target, id]) => [relativeTransferPath(path, target), id])), pageId: pageMap.get(path) }) : new HtmlAdapter(job, store.provider).toDocSnapshot({ file: contents, assets: job.assetsManager }))
            : /\.(md|markdown)$/i.test(path) ? await new MarkdownAdapter(job, store.provider).toDocSnapshot({ file: contents, assets: job.assetsManager }) : new PlainTextAdapter(job, store.provider).toDocSnapshot({ file: contents, assets: job.assetsManager });
        if (!snapshot.meta.title.trim() || snapshot.meta.title === 'Untitled') {
          snapshot.meta.title = path.split('/').at(-1)!.replace(/\.[^.]+$/, '');
          snapshot.blocks.props.title = { '$blocksuite:internal:text$': true, delta: [{ insert: snapshot.meta.title }] };
        }
      }
      validateSnapshot(snapshot, store); snapshots.push(snapshot);
    }
    const ids = new Map<string, string>();
    for (const snapshot of snapshots) {
      if (ids.has(snapshot.meta.id)) throw new Error('备份中有重复的文档 ID');
      ids.set(snapshot.meta.id, workspace.idGenerator());
    }
    // Validate all assets and snapshots before creating anything on the server.
    for (const snapshot of snapshots) visit(snapshot.blocks, block => {
      const key = block.props.sourceId;
      if (typeof key === 'string' && key && !job.assets.has(key)) throw new Error('导入文件缺少附件，请使用包含附件的 ZIP');
    });
    for (const [key, asset] of job.assets) {
      if (asset.size > TRANSFER_LIMITS.file || await attachmentKey(asset) !== key) throw new Error('导入附件大小或内容校验失败，未创建文档');
    }
    const created: ProductionDoc[] = [];
    for (const snapshot of snapshots) {
      const doc = workspace.createDoc(ids.get(snapshot.meta.id)!);
      await doc.prepare(); created.push(doc);
      remapDocumentReferences(snapshot.blocks, ids); snapshot.meta.id = doc.id;
      if (!canEdit(workspace.member.role) || doc.sync.isBlocked) throw new Error('权限或文档状态已变化，导入暂停，已创建内容保留供处理');
      const result = await job.snapshotToDoc(snapshot);
      if (!result || doc.yBlocks.size !== countBlocks(snapshot.blocks)) throw new Error('导入未完整完成，已创建内容保留，请检查后重试');
      workspace.meta.setDocMeta(result.id, { title: snapshot.meta.title });
    }
    return created;
  } finally { job[Symbol.dispose](); }
}
function countBlocks(block: BlockSnapshot): number { return 1 + block.children.reduce((sum, child) => sum + countBlocks(child), 0); }
type TransferOperation = { busy: boolean; message: string; views: Set<() => void> };
const operations = new WeakMap<ProductionWorkspace, TransferOperation>();
export function transferPanel(workspace: ProductionWorkspace, doc: ProductionDoc, open: (doc: ProductionDoc) => Promise<void>, scope: BlockStdScope) {
  const section = document.createElement('section'); section.className = 'transfer-controls';
  const note = document.createElement('p'); note.textContent = 'Markdown、HTML、文本用于内容交换，复杂块和附件可能无法完整保留。原生 ZIP 保留数据视图、画板、附件和包内文档引用。导入会创建新文档。';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const operation = operations.get(workspace) ?? { busy: false, message: '', views: new Set<() => void>() };
  operations.set(workspace, operation);
  const update = () => { section.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = operation.busy); status.textContent = operation.message; };
  const notify = () => { for (const view of operation.views) view(); };
  // Catalog changes can replace this panel while an import is running.
  const render = () => { if (section.isConnected) update(); else operation.views.delete(render); };
  operation.views.add(render);
  const run = async (action: () => Promise<void>) => {
    if (operation.busy) return;
    operation.busy = true; operation.message = '正在处理'; notify();
    try { await action(); operation.message = '操作已结束，请查看浏览器下载或顶部保存状态。'; }
    catch (error) { operation.message = error instanceof Error ? error.message : '处理未完成，请保留页面后重试'; }
    finally { operation.busy = false; notify(); }
  };
  const action = (name: string, callback: () => Promise<void>) => { const button = document.createElement('button'); button.textContent = name; button.onclick = () => void run(callback); return button; };
  const notion = document.createElement('input'); notion.type = 'checkbox';
  const notionLabel = document.createElement('label'); notionLabel.append(notion, '按 Notion HTML 解析');
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.md,.markdown,.html,.htm,.txt,.json,.zip'; input.hidden = true;
  input.onchange = () => { const file = input.files?.[0]; input.value = ''; if (file) void run(async () => { const imported = await importFiles(workspace, doc, file, notion.checked); await open(imported[0]); }); };
  section.append(note, action('导出 Markdown', () => exportText(workspace, doc, 'md')), action('导出 HTML', () => exportText(workspace, doc, 'html')), action('导出文本', () => exportText(workspace, doc, 'txt')), action('导出当前原生 ZIP', () => exportNative(workspace, [doc])), action('导出空间原生 ZIP', () => exportNative(workspace, [...workspace.docs.values()])), notionLabel, action('选择文件导入', async () => { input.click(); }), input, status);
  section.insertBefore(action('导出 PNG', () => scope.get(ExportManager).exportPng()), notionLabel);
  section.insertBefore(action('导出 PDF', () => scope.get(ExportManager).exportPdf()), notionLabel);
  update();
  return section;
}
