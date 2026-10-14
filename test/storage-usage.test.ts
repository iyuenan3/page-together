import assert from 'node:assert/strict';
import test from 'node:test';
import { StorageUsage, validStorageUsage } from '../src/app/storage-usage.js';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('storage estimates preserve real pressure above quota and reject unavailable measurements', () => {
  assert.equal(validStorageUsage({ usage: 95, quota: 100 })!.ratio, 0.95);
  assert.equal(validStorageUsage({ usage: 101, quota: 100 })!.ratio, 1.01);
  for (const value of [{}, { usage: 1, quota: 0 }, { usage: -1, quota: 100 }, { usage: Infinity, quota: 10 }, { usage: 1, quota: NaN }]) assert.equal(validStorageUsage(value), undefined);
});

test('a failed later measurement retains high pressure and a subsequent valid reading recovers', async () => {
  let value: StorageEstimate | undefined = { usage: 95, quota: 100 };
  const usage = new StorageUsage(async () => { if (!value) throw new Error('unavailable'); return value; });
  await usage.refresh(); assert.equal(usage.value!.ratio, 0.95);
  value = undefined; await usage.refresh(); assert(usage.failed); assert.equal(usage.value!.ratio, 0.95);
  value = { usage: 30, quota: 100 }; await usage.refresh(); assert(!usage.failed); assert.equal(usage.value!.ratio, 0.3);
  usage.stop();
});

test('concurrent estimates coalesce and stopped observers never publish a late result', async () => {
  let release!: (value: StorageEstimate) => void, calls = 0, notifications = 0;
  const usage = new StorageUsage(() => { calls++; return new Promise(resolve => { release = resolve; }); }); usage.onChange = () => { notifications++; };
  const first = usage.refresh(); assert.equal(usage.refresh(), first); await Promise.resolve(); assert.equal(calls, 1);
  usage.stop(); release({ usage: 95, quota: 100 }); await first; assert.equal(notifications, 0); assert.equal(usage.value, undefined);
});

test('stalled estimates time out without changing the last successful reading', async () => {
  let stall = false;
  const usage = new StorageUsage(() => stall ? new Promise(() => {}) : Promise.resolve({ usage: 95, quota: 100 }), 5);
  await usage.refresh(); stall = true; await usage.refresh(); assert(usage.failed); assert.equal(usage.value!.ratio, 0.95); usage.stop();
});

test('the production storage indicator warns at 90 percent, retains a failed estimate and stops its observers', async () => {
  const source = ts.createSourceFile('storage-usage.ts', readFileSync('src/app/storage-usage.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'observeStorageUsage')!;
  const code = ts.transpile(fn.getText(source).replace('export ', ''), { target: ts.ScriptTarget.ES2022 });
  const elements: any[] = [], listeners = new Set<() => void>();
  let value: StorageEstimate | undefined, interval!: () => void, cleared = false;
  const document = { visibilityState: 'visible', createElement: () => {
    const element = { textContent: '', dataset: {}, isConnected: true, setAttribute() {}, append() {}, remove() { this.isConnected = false; } }; elements.push(element); return element;
  }, addEventListener: (_name: string, callback: () => void) => listeners.add(callback), removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback) };
  const run = new Function('StorageUsage', 'document', 'navigator', 'setInterval', 'clearInterval', code + ';return observeStorageUsage;')(
    StorageUsage, document, { storage: { estimate: async () => { if (!value) throw new Error('unavailable'); return value; } } }, (callback: () => void) => { interval = callback; return 7; }, (id: number) => { assert.equal(id, 7); cleared = true; });
  const observer = run({ append() {} }); await observer.refresh();
  const [section, status, button] = elements;
  assert.match(status.textContent, /未提供存储估算/);
  value = { usage: 90_000_000, quota: 100_000_000 }; button.onclick(); await observer.refresh();
  assert.equal(section.dataset.pressure, 'high'); assert.match(status.textContent, /90%/); assert.match(status.textContent, /保留页面并导出/);
  value = undefined; interval(); await observer.refresh(); assert.equal(section.dataset.pressure, 'high'); assert.match(status.textContent, /上次估算/);
  value = { usage: 10_000_000, quota: 100_000_000 }; await observer.refresh(); assert.equal(section.dataset.pressure, 'normal'); assert.doesNotMatch(status.textContent, /接近配额/);
  observer.stop(); assert(cleared); assert.equal(listeners.size, 0); assert.equal(section.isConnected, false);
});
