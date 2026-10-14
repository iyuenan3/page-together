export const nativeFontPath = '/@blocksuite/affine-block-surface/src/utils/font.ts';
export function patchNativeFontFallback(source: string, version: string) {
  if (version !== '0.22.4') throw new Error('Review the native text font stack before upgrading BlockSuite');
  const before = 'return `"${fontFamily}"`;';
  if (source.split(before).length !== 2) throw new Error('Native font wrapper changed; review the pinned source');
  return source.replace(before, 'return `"${fontFamily}", "pageTogether Han Supplement", sans-serif`;');
}
