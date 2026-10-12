import assert from 'node:assert/strict';
import test from 'node:test';
import { dropFileGroup } from '../src/editor/file-drop.js';

test('mixed file drops reach both native handlers in either registration order', () => {
  const image = new File(['image'], 'picture.jpg', { type: 'image/jpeg' });
  const pdf = new File(['pdf'], 'document.pdf', { type: 'application/pdf' });
  for (const order of [[true, false], [false, true]]) {
    const received: File[] = [];
    for (const category of order) {
      if (dropFileGroup({ files: [image, pdf] }, category, props => { received.push(...props.files); return true; })) break;
    }
    assert.equal(received.length, 2);
    assert.deepEqual(new Set(received), new Set([image, pdf]));
  }
  const received: File[][] = [];
  assert.equal(dropFileGroup({ files: [image] }, true, props => { received.push(props.files); return true; }), true);
  assert.equal(dropFileGroup({ files: [pdf] }, true, () => { throw new Error('Wrong handler'); }), false);
  assert.equal(dropFileGroup({ files: [image] }, true, () => false), false);
  assert.deepEqual(received, [[image]]);
});
