import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { signal } from '@preact/signals-core';
import { nativeNumberCellPath, patchNativeNumberCell } from '../scripts/native-data-view-compatibility.js';

const source = readFileSync('node_modules' + nativeNumberCellPath, 'utf8');
const patched = patchNativeNumberCell(source, '0.22.4');
const formatterSource = readFileSync('node_modules/@blocksuite/data-view/src/property-presets/number/utils/formatter.ts', 'utf8');
const formatter: Record<string, (...args: unknown[]) => unknown> = {};
new Function('exports', 'require', 'navigator', ts.transpile(formatterSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }))(formatter, createRequire(import.meta.url), { language: 'en-US' });

function nativeCell(code: string, value: number, format: string, decimal = 2) {
  const getter = code.match(/  private _getFormattedString\([\s\S]*?\n  }/)![0];
  const setter = code.match(/  private readonly _setValue = [\s\S]*?\n  };/)![0];
  const input = code.match(/      const formatted = .*;/)![0];
  const js = ts.transpile(`class Cell { ${getter}\n${setter}\nrenderInput() { ${input}\nreturn formatted; } }`, { target: ts.ScriptTarget.ES2022 });
  const cell = new Function('parseNumber', 'formatNumber', js + ';return new Cell();')(formatter.parseNumber, formatter.formatNumber);
  Object.assign(cell, { value, view: { featureFlags$: signal({ enable_number_formatting: true }) }, property: { data$: signal({ format, decimal }) }, valueSetNextTick(next: number | undefined) { cell.value = next; } });
  cell._inputEle = { value: cell.renderInput() };
  return cell;
}

test('actual native percent editor retains unchanged value and accepts explicit percent input', () => {
  const cell = nativeCell(patched, 0.375, 'percent');
  assert.equal(cell._inputEle.value, '37.50%'); cell._setValue(); assert.equal(cell.value, 0.375);
  cell._setValue('12.50%'); assert.equal(cell.value, 0.125);
  cell._setValue('0.5'); assert.equal(cell.value, 0.5);
  const original = nativeCell(source, 0.375, 'percent'); original._setValue(); assert.equal(original.value, 37.5);
});
test('native rounded currency retains raw precision on unchanged edit while explicit input still updates', () => {
  const cell = nativeCell(patched, 1234.567, 'currencyCNY');
  assert.match(cell._inputEle.value, /1,234\.57/); cell._setValue(); assert.equal(cell.value, 1234.567);
  cell._setValue('¥2,345.678'); assert.equal(cell.value, 2345.678);
  const original = nativeCell(source, 1234.567, 'currencyCNY'); original._setValue(); assert.equal(original.value, 1234.57);
});
test('native zero renders in the editor, survives unchanged blur and explicit clear still removes it', () => {
  const cell = nativeCell(patched, 0, 'number', 0);
  assert.equal(cell._inputEle.value, '0'); cell._setValue(); assert.equal(cell.value, 0);
  cell._setValue('invalid'); assert.equal(cell._inputEle.value, '0'); assert.equal(cell.value, 0);
  cell._setValue(''); assert.equal(cell.value, undefined);
  const original = nativeCell(source, 0, 'number', 0); assert.equal(original._inputEle.value, ''); original._setValue(); assert.equal(original.value, undefined);
});
test('number compatibility refuses source or version drift', () => {
  assert.throws(() => patchNativeNumberCell(source, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativeNumberCell(source.replace('if (!str)', 'if (false)'), '0.22.4'), /source changed/);
});
