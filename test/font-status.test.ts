import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('native font completion updates the badge without remounting the editor host', () => {
  const file = ts.createSourceFile('editor.ts', readFileSync('src/editor/editor.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const editor = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'EditorView') as ts.ClassDeclaration;
  const constructor = editor.members.find(ts.isConstructorDeclaration)!;
  const label = editor.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === 'fontLabel')!;
  let listener: (event: unknown) => void = () => assert.fail('listener missing');
  let updates = 0;
  const attributes = new Map<string, string>();
  const badge = { textContent: '', setAttribute: (key: string, value: string) => attributes.set(key, value) };
  class Base {
    addEventListener(_name: string, callback: typeof listener) { listener = callback; }
    querySelector() { return badge; }
    requestUpdate() { updates++; }
  }
  const code = ts.transpile(`class Editor extends Base { ${constructor.getText(file)} ${label.getText(file)} }; return new Editor();`, { target: ts.ScriptTarget.ES2022 });
  const instance = new Function('Base', code)(Base);
  const host = {};
  instance.scope = { host };
  listener({ target: host, detail: { total: 29, loaded: 29, failed: 0 } });
  assert.equal(badge.textContent, '7 种原生字体已加载');
  assert.equal(attributes.get('data-loaded'), '29');
  assert.equal(updates, 0, 'requestUpdate would remount the native host and restart font loading');
  listener({ target: {}, detail: { total: 29, loaded: 0, failed: 29 } });
  assert.equal(badge.textContent, '7 种原生字体已加载', 'events from an obsolete host are ignored');
});
