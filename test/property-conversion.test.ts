import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';
import { nativePropertyConvertsPath, patchNativePropertyConverts } from '../scripts/native-data-view-compatibility.js';

const raw = readFileSync('node_modules' + nativePropertyConvertsPath, 'utf8');
const preset = readFileSync('node_modules/@blocksuite/data-view/src/property-presets/converts.ts', 'utf8');
const compile = (code: string) => ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
const body = (code: string) => code.replace(/^import[\s\S]*?;\n/gm, '');
// Real Y.Text values are integrated before reading, as in the production store.
class Text {
  yText = new Y.Text();
  constructor(value = '') { if (value) this.yText.insert(0, value); }
}
const configs = Object.fromEntries(['select', 'multiSelect', 'number', 'progress', 'checkbox'].map(name => [name + 'PropertyModelConfig', { type: name === 'multiSelect' ? 'multi-select' : name }]));
type Conversion = { from: string; to: string; convert: (data: any, cells: any[]) => { property: any; cells: any[] } };
function conversions(code = patchNativePropertyConverts(raw, '0.22.4')): Conversion[] {
  let sequence = 0;
  const createPropertyConvert = (from: { type: string }, to: { type: string }, convert: Conversion['convert']) => ({ from: from.type, to: to.type, convert });
  const dependencies = { ...configs, clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)), createPropertyConvert };
  const exports: any = {};
  new Function('exports', ...Object.keys(dependencies), compile(body(preset)))(exports, ...Object.values(dependencies));
  const deps = { ...dependencies, presetPropertyConverts: exports.presetPropertyConverts, propertyModelPresets: configs, richTextPropertyModelConfig: { type: 'rich-text' }, nanoid: () => 'tag-' + sequence++, getTagColor: () => 'blue', Text };
  new Function('exports', ...Object.keys(deps), compile(body(code)))(exports, ...Object.values(deps));
  return exports.databasePropertyConverts;
}
function strings(cells: any[]) {
  const doc = new Y.Doc(), values = doc.getMap('values');
  cells.forEach((v, i) => { if (v instanceof Y.Text) values.set(String(i), v); });
  const result = cells.map(v => v instanceof Y.Text ? v.toString() : v); doc.destroy(); return result;
}
const run = (from: string, to: string, data: any, values: any[]) => conversions().find(v => v.from === from && v.to === to)!.convert(data, values);

test('all fourteen pinned native property conversions retain their actual value and option semantics', () => {
  assert.equal(conversions().length, 14);
  const options = { options: [{ id: 'a', value: 'Alpha', color: 'blue' }, { id: 'b', value: 'Beta', color: 'green' }] };
  assert.deepEqual(run('select', 'multi-select', options, ['a', null, 'b']).cells, [['a'], undefined, ['b']]);
  const single = run('multi-select', 'select', options, [['b', 'a'], [], undefined]);
  assert.deepEqual(single.cells, ['b', undefined, undefined]); assert.deepEqual(single.property, options);
  assert.deepEqual(run('number', 'progress', {}, [-1, 0, 12.5, 101, null]).cells, [0, 0, 12.5, 100, 0]);
  const number = run('progress', 'number', {}, [0, 100, undefined]);
  assert.deepEqual(number.cells, [0, 100, undefined]); assert.deepEqual(number.property, { decimal: 0, format: 'number' });
  const texts = ['0', '12.5', '-3', 'bad', '', undefined].map(v => v == null ? v : { toString: () => v });
  assert.deepEqual(run('rich-text', 'number', {}, texts).cells, [0, 12.5, -3, undefined, undefined, undefined]);
  assert.deepEqual(run('rich-text', 'progress', {}, texts).cells, [0, 12, 0, undefined, undefined, undefined]);
  assert.deepEqual(run('rich-text', 'checkbox', {}, ['yes', 'TRUE', 'no', '0', ''].map(v => ({ toString: () => v }))).cells, [true, true, undefined, undefined, undefined]);
  assert.deepEqual(strings(run('checkbox', 'rich-text', {}, [true, false, undefined]).cells), ['Yes', 'No', 'No']);
  assert.deepEqual(strings(run('number', 'rich-text', {}, [0, 12.5, undefined]).cells), ['0', '12.5', '']);
  assert.deepEqual(strings(run('progress', 'rich-text', {}, [0, 100, undefined]).cells), ['0', '100', '']);
  assert.deepEqual(strings(run('select', 'rich-text', options, ['b', undefined]).cells), ['Beta', '']);
  assert.deepEqual(strings(run('multi-select', 'rich-text', options, [['a', 'b'], []]).cells), ['Alpha,Beta', '']);
  for (const target of ['select', 'multi-select']) {
    const converted = run('rich-text', target, {}, ['Alpha, Beta', 'Alpha', ''].map(v => ({ toString: () => v })));
    assert.deepEqual(converted.property.options.map((v: any) => v.value), target === 'select' ? ['Alpha'] : ['Alpha', 'Beta']);
    assert.deepEqual(converted.cells[1], target === 'select' ? converted.property.options[0].id : [converted.property.options[0].id]);
  }
});

