import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

test('actual image component renders remote addresses without referrers and retries without changing stored values', () => {
  const tree = ts.createSourceFile('image.ts', readFileSync('src/editor/data-view-image.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'DataViewImage')!;
  const js = ts.transpile(cls.getText().replace(/^export /, ''), { target: ts.ScriptTarget.ES2022 });
  const component = new Function('ShadowlessElement', 'html', 'keyed', js + ';return new DataViewImage();')(
    class {}, (parts: TemplateStringsArray, ...values: unknown[]) => parts.reduce((s, p, i) => s + p + (values[i] ?? ''), ''),
    (key: string, template: string) => ({ key, template }));
  assert.equal(component.render(), '');
  component.source = 'https://images.example.test/remote.png';
  const first = component.render();
  assert.match(first.template, /src=https:\/\/images.example.test\/remote.png/);
  assert.match(first.template, /referrerpolicy="no-referrer"/);
  assert.match(first.template, /alt=图片字段/); assert.match(first.template, /draggable="false"/);
  component.fail({ currentTarget: { isConnected: false } }); assert.equal(component.failed, false);
  component.fail({ currentTarget: { isConnected: true } }); assert.match(component.render(), /图片加载失败/);
  component.retry(); const next = component.render();
  assert.notEqual(first.key, next.key); assert.equal(component.source, 'https://images.example.test/remote.png');
  assert.match(next.template, /src=https:\/\/images.example.test\/remote.png/);
  component.cover = true; assert.match(component.render().template, /alt=图片封面/); assert.match(component.render().template, /max-height:160px/);
  component.failed = true; component.source = 'data:image/png;base64,synthetic'; component.willUpdate(new Map([['source', 'old']]));
  assert.equal(component.failed, false); assert.equal(component.attempt, 0); assert.match(component.render().template, /src=data:image/);
});
