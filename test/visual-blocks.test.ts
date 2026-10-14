import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { nativeExportManagerPath, patchNativeExportManager } from '../scripts/native-export-compatibility.js';

function fixture() {
  const views = ['visible', 'outside'].map((id, i) => ({ model: { id }, transformState$: { value: i ? 'idle' : 'active' }, updateComplete: Promise.resolve() }));
  let visible = [views[0].model];
  const selected: { elements: string[] }[] = [];
  const calls: string[][] = [];
  class Viewport {
    getModelsInViewport() { return new Set(visible); }
    setBlocksActive(ids: string[]) { calls.push(ids); for (const view of views) if (ids.includes(view.model.id)) view.transformState$.value = 'active'; }
    setBlocksIdle(ids: string[]) { for (const view of views) if (ids.includes(view.model.id)) view.transformState$.value = 'idle'; }
  }
  const viewport = new Viewport(), gfx = { elementsBound: {}, getElementsByBound: () => views.map(view => view.model), view: { get: (model: { id: string }) => views.find(view => view.model.id === model.id) }, selection: { surfaceSelections: selected } };
  let page = false;
  const scope = { host: { querySelector: () => viewport }, get: () => gfx };
  const source = readFileSync('src/editor/visual-blocks.ts', 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022 });
  const run = new Function('isInsidePageEditor', 'GfxViewportElement', 'GfxControllerIdentifier', 'isGfxBlockComponent', js + ';return withExportBlocks;')(() => page, Viewport, {}, (view: unknown) => views.includes(view as typeof views[number]));
  return { scope, views, run, calls, selected, showOutside: () => { visible = views.map(view => view.model); }, usePage: () => { page = true; } };
}

test('visual export activates culled blocks through the native viewport and restores them on success or failure', async () => {
  const f = fixture();
  assert.equal(await f.run(f.scope, async () => {
    assert.equal(f.views[1].transformState$.value, 'active', 'offscreen Note must participate in rasterization');
    return 'file';
  }), 'file');
  assert.deepEqual(f.calls, [['outside']]); assert.equal(f.views[1].transformState$.value, 'idle');
  await assert.rejects(f.run(f.scope, async () => { throw new Error('resource failed'); }), /resource failed/);
  assert.equal(f.views[1].transformState$.value, 'idle', 'failed exports restore the native view');
  f.usePage(); await f.run(f.scope, async () => {}); assert.equal(f.calls.length, 2, 'page export does not change viewport state');
});

test('export cleanup respects blocks made visible or selected while generating the file', async () => {
  for (const mode of ['viewport', 'selection']) {
    const f = fixture();
    await f.run(f.scope, async () => { if (mode === 'viewport') f.showOutside(); else f.selected.push({ elements: ['outside'] }); });
    assert.equal(f.views[1].transformState$.value, 'active');
  }
});

test('native rasterization refuses a zero-sized block canvas before drawing rather than producing a blank file', () => {
  const source = patchNativeExportManager(readFileSync('node_modules' + nativeExportManagerPath, 'utf8'), '0.22.4');
  const guard = source.slice(source.indexOf('        if (!canvasData.width'), source.indexOf('        ctx.drawImage(\n          canvasData,'));
  assert.notEqual(guard, '');
  const run = new Function('canvasData', guard);
  assert.throws(() => run({ width: 0, height: 10 }), /原内容保留/);
  assert.throws(() => run({ width: 10, height: 0 }), /原内容保留/);
  assert.doesNotThrow(() => run({ width: 10, height: 10 }));
});
