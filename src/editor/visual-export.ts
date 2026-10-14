import { ExportManager } from '@blocksuite/affine/blocks/surface';
import { FontLoaderService } from '@blocksuite/affine/shared/services';
import { isInsidePageEditor } from '@blocksuite/affine/shared/utils';
import { StdIdentifier, type BlockStdScope } from '@blocksuite/affine/std';
import { GfxControllerIdentifier } from '@blocksuite/affine/std/gfx';
import { createIdentifier, parseIdentifier } from '@blocksuite/affine/global/di';
import type { ExtensionType } from '@blocksuite/affine/store';
import { visualExportEvent } from '../../scripts/native-export-compatibility';
import { decodeVisualImage, fetchVisualImage, fitVisualImage, inlineVisualImage, visualFile } from './visual-resources';
import { normalizeVisualColors } from './visual-colors';
import { withExportBlocks } from './visual-blocks';

export class VisualExportManager extends ExportManager {
  private readonly images = new Map<string, Promise<string>>();
  private current() {
    if (!this.editorHost.isConnected || this.editorHost.std !== this.std) throw new Error('导出页面已变化，请在当前文档重新导出');
  }
  private image(url: string) {
    let value = this.images.get(url);
    if (!value) { value = fetchVisualImage(url).then(blob => inlineVisualImage(blob)); this.images.set(url, value); }
    return value;
  }
  private async prepare() {
    this.images.clear(); this.current();
    if (document.querySelector('meta[name="darkreader"], style.darkreader')) throw new Error('页面样式扩展会影响视觉导出。请在未启用样式扩展的窗口打开文档后重试，原内容保留。');
    let timer: ReturnType<typeof setTimeout>;
    try {
      const faces = this.std.get(FontLoaderService).fontFaces;
      const families = isInsidePageEditor(this.editorHost) ? new Set<string>() : new Set(this.std.get(GfxControllerIdentifier).getElementsByBound(this.std.get(GfxControllerIdentifier).elementsBound).flatMap(model => 'fontFamily' in model && typeof model.fontFamily === 'string' ? [model.fontFamily] : []));
      families.add('pageTogether Han Supplement');
      await Promise.race([
        Promise.all([document.fonts.ready, ...faces.filter(face => families.has(face.family.replace(/^['"]|['"]$/g, ''))).map(face => face.loaded)]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('字体尚未加载完成，请稍后重试导出')), 20_000); }),
      ]);
    } catch {
      throw new Error('字体尚未加载完成或加载失败，导出已停止。请恢复字体资源后重试。');
    } finally { clearTimeout(timer!); }
    this.current();
    if ([...this.editorHost.querySelectorAll('page-together-data-view-image')].some(element => element.querySelector('button') && element.getClientRects().length)) throw new Error('有图片加载失败，导出已停止。请恢复图片资源后重试，原内容保留。');
    const urls = [...new Set([...this.editorHost.querySelectorAll('img')].filter(image => image.getClientRects().length).map(image => image.currentSrc || image.src).filter(Boolean))];
    let next = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, urls.length) }, async () => {
      for (;;) {
        const url = urls[next++]; if (!url) return;
        try { await this.image(url); }
        catch { throw new Error('有图片无法读取或不允许用于导出，导出已停止。请恢复资源或改用允许跨源读取的图片，原内容保留。'); }
        this.current();
      }
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  override replaceImgSrcWithSvg = async (element: HTMLElement) => {
    this.current();
    // html2canvas clones custom elements into inert containers. Inline only the
    // cloned images, leaving the live editor and stored URLs untouched.
    await Promise.all([...element.querySelectorAll('img')].map(async image => {
      const url = image.currentSrc || image.src;
      if (url) {
        const data = await this.image(url);
        image.src = image.hasAttribute('data-page-together-image') ? await fitVisualImage(image, data) : data;
        // The native parser snapshots naturalWidth/Height synchronously.
        // Safari resets both while a newly generated PNG is still decoding.
        await decodeVisualImage(image);
      }
    }));
    normalizeVisualColors(element);
    this.current();
  };
  override async exportPng() {
    try { await withExportBlocks(this.std, async () => { await this.prepare(); await super.exportPng(); }); }
    finally { this.images.clear(); }
  }
  override async exportPdf() {
    try { await withExportBlocks(this.std, async () => { await this.prepare(); await super.exportPdf(); }); }
    finally { this.images.clear(); }
  }
}
export const VisualExportExtension: ExtensionType = {
  setup: di => {
    const identifier = parseIdentifier(ExportManager);
    di.override(createIdentifier<ExportManager>(identifier.identifierName, identifier.variant), VisualExportManager, [StdIdentifier]);
  },
};

export async function captureVisualExport(scope: BlockStdScope, format: 'png' | 'pdf') {
  let file: { name: string; data: Blob; label: string } | undefined, failure: Error | undefined;
  const capture = (event: Event) => {
    event.preventDefault();
    try {
      if (!scope.host.isConnected || scope.host.std !== scope) throw new Error('导出页面已变化，请重新导出');
      const detail = (event as CustomEvent<{ filename: string; dataURL: string }>).detail;
      file = { name: detail.filename, data: visualFile(detail.dataURL, format), label: `下载 ${format.toUpperCase()}` };
    } catch (error) { failure = error instanceof Error ? error : new Error('导出文件无法读取'); }
  };
  document.addEventListener(visualExportEvent, capture);
  try {
    const manager = scope.get(ExportManager);
    if (format === 'png') await manager.exportPng(); else await manager.exportPdf();
    if (failure) throw failure;
    if (!file) throw new Error('导出未生成文件，请等待资源加载完成后重试');
    return file;
  } finally { document.removeEventListener(visualExportEvent, capture); }
}
