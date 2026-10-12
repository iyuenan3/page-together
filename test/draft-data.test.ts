import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { parseScope, snapshotText, textDifference } from '../src/app/draft-data.js';

test('draft comparison reads ordered native text without modifying the full rich snapshot', () => {
  const doc = new Y.Doc(), blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const add = (id: string, flavour: string, text?: string, children: string[] = []) => {
    const block = new Y.Map<unknown>(); blocks.set(id, block); block.set('sys:flavour', flavour);
    block.set('sys:children', Y.Array.from(children));
    if (text !== undefined) block.set(flavour === 'affine:page' ? 'prop:title' : 'prop:text', new Y.Text(text));
  };
  add('page', 'affine:page', '保留稿', ['surface', 'note']); add('note', 'affine:note', undefined, ['later', 'earlier']);
  add('earlier', 'affine:paragraph', '第二段'); add('later', 'affine:paragraph', '第一段');
  add('surface', 'affine:surface'); blocks.get('surface')!.set('prop:elements', new Y.Map([['shape', new Y.Map([['type', 'shape'], ['xywh', '[0,0,100,100]']])]]));
  const bytes = Y.encodeStateAsUpdate(doc), before = bytes.slice();
  assert.deepEqual(snapshotText(bytes), { title: '保留稿', text: '保留稿\n第一段\n第二段' });
  assert.deepEqual(bytes, before);
  const reopened = new Y.Doc(); Y.applyUpdate(reopened, bytes);
  assert.equal((reopened.getMap<Y.Map<unknown>>('blocks').get('surface')!.get('prop:elements') as Y.Map<Y.Map<string>>).get('shape')!.get('xywh'), '[0,0,100,100]');
  doc.destroy(); reopened.destroy();
});

test('text difference retains repeated lines and scoped drafts distinguish restored generations', () => {
  assert.deepEqual(textDifference('标题\n共同段落\n共同段落\n离线段落', '标题\n共同段落\n云端段落'), { draftOnly: '共同段落\n离线段落', currentOnly: '云端段落' });
  assert.deepEqual(parseScope('old:1:document'), { epoch: 'old', generation: 1, docId: 'document' });
  assert.notDeepEqual(parseScope('new:2:document'), parseScope('old:1:document'));
  assert.equal(parseScope('broken'), undefined); assert.equal(parseScope('old:0:document'), undefined);
});
