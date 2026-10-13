import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { moveQueryRow, queryRowsInOrder } from '../shared/query-order.js';
import { RequestError } from '../src/app/api.js';
import { nativeImageCellPath, nativeKanbanCardPath, nativeKanbanManagerPath, nativeTableManagerPath, patchNativeHiddenFilters, patchNativeImageCell, patchNativeKanbanCover } from '../scripts/native-data-view-compatibility.js';

const source = (path: string) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const classCode = (path: string, name: string) => source(path).statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name)!.getText().replace(/^export /, '');
const compile = (code: string) => ts.transpile(code, { target: ts.ScriptTarget.ES2022, useDefineForClassFields: false });

test('query order keeps compound identities, missing sources and cold rows without mutating inputs', () => {
  const live = ['a/same', 'b/same', 'c/new'];
  const saved = ['b/same', 'missing/task', 'b/same', 'a/same'];
  assert.deepEqual(queryRowsInOrder(live, saved, row => row), ['b/same', 'a/same', 'c/new']);
  assert.deepEqual(moveQueryRow(saved, live, 'c/new', { id: 'a/same', before: true }), ['b/same', 'missing/task', 'c/new', 'a/same']);
  assert.deepEqual(queryRowsInOrder(['a/same', 'b/same', 'missing/task', 'c/new'], saved, row => row), ['b/same', 'missing/task', 'a/same', 'c/new']);
  assert.deepEqual(moveQueryRow([], live, 'b/same', 'start'), ['b/same', 'a/same', 'c/new']);
  assert.deepEqual(moveQueryRow([], live, 'a/same', 'end'), ['b/same', 'c/new', 'a/same']);
  for (const position of [{ id: 'absent/task', before: true }, { id: 'a/same', before: false }]) assert.equal(moveQueryRow([], live, 'a/same', position), undefined);
  assert.equal(moveQueryRow([], live, 'absent/task', 'start'), undefined);
  assert.equal(moveQueryRow([], live, 'b/same', { id: 'a/same', before: false }), undefined);
  assert.deepEqual(live, ['a/same', 'b/same', 'c/new']); assert.equal(saved.length, 4);
  for (const malformed of [null, 123, 'bad order', {}]) assert.deepEqual(queryRowsInOrder(live, malformed, row => row), live);
  assert.deepEqual(moveQueryRow([null, 123, 'b/same'], live, 'c/new', 'start'), ['c/new', 'b/same', 'a/same']);
});

test('actual query table drag persists only its view and delegates grouped moves to the native row', () => {
  let mapped = 0, grouped = 0, writes = 0;
  class NativeTable {
    data$ = { value: {} as Record<string, unknown> };
    readonly$ = { value: false };
    dataSource = { rows$: { value: ['a/same', 'b/same', 'c/task'] } };
    locked = true;
    rowsMapping(rows: unknown[]) { mapped++; return rows; }
    lockRows(value: boolean) { this.locked = value; }
    dataUpdate(update: () => object) { writes++; this.data$.value = { ...this.data$.value, ...update() }; }
  }
  class NativeRow {
    constructor(public tableView: NativeTable, public rowId: string) {}
    move() { grouped++; }
  }
  const code = classCode('src/editor/query-table.ts', 'QueryTableView') + '\n' + classCode('src/editor/query-table.ts', 'QueryTableRow');
  const Query = new Function('TableSingleView', 'TableRow', 'moveQueryRow', 'queryRowsInOrder', compile(code) + ';return QueryTableView;')(NativeTable, NativeRow, moveQueryRow, queryRowsInOrder);
  const first = new Query(), second = new Query();
  first.rowGetOrCreate('b/same').move({ id: 'a/same', before: true });
  assert.equal(writes, 1); assert.equal(first.locked, false);
  const rows = first.dataSource.rows$.value.map((rowId: string) => ({ rowId }));
  assert.deepEqual(first.rowsMapping(rows).map((row: { rowId: string }) => row.rowId), ['b/same', 'a/same', 'c/task']);
  assert.equal(mapped, 1); assert.deepEqual(second.data$.value, {});
  first.rowGetOrCreate('b/same').move('end', 'group-a', 'group-b'); assert.equal(grouped, 1); assert.equal(writes, 1);
  first.readonly$.value = true;
  first.rowGetOrCreate('b/same').move('end'); first.moveRow('a/same', 'end');
  first.rowGetOrCreate('b/same').move('end', 'group-a', 'group-b');
  assert.equal(writes, 1); assert.equal(grouped, 1);
});

