import assert from 'node:assert/strict';
import test from 'node:test';
import { remapDocumentReferences, packTransfer, unpackTransfer, TRANSFER_LIMITS } from '../shared/transfer.js';
import { canEdit } from '../shared/protocol.js';
import { attachmentKey } from '../src/app/blobs.js';
import * as Y from 'yjs';
import { nativeAttachmentKeys, snapshotAttachmentKeys, footnoteReferences } from '../shared/content-references.js';
import { openFootnote } from '../src/editor/footnotes.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('native migration remaps document footnotes inside rich text and preserves external references and labels', () => {
  const block = { flavour: 'affine:paragraph', props: { text: { '$blocksuite:internal:text$': true, delta: [
    { insert: ' ', attributes: { footnote: { label: '1', reference: { type: 'doc', docId: 'source', title: '原始标题' } } } },
    { insert: ' ', attributes: { footnote: { label: '2', reference: { type: 'doc', docId: 'external' } } } },
    { insert: ' ', attributes: { footnote: { label: '3', reference: { type: 'url', url: 'https://example.test/source' } } } },
  ] } }, children: [] };
  remapDocumentReferences(block, new Map([['source', 'copy']]));
  assert.equal(block.props.text.delta[0].attributes.footnote.reference.docId, 'copy');
  assert.equal(block.props.text.delta[0].attributes.footnote.label, '1');
  assert.equal(block.props.text.delta[0].attributes.footnote.reference.title, '原始标题');
  assert.equal(block.props.text.delta[1].attributes.footnote.reference.docId, 'external');
  assert.equal(block.props.text.delta[2].attributes.footnote.reference.url, 'https://example.test/source');
});

test('attachment footnotes in live native text and nested snapshot fields share the attachment inventory', () => {
  const doc = new Y.Doc(), blocks = doc.getMap<Y.Map<unknown>>('blocks'), paragraph = new Y.Map(), text = new Y.Text();
  blocks.set('paragraph', paragraph); paragraph.set('prop:text', text);
  text.insert(0, ' ', { footnote: { label: '1', reference: { type: 'attachment', blobId: 'file-key', fileName: '原件.txt' } } });
  paragraph.set('prop:sourceId', 'ordinary-key');
  assert.deepEqual([...nativeAttachmentKeys(blocks)].sort(), ['file-key', 'ordinary-key']);
  const snapshot = { props: { cells: { row: { rich: { value: { '$blocksuite:internal:text$': true, delta: text.toDelta() } } } } }, children: [{ props: { sourceId: 'ordinary-key' }, children: [] }] };
  assert.deepEqual([...snapshotAttachmentKeys(snapshot)].sort(), ['file-key', 'ordinary-key']);
  assert.equal(footnoteReferences('literal file-key').length, 0);
  doc.destroy();
});

test('footnote traversal accepts large native vectors without spreading them into a function call', () => {
  const values = Array.from({ length: 150_000 }, () => 0);
  const reference = { type: 'attachment', blobId: 'file-key' };
  const result = footnoteReferences({ values, delta: [{ insert: ' ', attributes: { footnote: { reference } } }] });
  assert.deepEqual(result, [reference]);
});

test('footnote actions route through current document and blob services and reject executable schemes', async () => {
  const events: string[] = [], data = new Blob(['完整原件']);
  const actions = { baseURL: 'https://app.example.test/', openDocument: (id: string) => events.push('doc:' + id), readAttachment: async (key: string) => { events.push('read:' + key); return data; }, download: (name: string, actual: Blob) => { assert.equal(actual, data); events.push('download:' + name); }, openURL: (url: string) => events.push('url:' + url) };
  await openFootnote({ type: 'doc', docId: 'target' }, actions);
  await openFootnote({ type: 'attachment', blobId: 'file-key', fileName: '原件.txt' }, actions);
  await openFootnote({ type: 'url', url: 'https://example.test/path' }, actions);
  assert.deepEqual(events, ['doc:target', 'read:file-key', 'download:原件.txt', 'url:https://example.test/path']);
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/file', 'vbscript:bad']) await assert.rejects(openFootnote({ type: 'url', url }, actions), /HTTP/);
  assert.equal(events.length, 4);
  await assert.rejects(openFootnote({ type: 'attachment', blobId: 'missing' }, { ...actions, readAttachment: async () => null }), /无法读取/);
  assert.equal(events.length, 4);
});

