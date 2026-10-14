import { isGfxBlockComponent, type BlockStdScope } from '@blocksuite/affine/std';
import { GfxControllerIdentifier, GfxViewportElement } from '@blocksuite/affine/std/gfx';
import { isInsidePageEditor } from '@blocksuite/affine/shared/utils';

// Native viewport culling gives offscreen Notes a zero-height containment box.
// Activate only their view state while rasterizing, then restore current culling.
export async function withExportBlocks<T>(scope: BlockStdScope, task: () => Promise<T>): Promise<T> {
  if (isInsidePageEditor(scope.host)) return task();
  const viewport = scope.host.querySelector('gfx-viewport');
  if (!(viewport instanceof GfxViewportElement)) throw new Error('画板尚未完成显示，请稍后重试导出');
  const gfx = scope.get(GfxControllerIdentifier);
  const idle = gfx.getElementsByBound(gfx.elementsBound, { type: 'block' }).flatMap(model => {
    const view = gfx.view.get(model);
    return isGfxBlockComponent(view) && view.transformState$.value === 'idle' ? [view] : [];
  });
  const ids = idle.map(view => view.model.id);
  try {
    viewport.setBlocksActive(ids);
    await Promise.all(idle.map(view => view.updateComplete));
    return await task();
  } finally {
    // A member may move the viewport or select a block while exporting.
    const visible = new Set([...viewport.getModelsInViewport()].map(model => model.id));
    const selected = new Set(gfx.selection.surfaceSelections.flatMap(selection => selection.elements));
    viewport.setBlocksIdle(ids.filter(id => !visible.has(id) && !selected.has(id)));
  }
}