test('actual standalone source resolves source metadata and duplicates legacy false zero null and native cells', () => {
  let captures = 0, added = 0, cloned = 0;
  class NativeSource {
    isFixedProperty() { return false; }
    spacialValueGet() { return undefined; }
    propertyTypeGet(id: string) { return id === 'created' ? 'created-time' : 'rich-text'; }
  }
  class RichText { clone() { cloned++; return new RichText(); } }
  const file = 'src/editor/workspace-data-view.ts';
  const constants = source(file).statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText() === 'completed')!.getText();
  const code = constants + '\n' + classCode(file, 'WorkspaceTodoSource');
  const Query = new Function('DatabaseBlockDataSource', 'computed', 'Text', 'addProperty', compile(code) + ';return WorkspaceTodoSource;')(
    NativeSource, (fn: () => unknown) => ({ get value() { return fn(); } }), RichText,
    (model: { props: { columns: object[] } }, _position: unknown, column: object & { id: string }) => { added++; model.props.columns.push(column); return column.id; }
  );
  const instance = Object.create(Query.prototype);
  const text = new RichText();
  instance.query = { props: { columns: [{ id: 'field', name: 'Field', type: 'rich-text', data: {} }], cells: {
    zero: { field: 0 }, false: { field: false }, empty: { field: '' }, null: { field: null },
    wrapped: { field: { columnId: 'field', value: 12 } }, text: { field: text }, absent: {},
  } } };
  instance.readonly$ = { value: false };
  instance.workspace = { idGenerator: () => 'copy' };
  instance.doc = { captureSync() { captures++; }, transact(fn: () => void) { fn(); } };
  instance.row = (id: string) => id === 'source/task' ? { model: { props: { 'meta:createdAt': 1700000000000 } } } : undefined;
  instance.rowMap = { value: new Map([['source/task', instance.row('source/task')]]) };
  assert.equal(instance.spacialValueGet('source/task', 'created', 'created-time'), 1700000000000);
  assert.equal(instance.spacialValueGet('missing/task', 'created', 'created-time'), null);
  assert.equal(instance.cellValueGet('source/task', 'created'), 1700000000000);
  assert.equal(instance.propertyDuplicate('field'), 'copy'); assert.equal(added, 1); assert.equal(captures, 1);
  for (const [row, value] of [['zero', 0], ['false', false], ['empty', ''], ['null', null], ['wrapped', 12]]) assert.deepEqual(instance.query.props.cells[row as string].copy, { columnId: 'copy', value });
  assert.equal(cloned, 1); assert.notEqual(instance.query.props.cells.text.copy.value, text); assert.deepEqual(instance.query.props.cells.absent, {});
  instance.readonly$.value = true; instance.propertyDuplicate('field'); assert.equal(added, 1); assert.equal(captures, 1);
});

test('pinned native table and kanban filters use hidden property values, with unpatched negative controls', () => {
  const version = JSON.parse(readFileSync('node_modules/@blocksuite/data-view/package.json', 'utf8')).version;
  for (const path of [nativeTableManagerPath, nativeKanbanManagerPath]) {
    const raw = readFileSync('node_modules' + path, 'utf8');
    const run = (code: string) => {
      const tree = ts.createSourceFile('manager.ts', code, ts.ScriptTarget.Latest, true);
      const cls = tree.statements.find(ts.isClassDeclaration)!;
      const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === 'isShow')!.getText();
      let evaluated = 0;
      const show = new Function('evalFilter', compile('return ({' + method + '}).isShow;'))((_filter: unknown, values: Record<string, unknown>) => { evaluated++; return values.hidden === 'data:image/png;base64,synthetic'; });
      const column = (id: string) => ({ id, cellGetOrCreate: () => ({ jsonValue$: { value: id === 'hidden' ? 'data:image/png;base64,synthetic' : 'Task' } }) });
      const result = show.call({ filter$: { value: { conditions: [{}] } }, properties$: { value: [column('title')] }, propertiesRaw$: { value: [column('title'), column('hidden')] } }, 'row');
      assert.equal(evaluated, 1); return result;
    };
    assert.equal(run(raw), false); assert.equal(run(patchNativeHiddenFilters(raw, version)), true);
    assert.throws(() => patchNativeHiddenFilters(raw, '0.23.0'), /upgrading/);
    assert.throws(() => patchNativeHiddenFilters(raw.replace('this.properties$.value.map(column => [', '[]'), version), /source changed/);
  }
});

