import assert from 'node:assert/strict';
import test from 'node:test';
import { documentReferenceFromUrl, documentUrl, referenceParams } from '../shared/document-links.js';

test('native frame and page anchors survive host URL generation and reload parsing', () => {
  for (const params of [
    { mode: 'edgeless', elementIds: ['frame-1', 'shape-2'], xywh: '[-5.5,0,1600,900]' },
    { mode: 'page', blockIds: ['paragraph-1'], databaseId: 'table', databaseRowId: 'row' },
  ] as const) {
    const normalized = referenceParams(params);
    assert.deepEqual(documentReferenceFromUrl(documentUrl('中文 target', normalized), 'https://example.test'), { pageId: '中文 target', params: normalized });
  }
  assert.deepEqual(documentReferenceFromUrl('/workspace/main/doc?mode=edgeless&elementIds=frame-1,%20shape-2', 'https://example.test'), { pageId: 'doc', params: { mode: 'edgeless', elementIds: ['frame-1', 'shape-2'] } });
});

test('malformed anchors never redirect to another origin or prevent document opening', () => {
  assert.equal(documentReferenceFromUrl('https://other.test/?doc=a&mode=edgeless', 'https://example.test'), undefined);
  assert.deepEqual(documentReferenceFromUrl('/?doc=a&mode=invalid&xywh=not-json&blockIds=,,', 'https://example.test'), { pageId: 'a' });
  for (const xywh of ['[0,0,0,50]', '[0,0,-1,50]', '[0,0,1e999,50]', '[]', '{"x":1}', '[0,0,20,30,40]']) assert.deepEqual(referenceParams({ xywh }), {});
  assert.deepEqual(referenceParams({ blockIds: [null, '', ' ', 'valid', 'valid', 'x'.repeat(513)], elementIds: 'wrong', mode: 'page', xywh: '[-1.5,2.5,50,30]' }), { mode: 'page', blockIds: ['valid'], xywh: '[-1.5,2.5,50,30]' });
  assert.equal(referenceParams({ elementIds: Array.from({ length: 150 }, (_, i) => 'frame-' + i) }).elementIds!.length, 100);
});
