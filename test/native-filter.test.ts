import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { computed, signal } from '@preact/signals-core';
import { nativeFilterGroupPath, patchNativeFilterGroups } from '../scripts/native-data-view-compatibility.js';

const source = readFileSync('node_modules' + nativeFilterGroupPath, 'utf8');
const patched = patchNativeFilterGroups(source, '0.22.4');
function runExpression(code: string, parent: object, filter: object) {
  const expression = code.match(/\.filterGroup="\$\{(computed\(\(\) => [^}]+)\}/)![1];
  const js = ts.transpile(`function expression() { return ${expression}; }`, { target: ts.ScriptTarget.ES2022 });
  return new Function('computed', 'filter', 'i', js + ';return expression.call(this);').call(parent, computed, filter, 0);
}
test('actual native nested group binding follows later edits rather than its first rendered object', () => {
  const original = { conditions: [{ args: [10] }, { args: [true] }] }, state = signal([original]);
  const parent = { conditions$: computed(() => state.value) };
  const child = runExpression(patched, parent, original);
  state.value = [{ conditions: [{ args: [0] }, { args: [true] }] }];
  assert.deepEqual(child.value.conditions[0].args, [0]);
  assert.deepEqual(child.value.conditions[1].args, [true]);
  // The published expression is a negative control for this exact regression.
  const stale = runExpression(source, parent, original);
  assert.deepEqual(stale.value.conditions[0].args, [10]);
});

test('native group add menu selects any field, retains siblings and respects maximum depth', () => {
  const add = patched.match(/private readonly _addNew = \(e: MouseEvent\) => \{([\s\S]*?)\n  \};/)![1];
  const js = ts.transpile(`function add(e: unknown) {${add}\n}`, { target: ts.ScriptTarget.ES2022 });
  for (const max of [false, true]) {
    let items: { name: string; select: () => void }[] = [];
    const state = signal({ type: 'group', op: 'and', conditions: [{ existing: true }] as unknown[] });
    const vars = [{ id: 'title', name: 'Title' }, { id: 'quantity', name: '数量' }, { id: 'checked', name: '完成' }];
    const parent = { isMaxDepth: max, vars: signal(vars), filterGroup: state, onChange: (value: typeof state.value) => { state.value = value; } };
    new Function('menu', 'popFilterableSimpleMenu', 'popupTargetFromElement', 'firstFilterByRef', 'firstFilterInGroup', js + ';return add.call(this, {currentTarget: {}});').call(parent,
      { action: (item: unknown) => item }, (_target: unknown, list: typeof items) => { items = list; }, (element: unknown) => element,
      (_vars: unknown, ref: unknown) => ({ left: ref }), () => ({ type: 'group', conditions: [] }));
    assert.deepEqual(items.map(item => item.name), [...vars.map(v => v.name), ...max ? [] : ['Add filter group']]);
    items.find(item => item.name === '数量')!.select();
    items.find(item => item.name === '完成')!.select();
    assert.deepEqual(state.value.conditions, [{ existing: true }, { left: { type: 'ref', name: 'quantity' } }, { left: { type: 'ref', name: 'checked' } }]);
  }
});

test('native source compatibility refuses version or source drift', () => {
  assert.throws(() => patchNativeFilterGroups(source, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativeFilterGroups(source.replace('computed(() => filter)', 'computed(() => other)'), '0.22.4'), /source changed/);
});
