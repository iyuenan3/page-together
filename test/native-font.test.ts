import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { patchNativeFontFallback } from '../scripts/native-font-compatibility.js';

test('native measuring, editing and canvas rendering use a fallback without changing the stored font family', () => {
  const source = readFileSync('node_modules/@blocksuite/affine-block-surface/src/utils/font.ts', 'utf8');
  const patched = patchNativeFontFallback(source, '0.22.4');
  const file = ts.createSourceFile('font.ts', patched, ts.ScriptTarget.Latest, true);
  const wrap = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'wrapFontFamily')!;
  const code = ts.transpile(wrap.getText(file), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
  const fn = new Function('exports', code + '; return wrapFontFamily;')({});
  for (const family of ['Inter', 'Lora', 'Kalam']) assert.equal(fn(family), `"${family}", "pageTogether Han Supplement", sans-serif`);
  assert.throws(() => patchNativeFontFallback(source, '0.27.5'));
  assert.throws(() => patchNativeFontFallback(source.replace('return `"${fontFamily}"`;', ''), '0.22.4'));
});

test('shipped supplementary glyphs have their exact binary, explicit coverage and original license', () => {
  const coverage = JSON.parse(readFileSync('public/assets/han-coverage.json', 'utf8'));
  const bytes = readFileSync('public/assets/page-together-han-supplement.woff2');
  assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), coverage.sha256);
  assert(coverage.ranges.some(([start, end]: number[]) => start <= 0x20000 && end >= 0x20000));
  assert.equal(coverage.ranges.reduce((sum: number, [start, end]: number[]) => sum + end - start + 1, 0), coverage.characters);
  assert(coverage.characters > 30_000);
  assert(readFileSync('public/assets/HAN-LICENSE.txt', 'utf8').includes('ARPHIC PUBLIC LICENSE'));
});
