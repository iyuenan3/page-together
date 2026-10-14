export const nativeSurfacePlaceholderPath = '/@blocksuite/affine-block-surface-ref/src/components/placeholder.ts';
export function patchNativeSurfacePlaceholder(source: string, version: string) {
  if (version !== '0.22.4') throw new Error('Review surface reference placeholders before upgrading BlockSuite');
  const before = 'The ${matchedType.name.toLowerCase()} is inserted but cannot display in edgeless mode. Switch to page mode to view the block.';
  if (source.split(before).length !== 2) throw new Error('Native surface placeholder changed; review the pinned source');
  return source.replace(before, 'Preview is unavailable here. View this ${matchedType.name.toLowerCase()} on the canvas.');
}
