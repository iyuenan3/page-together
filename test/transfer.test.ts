import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { zipSync } from 'fflate';
import { documentIdFromUrl } from '../shared/document-links.js';
import { packTransfer, prepareTextSnapshot, relativeTransferPath, remapDocumentReferences, TRANSFER_LIMITS, unpackTransfer } from '../shared/transfer.js';

test('native exported routes and query links select only documents on this origin', () => {
  assert.equal(documentIdFromUrl('https://example.test/workspace/main/doc-a', 'https://example.test'), 'doc-a');
  assert.equal(documentIdFromUrl('/?doc=doc-b', 'https://example.test'), 'doc-b');
  assert.equal(documentIdFromUrl('https://other.test/?doc=doc-b', 'https://example.test'), undefined);
  assert.equal(documentIdFromUrl('/workspace/other/doc-a', 'https://example.test'), undefined);
  assert.equal(documentIdFromUrl('/arbitrary?doc=doc-a', 'https://example.test'), undefined);
  assert.equal(documentIdFromUrl('/workspace/main/%E0', 'https://example.test'), undefined);
});
test('ZIP roundtrip retains exact UTF-8 and binary bytes', () => {
  const entries = new Map([['中文.snapshot.json', new TextEncoder().encode('{"正文":"多文档"}')], ['assets/hash', new Uint8Array([0, 255, 3])]]);
  assert.deepEqual(unpackTransfer(packTransfer(entries)), entries);
});
test('ZIP export includes container overhead in the same import size budget', () => {
  const entries = new Map([['file.txt', new Uint8Array(20)]]);
  assert.throws(() => packTransfer(entries, { ...TRANSFER_LIMITS, total: 100, file: 100 }), /导出容量/);
  const limits = { ...TRANSFER_LIMITS, total: 200, file: 100 };
  assert.deepEqual(unpackTransfer(packTransfer(entries, limits), limits), entries);
});
test('text export tolerates empty progress cells while preserving zero and false', () => {
  const native = { flavour: 'affine:database', props: { cells: { row: { empty: {}, zero: { value: 0 }, unchecked: { value: false } } } }, children: [] };
  const copy = structuredClone(native); prepareTextSnapshot(copy);
  assert.deepEqual(copy.props.cells.row, { zero: { value: 0 }, unchecked: { value: false } });
  assert.deepEqual(native.props.cells.row.empty, {});
});
test('actual native static table export aligns reordered headers and includes computed creation time', () => {
  const source = readFileSync('node_modules/@blocksuite/affine-block-database/src/adapters/utils.ts', 'utf8');
  const exported: { processTable?: (columns: unknown[], children: unknown[], cells: unknown) => { headers: { name: string }[]; rows: { cells: { value: unknown }[] }[] } } = {};
  const models = Object.fromEntries(['title', 'number', 'checkbox', 'rich-text'].map(type => [type, { config: { rawValue: { toString: ({ value }: { value: unknown }) => String(value) } } }]));
  new Function('exports', 'require', ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }))(exported, () => ({ databaseBlockModels: models }));
  const native = { flavour: 'affine:database', props: {
    columns: [{ id: 'number', type: 'number', name: 'Quantity' }, { id: 'title', type: 'title', name: 'Title' }, { id: 'created', type: 'created-time', name: 'Created' }],
    cells: { row: { number: { value: 0 } } },
  }, children: [{ id: 'row', flavour: 'affine:paragraph', props: { text: { '$blocksuite:internal:text$': true, delta: [{ insert: 'Row' }] }, 'meta:createdAt': 1700000000000 }, children: [] }] };
  const render = (snapshot: typeof native) => exported.processTable!(snapshot.props.columns, snapshot.children, snapshot.props.cells);
  const original = render(native);
  assert.equal(original.headers[0].name, 'Quantity');
  assert.deepEqual(original.rows[0].cells[0].value, native.children[0].props.text);
  assert.equal(original.rows[0].cells[2].value, '');
  const copy = structuredClone(native); prepareTextSnapshot(copy);
  const table = render(copy);
  assert.deepEqual(table.headers.map(column => column.name), ['Title', 'Quantity', 'Created']);
  assert.deepEqual(table.rows[0].cells.map(cell => cell.value), [native.children[0].props.text, '0', { '$blocksuite:internal:text$': true, delta: [{ insert: '2023-11-15 06:13:20.000 +08:00' }] }]);
  assert.deepEqual(native.props.columns.map(column => column.type), ['number', 'title', 'created-time']);
  assert.deepEqual(native.props.cells.row, { number: { value: 0 } });
});
test('ZIP preflight rejects traversal, oversized inflation, unsupported compression and truncated entries', () => {
  assert.throws(() => unpackTransfer(zipSync({ '../escape': new Uint8Array([1]) })), /路径/);
  const compressed = zipSync({ 'large.txt': new Uint8Array(3000) }, { level: 9 });
  assert.throws(() => unpackTransfer(compressed, { ...TRANSFER_LIMITS, file: 1000 }), /限制/);
  assert.throws(() => unpackTransfer(compressed, { ...TRANSFER_LIMITS, total: 2000, file: 4000 }), /限制/);
  const unsupported = zipSync({ 'entry.txt': new Uint8Array([1, 2]) }); unsupported[8] = 99;
  assert.throws(() => unpackTransfer(unsupported));
  assert.throws(() => unpackTransfer(unsupported.subarray(0, 40)));
});
test('import changes package document references while retaining canvas, data cells and literal text IDs', () => {
  const block = { flavour: 'affine:page', props: { title: 'original-a' }, children: [
    { flavour: 'affine:paragraph', props: { text: { delta: [{ insert: 'original-a' }, { insert: ' ', attributes: { reference: { pageId: 'original-a', params: { blockIds: ['block-1'] } } } }] } }, children: [] },
    { flavour: 'affine:embed-synced-doc', props: { pageId: 'original-b' }, children: [] },
    { flavour: 'affine:embed-linked-doc', props: { pageId: 'external' }, children: [] },
    { flavour: 'affine:database', props: { cells: { 'row-1': { 'col-1': 'original-a' } } }, children: [] },
    { flavour: 'affine:surface', props: { elements: { 'shape-1': { text: 'original-a' } } }, children: [] },
  ] };
  remapDocumentReferences(block, new Map([['original-a', 'new-a'], ['original-b', 'new-b']]));
  const value = JSON.stringify(block);
  assert.match(value, /"pageId":"new-a"/); assert.match(value, /"pageId":"new-b"/);
  assert.match(value, /"pageId":"external"/); assert.match(value, /"insert":"original-a"/);
  assert.match(value, /"col-1":"original-a"/); assert.match(value, /"blockIds":\["block-1"\]/);
});

test('Notion package links resolve relative to each nested source document', () => {
  assert.equal(relativeTransferPath('pages/a.html', 'pages/b.html'), 'b.html');
  assert.equal(relativeTransferPath('pages/sub/a.html', 'pages/b.html'), '../b.html');
  assert.equal(relativeTransferPath('a.html', 'pages/b.html'), 'pages/b.html');
});
