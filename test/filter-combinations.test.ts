import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { nativeKanbanManagerPath, nativeTableManagerPath, patchNativeHiddenFilters } from '../scripts/native-data-view-compatibility.js';

const directory = 'node_modules/@blocksuite/data-view/src/core/filter/';
const compile = (code: string) => ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
const body = (code: string) => code.replace(/^import[\s\S]*?;\n/gm, '');
// The functions and recursive evaluator come from the pinned package. Logical
// type constructors are input validators here, not replacements for predicates.
const validator = (validate: (value: unknown) => boolean) => ({ valueValidate: validate });
const t = Object.fromEntries(['number', 'date', 'tag', 'string', 'boolean', 'unknown'].map(type => [type, { instance: () => validator(v => type === 'unknown' || (type === 'date' || type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === (type === 'tag' ? 'string' : type))) }]));
const ct = { array: { instance: (element: { valueValidate: (v: unknown) => boolean }) => validator(v => Array.isArray(v) && v.every(element.valueValidate)) } };
const deps = { t, ct, tRef: () => t.tag.instance(), tVar: () => ({}), createFilter: (v: unknown) => v };
const all: any[] = [];
for (const file of ['number', 'date', 'tag', 'multi-tag', 'boolean', 'string', 'unknown']) {
  const exports: Record<string, any[]> = {};
  new Function('exports', ...Object.keys(deps), compile(body(readFileSync(directory + 'filter-fn/' + file + '.ts', 'utf8'))))(exports, ...Object.values(deps));
  all.push(...Object.values(exports).flat());
}
let evaluations = 0;
const exports: any = {};
new Function('exports', 'filterMatcher', compile(body(readFileSync(directory + 'eval.ts', 'utf8'))))(exports, { getFilterByName: (name: string) => { evaluations++; return all.find(v => v.name === name); } });
const evaluate = exports.evalFilter as (filter: object, row: Record<string, unknown>) => boolean;
const rule = (name: string, fn: string, ...args: unknown[]) => ({ type: 'filter', left: { type: 'ref', name }, function: fn, args: args.map(value => ({ type: 'literal', value })) });
const group = (op: string, ...conditions: object[]) => ({ type: 'group', op, conditions });
const rows = [
  { number: 0, checked: false, tags: ['x', 'y'], date: 100, text: 'Alpha', status: 'todo' },
  { number: 10, checked: true, tags: ['x'], date: 200, text: 'BETA', status: 'todo' },
  { number: -5, checked: false, tags: [], date: 300, text: 'gamma', status: 'todo' },
  { number: undefined, checked: false, tags: ['y'], date: 400, text: 'delta', status: 'todo' },
  { number: 20, checked: true, tags: ['x', 'y'], date: 500, text: 'epsilon', status: 'done' },
  { number: 0, checked: false, tags: ['x'], date: 600, text: 'zeta', status: 'done' },
  { number: 15, checked: false, tags: null, date: null, text: 'eta', status: 'done' },
  { number: null, checked: true, tags: [], date: 800, text: '', status: 'done' },
];
const filters = [
  group('and', group('or', rule('number', 'equal', 0), rule('number', 'greatThan', 10)), rule('checked', 'isUnchecked'), rule('tags', 'containsOneOf', ['x'])),
  group('or', group('and', rule('tags', 'isEmpty'), rule('number', 'lessThan', 0)), group('and', rule('tags', 'containsAll', ['x', 'y']), rule('date', 'before', 300))),
  group('and', rule('tags', 'doesNotContainOneOf', ['y']), group('or', rule('number', 'isEmpty'), rule('number', 'greatThanOrEqual', 10)), rule('checked', 'isUnchecked')),
  group('and', rule('number', 'isNotEmpty'), rule('text', 'isNotEmpty'), rule('status', 'isOneOf', ['done'])),
];
const expected = [[0, 5], [0, 2], [6], [4, 5, 6]];

test('pinned evaluator handles nested AND/OR with zero false missing dates and positive and negative tag sets', () => {
  filters.forEach((filter, index) => assert.deepEqual(rows.flatMap((row, i) => evaluate(filter, row) ? [i] : []), expected[index]));
  assert.ok(evaluations > 50);
  assert.deepEqual(rows.flatMap((row, i) => evaluate(group('and', rule('text', 'contains', 'TA'), rule('date', 'after', 100)), row) ? [i] : []), [1, 3, 5]);
  for (const value of [0, false]) assert.equal(evaluate(rule('value', 'isEmpty'), { value }), false);
  for (const value of [null, undefined, '', []]) assert.equal(evaluate(rule('value', 'isEmpty'), { value }), true);
  assert.equal(evaluate(group('and'), {}), true); assert.equal(evaluate(group('or'), {}), false);
});

test('actual native table and kanban evaluate hidden properties for every combination', () => {
  for (const path of [nativeTableManagerPath, nativeKanbanManagerPath]) {
    const raw = readFileSync('node_modules' + path, 'utf8');
    const run = (code: string, filter: object) => {
      const tree = ts.createSourceFile('manager.ts', code, ts.ScriptTarget.Latest, true);
      const cls = tree.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.members.some(m => ts.isMethodDeclaration(m) && m.name.getText() === 'isShow'))!;
      const method = cls.members.find(m => ts.isMethodDeclaration(m) && m.name.getText() === 'isShow')!.getText();
      const fn = new Function('evalFilter', compile('return ({' + method + '}).isShow;'))(evaluate);
      const columns = Object.keys(rows[0]).map(id => ({ id, cellGetOrCreate: (index: number) => ({ jsonValue$: { value: (rows[index] as any)[id] } }) }));
      const manager = { filter$: { value: filter }, properties$: { value: [] }, propertiesRaw$: { value: columns } };
      return rows.flatMap((_row, index) => fn.call(manager, index) ? [index] : []);
    };
    filters.forEach((filter, index) => assert.deepEqual(run(patchNativeHiddenFilters(raw, '0.22.4'), filter), expected[index]));
    assert.deepEqual(run(raw, filters[0]), []);
  }
});

test('native incomplete filter arguments remain inactive while valid siblings still constrain rows', () => {
  const incomplete = rule('number', 'equal', undefined);
  assert.equal(evaluate(incomplete, rows[0]), true);
  assert.equal(evaluate(rule('number', 'equal', 'wrong type'), rows[0]), true);
  assert.deepEqual(rows.flatMap((row, i) => evaluate(group('and', incomplete, rule('tags', 'containsAll', ['x', 'y'])), row) ? [i] : []), [0, 4]);
});
