import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { nativeLinkCellPath, patchNativeLinkCell } from '../scripts/native-data-view-compatibility.js';

test('actual native link-cell click forwards database and coordinate anchors to the host', () => {
  const source = readFileSync('node_modules' + nativeLinkCellPath, 'utf8');
  const run = (code: string, params: object) => {
    const body = code.match(/openDoc = \(e: MouseEvent\) => \{([\s\S]*?)\n  \};/)![1];
    let result: unknown;
    const std = { host: {}, getOptional: () => ({ docLinkClicked: { next: (value: unknown) => { result = value; } } }) };
    const instance = { docId$: { value: 'target' }, std, value: 'http://example.test/?doc=target', parseDocUrl: () => params };
    new Function('RefNodeSlotsProvider', ts.transpile(`function click(e) {${body}}`, { target: ts.ScriptTarget.ES2022 }) + ';click.call(this, {stopPropagation(){}});').call(instance, {});
    return result as { params?: object };
  };
  for (const params of [{ docId: 'target', databaseId: 'database', databaseRowId: 'row' }, { docId: 'target', mode: 'edgeless', xywh: '[100,200,800,600]' }]) {
    assert.deepEqual(run(patchNativeLinkCell(source, '0.22.4'), params).params, params);
    assert.equal(run(source, params).params, undefined);
  }
  assert.throws(() => patchNativeLinkCell(source, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativeLinkCell(source.replace('pageId: this.docId$.value,', 'pageId: undefined,'), '0.22.4'), /source changed/);
});