test('actual native image renderer leaves missing values empty and preserves supplied image addresses', () => {
  const raw = readFileSync('node_modules' + nativeImageCellPath, 'utf8');
  const run = (code: string, value: string | null | undefined) => {
    const tree = ts.createSourceFile('image.ts', code, ts.ScriptTarget.Latest, true);
    const cls = tree.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'ImageCell')!;
    const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === 'render')!.getText().replace(/^override /, '');
    const render = new Function('html', compile('return ({' + method + '}).render;'))((parts: TemplateStringsArray, ...values: unknown[]) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''));
    return render.call({ value }) as string;
  };
  const patched = patchNativeImageCell(raw, '0.22.4');
  for (const value of [null, undefined, '']) { assert.match(run(raw, value), /<img/); assert.equal(run(patched, value), ''); }
  for (const value of ['data:image/png;base64,synthetic', 'https://example.test/image.png']) assert.equal(run(patched, value), `<page-together-data-view-image .source=${value}></page-together-data-view-image>`);
  assert.throws(() => patchNativeImageCell(raw, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativeImageCell(raw.replace('this.value ??', 'this.value ||'), '0.22.4'), /source changed/);
});

test('actual native desktop kanban renders its hidden image cover while keeping title and icons', () => {
  const raw = readFileSync('node_modules' + nativeKanbanCardPath, 'utf8');
  const run = (code: string, value: unknown) => {
    const tree = ts.createSourceFile('card.ts', code, ts.ScriptTarget.Latest, true);
    const cls = tree.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'KanbanCard')!;
    const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === 'renderHeader')!.getText().replace(/^private /, '');
    const render = new Function('html', 'classMap', compile('return ({' + method + '}).renderHeader;'))((parts: TemplateStringsArray, ...values: unknown[]) => parts.reduce((text, part, index) => text + part + (values[index] ?? ''), ''), () => 'card-header');
    return render.call({ cardId: 'source/task', view: { hasHeader: () => true, getHeaderCover: () => ({ cellGetOrCreate: () => ({ value$: { value } }) }) }, renderTitle: () => 'Task title', renderIcon: () => 'Task icon' }, []);
  };
  const patched = patchNativeKanbanCover(raw, '0.22.4');
  assert.doesNotMatch(run(raw, 'data:image/png;base64,synthetic'), /<img/);
  const rendered = run(patched, 'data:image/png;base64,synthetic');
  assert.match(rendered, /\.source=data:image\/png;base64,synthetic/); assert.match(rendered, /Task title/); assert.match(rendered, /Task icon/); assert.match(rendered, /\.cover=true/);
  for (const value of [null, undefined, '', 123]) assert.doesNotMatch(run(patched, value), /<page-together-data-view-image/);
  assert.throws(() => patchNativeKanbanCover(raw, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativeKanbanCover(raw.replace('renderHeader(columns:', 'renderHeader(fields:'), '0.22.4'), /source changed/);
});

test('actual query refresh reads authorized caches when the server is unreachable but never treats auth denial as offline', async () => {
  const tree = source('src/app/workspace.ts');
  const cls = tree.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'ProductionWorkspace')!;
  const method = cls.members.find(node => ts.isMethodDeclaration(node) && node.name.getText() === 'refreshQueries')!.getText().replace(/^private /, '');
  const hint = { onLine: true };
  const refresh = new Function('navigator', 'RequestError', 'clearTimeout', 'setTimeout', compile('return ({' + method + '}).refreshQueries;'))(hint, RequestError, () => {}, () => 1);
  const run = async (error?: Error) => {
    const reads: boolean[] = [];
    const instance = { querying: false, disposed: false, queryUsers: 1, queryState: { value: '' }, refresh: async () => { if (error) throw error; }, docs: new Map([['source', { record: { revision: 2 }, sync: { readQuery: async (online: boolean) => { reads.push(online); } } }]]) };
    await refresh.call(instance);
    assert.equal(instance.querying, false);
    return { reads, message: instance.queryState.value };
  };
  assert.deepEqual((await run()).reads, [true]);
  for (const error of [new TypeError('fetch failed'), new RequestError(503, 'unavailable')]) {
    const result = await run(error); assert.deepEqual(result.reads, [false]); assert.match(result.message, /本机已缓存/);
  }
  for (const status of [401, 403, 409]) assert.deepEqual((await run(new RequestError(status, 'access_changed'))).reads, []);
  hint.onLine = false; assert.deepEqual((await run()).reads, [false]);
});