test('the production native exporter reads attachments referenced only by footnotes and refuses missing bytes', async () => {
  const file = ts.createSourceFile('transfer.ts', readFileSync('src/app/transfer.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assetsFor')!;
  const code = ts.transpile(fn.getText(file), { target: ts.ScriptTarget.ES2022 });
  const run = new Function('snapshotAttachmentKeys', code + ';return assetsFor;')(snapshotAttachmentKeys);
  const data = new Blob(['完整原件']), assets = new Map<string, Blob>(), reads: string[] = [];
  const snapshot = { blocks: { props: { text: { '$blocksuite:internal:text$': true, delta: [{ insert: ' ', attributes: { footnote: { label: '1', reference: { type: 'attachment', blobId: 'footnote-only' } } } }] } }, children: [] } };
  const job = { assets, assetsManager: { readFromBlob: async (key: string) => { reads.push(key); assets.set(key, data); } } };
  assert.deepEqual([...await run(job, [snapshot])], ['footnote-only']); assert.deepEqual(reads, ['footnote-only']);
  assets.clear(); job.assetsManager.readFromBlob = async key => { reads.push(key); };
  await assert.rejects(run(job, [snapshot]), /附件无法读取/);
});

test('the actual production attachment gate includes footnotes without serializing native text to plain strings', () => {
  const file = ts.createSourceFile('workspace.ts', readFileSync('src/app/workspace.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProductionDoc') as ts.ClassDeclaration;
  const method = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'blobKeys')!;
  const code = ts.transpile('class Probe {' + method.getText(file) + '}', { target: ts.ScriptTarget.ES2022 });
  const probe = new (new Function('nativeAttachmentKeys', code + ';return Probe;')(nativeAttachmentKeys))();
  const doc = new Y.Doc(), blocks = doc.getMap<Y.Map<unknown>>('blocks'), block = new Y.Map(), text = new Y.Text();
  blocks.set('paragraph', block); block.set('prop:text', text);
  text.insert(0, ' ', { footnote: { label: '1', reference: { type: 'attachment', blobId: 'pending-only-footnote', fileName: '脚注原件.txt', fileType: 'text/plain' } } });
  probe.yBlocks = blocks;
  assert(probe.blobKeys().has('pending-only-footnote'), 'beforePush must see this pending file');
  const workspaceClass = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProductionWorkspace') as ts.ClassDeclaration;
  const metadata = workspaceClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'blobMetadata')!;
  const metadataCode = ts.transpile('class Probe {' + metadata.getText(file) + '}', { target: ts.ScriptTarget.ES2022 });
  const workspace = new (new Function('footnoteReferences', metadataCode + ';return Probe;')(footnoteReferences))();
  workspace.docs = new Map([['doc', { yBlocks: blocks }]]); workspace.retired = [];
  assert.deepEqual(workspace.blobMetadata('pending-only-footnote'), { name: '脚注原件.txt', type: 'text/plain' }, 'a viewer cache needs the name and type even without an attachment card');
  doc.destroy();
});

