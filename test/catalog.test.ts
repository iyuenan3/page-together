import assert from 'node:assert/strict';
import test from 'node:test';
import { CatalogRefresh } from '../src/app/catalog.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
test('catalog read started before document creation cannot retire that new document', async () => {
  const first = deferred<string[]>(), applied: string[][] = []; let reads = 0;
  const refresh = new CatalogRefresh(() => ++reads === 1 ? first.promise : Promise.resolve(['existing', 'new-doc']), records => applied.push(records));
  const done = refresh.refresh();
  refresh.invalidate(); // native create begins while the older GET is in flight
  first.resolve(['existing']);
  await done;
  assert.deepEqual(applied, [['existing', 'new-doc']]); assert.equal(reads, 2);
});
test('many catalog broadcasts share one request and schedule a fresh read before completion', async () => {
  const first = deferred<string[]>(); let reads = 0, active = 0, peak = 0; const applied: string[][] = [];
  const refresh = new CatalogRefresh(async () => { reads++; peak = Math.max(peak, ++active); const result = reads === 1 ? await first.promise : ['new-state']; active--; return result; }, records => applied.push(records));
  const calls = Array.from({ length: 40 }, () => refresh.refresh());
  first.resolve(['old-state']); await Promise.all(calls);
  assert.equal(reads, 2); assert.equal(peak, 1); assert.deepEqual(applied.at(-1), ['new-state']);
});
