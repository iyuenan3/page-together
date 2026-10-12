import assert from 'node:assert/strict';
import test from 'node:test';
import { pdfPageScale } from '../src/editor/pdf-layout.js';

test('PDF page allocation bounds tall, wide and huge pages before creating a canvas', () => {
  for (const [width, height] of [[612, 792], [792, 612], [10, 1e6], [1e6, 10], [1e6, 1e6]]) {
    const scale = pdfPageScale(width, height, 800, 3);
    assert(width * scale <= 4096); assert(height * scale <= 4096);
    assert(width * height * scale ** 2 <= 4_000_001);
    assert(width * scale <= 1600);
  }
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => pdfPageScale(value, 792, 800));
});