test('the production importer stages footnote-only originals before native text is applied and preflights missing bytes before creation', async () => {
  const source = ts.createSourceFile('transfer.ts', readFileSync('src/app/transfer.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'importFiles')!;
  const count = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'countBlocks')!;
  const code = ts.transpile(fn.getText(source) + '\n' + count.getText(source), { target: ts.ScriptTarget.ES2022 });
  const calls: string[] = [], data = new File(['脚注原件'], '原件.txt', { type: 'text/plain' }), key = await attachmentKey(data);
  const snapshot = { meta: { id: 'source', title: '复杂脚注' }, blocks: { id: 'page', flavour: 'affine:page', props: {}, children: [{ id: 'note', flavour: 'affine:note', props: {}, children: [{ id: 'paragraph', flavour: 'affine:paragraph', props: { text: { '$blocksuite:internal:text$': true, delta: [{ insert: ' ', attributes: { footnote: { label: '1', reference: { type: 'attachment', blobId: key } } } }] } }, children: [] }] }] } };
  const job = { assets: new Map<string, Blob>(), assetsManager: { writeToBlob: async (value: string) => { assert.equal(value, key); assert.equal(await job.assets.get(value)!.text(), await data.text()); calls.push('stage-original'); } },
    snapshotToDoc: async () => { calls.push('apply-native-text'); return { id: 'copy' }; }, [Symbol.dispose]: () => {} };
  const doc = { id: 'copy', prepare: async () => {}, sync: { isBlocked: false }, yBlocks: new Map([[1, 0], [2, 0], [3, 0]]), importSnapshot: async (apply: () => Promise<unknown>) => apply() };
  const workspace = { member: { role: 'edit' }, blobs: { session: async () => {} }, idGenerator: () => 'copy', createDoc: () => { calls.push('create-document'); return doc; }, meta: { setDocMeta: () => {} } };
  const run = new Function('navigator', 'canEdit', 'TRANSFER_LIMITS', 'unpackTransfer', 'getJob', 'text', 'validateSnapshot', 'snapshotAttachmentKeys', 'attachmentKey', 'blob', 'remapDocumentReferences', code + ';return importFiles;')(
    { onLine: true }, canEdit, TRANSFER_LIMITS, unpackTransfer, () => job, new TextDecoder(), () => {}, snapshotAttachmentKeys, attachmentKey, (value: Uint8Array) => new Blob([new Uint8Array(value).buffer]), remapDocumentReferences);
  const file = (include: boolean) => new File([new Uint8Array(packTransfer(new Map([
    ['source.snapshot.json', new TextEncoder().encode(JSON.stringify(snapshot))],
    ['pageTogether.json', new TextEncoder().encode(JSON.stringify({ format: 1, blockSuite: '0.22.4', assets: include ? [{ key, path: 'assets/' + key, type: data.type, name: data.name }] : [] }))],
    ...include ? [['assets/' + key, new TextEncoder().encode('脚注原件')] as [string, Uint8Array]] : [],
  ]))).buffer], 'footnote.bs.zip');
  await assert.rejects(run(workspace, { getStore: () => ({}) }, file(false), false), /缺少附件/);
  assert.deepEqual(calls, []);
  await run(workspace, { getStore: () => ({}) }, file(true), false);
  assert.deepEqual(calls, ['create-document', 'stage-original', 'apply-native-text']);
});

test('the real editor footnote badge and popup wire navigation, keyboard access, safe links and stale download guards', async () => {
  const source = ts.createSourceFile('editor.ts', readFileSync('src/editor/editor.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'EditorView') as ts.ClassDeclaration;
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'setContext')!;
  const code = ts.transpile('class Probe {' + method.getText(source) + '}', { target: ts.ScriptTarget.ES2022 });
  const configs: any[] = [], events: CustomEvent[] = [], downloads: string[] = [], urls: string[] = [];
  const extension = (config: unknown) => config;
  const names = ['primaryModes', 'modeListeners', 'openFootnote', 'location', 'document', 'window', 'URL', 'setTimeout', 'html', 'FootNoteNodeConfigExtension', 'FontConfigExtension', 'CommunityCanvasTextFonts', 'EditorSettingExtension', 'signal', 'ParseDocUrlExtension', 'GenerateDocUrlExtension', 'DocModeExtension', 'BlockStdScope', 'viewManager', 'CompleteFileDropExtension', 'PdfEmbedExtension', 'WorkspaceDataViewExtension', 'FontStatusExtension', 'VisualExportExtension', 'FileSizeLimitProvider', 'MAX_ATTACHMENT_BYTES', 'RefNodeSlotsProvider'];
  const Scope = class { selection = { clear() {} }; get() { return { docLinkClicked: { subscribe: () => ({ unsubscribe() {} }) } }; } };
  const Probe = new Function(...names, code + ';return Probe;')(
    new Map(), new Map(), openFootnote, { href: 'https://app.example.test/', origin: 'https://app.example.test' },
    { createElement: () => ({ download: '', click() { downloads.push(this.download); } }) }, { open: (url: string) => urls.push(url) },
    { createObjectURL: () => 'blob:synthetic', revokeObjectURL() {} }, () => 0,
    (_strings: unknown, ...values: unknown[]) => ({ values }), (config: unknown) => { configs.push(config); return config; },
    extension, [], extension, extension, extension, extension, extension, Scope, { get: () => [] }, ...Array(6).fill({}), 50_000_000, {});
  const probe = new Probe(); probe.isConnected = true; probe.dispatchEvent = (event: CustomEvent) => { events.push(event); return true; }; probe.requestUpdate = () => {};
  let release!: (data: Blob) => void;
  const store = { blobSync: { get: () => new Promise<Blob>(resolve => { release = resolve; }) } };
  probe.setContext(store, 'page');
  const config = configs[0], doc = { label: '1', reference: { type: 'doc', docId: 'target' } };
  const handlers = (footnote: unknown) => config.customNodeRenderer(footnote).values.filter((value: unknown) => typeof value === 'function');
  handlers(doc)[0](); await new Promise(setImmediate);
  assert.equal(events[0].type, 'doc-change'); assert.deepEqual(events[0].detail, { pageId: 'target' });
  let prevented = false, stopped = false;
  handlers(doc)[1]({ key: 'Enter', preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  await new Promise(setImmediate); assert(prevented && stopped); assert.equal(events.filter(event => event.type === 'doc-change').length, 2);
  prevented = stopped = false;
  handlers(doc)[1]({ key: ' ', preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  await new Promise(setImmediate); assert(prevented && stopped); assert.equal(events.filter(event => event.type === 'doc-change').length, 3);
  const controller = new AbortController(); config.onPopupClick(doc, controller); assert(controller.signal.aborted);
  await new Promise(setImmediate); assert.equal(events.filter(event => event.type === 'doc-change').length, 4);
  handlers({ label: '2', reference: { type: 'url', url: 'javascript:alert(1)' } })[0](); await new Promise(setImmediate);
  assert.equal(urls.length, 0); assert.match(events.at(-1)!.detail.message, /HTTP/);
  handlers({ label: '3', reference: { type: 'url', url: 'https://example.test/' } })[0](); await new Promise(setImmediate);
  assert.deepEqual(urls, ['https://example.test/']);
  const attachment = { label: '4', reference: { type: 'attachment', blobId: 'file', fileName: '原件.txt' } };
  handlers(attachment)[0](); assert(release); release(new Blob(['完整原件'])); await new Promise(setImmediate); assert.deepEqual(downloads, ['原件.txt']);
  handlers(attachment)[0](); probe.setContext({ blobSync: store.blobSync }, 'page'); release(new Blob(['旧文档延迟原件'])); await new Promise(setImmediate);
  assert.deepEqual(downloads, ['原件.txt']); assert.match(events.at(-1)!.detail.message, /文档已切换/);
});