test('text-to-tag conversion treats prototype names as literal options in both native paths', () => {
  for (const to of ['select', 'multi-select']) {
    const values = ['__proto__', 'constructor', 'toString', '__proto__'].map(v => ({ toString: () => v }));
    const fixed = conversions().find(v => v.from === 'rich-text' && v.to === to)!.convert({}, values);
    assert.deepEqual(fixed.property.options.map((v: any) => v.value), ['__proto__', 'constructor', 'toString']);
    const ids = new Set(fixed.property.options.map((v: any) => v.id));
    assert.ok(fixed.cells.every(v => to === 'select' ? ids.has(v) : v.every((id: string) => ids.has(id))));
    const original = conversions(raw).find(v => v.from === 'rich-text' && v.to === to)!.convert({}, values);
    assert.equal(original.property.options.length, 0);
  }
  assert.throws(() => patchNativePropertyConverts(raw, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativePropertyConverts(raw.replace('SelectTag> = {};', 'SelectTag> = null;'), '0.22.4'), /source changed/);
});

function standalone(methodCode?: string) {
  const source = ts.createSourceFile('query.ts', readFileSync('src/editor/workspace-data-view.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const cls = source.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'WorkspaceTodoSource')!;
  const method = methodCode ?? cls.members.find(n => ts.isMethodDeclaration(n) && n.name.getText() === 'propertyTypeSet')!.getText().replace(/^override /, '');
  let writes = 0, captures = 0;
  const props = { columns: [{ id: 'value', type: 'number', data: {}, name: 'Value' }], cells: { 'live/task': { value: 0 }, 'trash/task': { value: { columnId: 'value', value: 12.5 } }, 'cold/task': { value: -3 } } as any };
  const updateProperty = (_model: any, id: string, fn: () => object) => { writes++; Object.assign(props.columns.find(c => c.id === id)!, fn()); };
  const updateCells = (_model: any, id: string, cells: Record<string, any>) => { writes++; for (const [row, value] of Object.entries(cells)) props.cells[row][id] = { columnId: id, value }; };
  const fn = new Function('databasePropertyConverts', 'updateProperty', 'updateCells', compile('return ({' + method + '}).propertyTypeSet;'))(conversions(), updateProperty, updateCells);
  const instance = { readonly$: { value: false }, isFixedProperty: (id: string) => id !== 'value', propertyTypeGet: () => props.columns[0].type, propertyMetaGet: (type: string) => ['number', 'rich-text', 'date'].includes(type) ? { config: { propertyData: { default: () => ({}) } } } : undefined, propertyDataGet: () => ({}), rows$: { value: ['live/task'] }, row: (id: string) => id === 'live/task', cellValueGet: (id: string) => { const v = props.cells[id]?.value; return v?.columnId ? v.value : v; }, query: { props }, _model: { props }, doc: { captureSync: () => captures++, transact: (f: () => void) => f() } };
  return { props, instance, convert: (type: string, id = 'value') => fn.call(instance, id, type), counts: () => ({ writes, captures }) };
}

test('standalone conversion includes retained and cold rows, normalizes both cell schemas and guards readonly/fixed/no-op', () => {
  const f = standalone(); f.convert('rich-text');
  assert.deepEqual(strings(Object.values(f.props.cells).map((row: any) => row.value.value)), ['0', '12.5', '-3']);
  assert.deepEqual(f.counts(), { writes: 2, captures: 1 });
  assert.equal(f.props.columns[0].type, 'rich-text');
  const rawSource = readFileSync('node_modules/@blocksuite/affine-block-database/src/data-source.ts', 'utf8');
  const tree = ts.createSourceFile('native.ts', rawSource, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'DatabaseBlockDataSource')!;
  const original = standalone(cls.members.find(n => ts.isMethodDeclaration(n) && n.name.getText() === 'propertyTypeSet')!.getText());
  original.convert('rich-text'); assert.equal(original.props.cells['trash/task'].value.value, 12.5);
  const guarded = standalone(); guarded.convert('number'); guarded.convert('unknown'); guarded.convert('rich-text', 'title');
  guarded.instance.readonly$.value = true; guarded.convert('rich-text');
  assert.deepEqual(guarded.counts(), { writes: 0, captures: 0 });
});

test('unsupported standalone pairs use native clearing semantics for every retained row', () => {
  const f = standalone(); f.convert('date');
  assert.equal(f.props.columns[0].type, 'date');
  for (const row of Object.values(f.props.cells) as any[]) assert.equal(row.value.value, undefined);
  assert.deepEqual(f.counts(), { writes: 2, captures: 1 });
});
