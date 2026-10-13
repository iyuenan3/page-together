import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('registered Todo menu creates a separate query block and respects readonly and parent constraints', () => {
  const file = ts.createSourceFile('query.ts', readFileSync('src/editor/workspace-data-view.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = (name: string) => file.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(file) === name)!.initializer!.getText(file);
  const run = (text: string, args: Record<string, unknown>) => new Function(...Object.keys(args), ts.transpile(`return (${text});`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(args));
  const menu = run(declaration('workspaceTodoMenu'), { html: () => '', isInsideBlockByFlavour: () => false, FeatureFlagService: {} });
  let registered: unknown;
  const extension = run(declaration('WorkspaceDataViewExtension'), {
    workspaceTodoMenu: menu, BlockViewIdentifier: (name: string) => name, literal: () => '',
    SlashMenuConfigExtension: (_id: string, config: unknown) => ({ setup() { registered = config; } }),
  });
  extension.setup({ override() {} }); assert.equal(registered, menu);
  const calls: unknown[][] = [], model = { flavour: 'affine:paragraph', text: { length: 0 }, store: undefined as unknown };
  const parent = { children: [model] };
  const store = { readonly: false, getParent: () => parent as object | undefined, captureSync: () => calls.push(['capture']), addBlock: (...args: unknown[]) => calls.push(args), deleteBlock: (target: unknown) => calls.push(['delete', target]) };
  model.store = store;
  const context = { model, std: { get: () => ({ getFlag: () => true }) } };
  assert.equal(menu.items[0].when(context), true);
  menu.items[0].action(context);
  assert.deepEqual(calls[1], ['affine:data-view', { title: '待办汇总' }, parent, 1]);
  assert.equal(calls[0][0], 'capture'); assert.deepEqual(calls[2], ['delete', model]);
  calls.length = 0; store.readonly = true;
  assert.equal(menu.items[0].when(context), false); menu.items[0].action(context); assert.equal(calls.length, 0);
  store.readonly = false; store.getParent = () => undefined; menu.items[0].action(context); assert.equal(calls.length, 0);
});
