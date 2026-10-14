export const nativeExportManagerPath = '/@blocksuite/affine-block-surface/src/extensions/export-manager/export-manager.ts';
export const nativeFileExporterPath = '/@blocksuite/affine-block-surface/src/extensions/export-manager/file-exporter.ts';
export const visualExportEvent = 'page-together-visual-export';

function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('BlockSuite visual export source changed; review the pinned version before building');
  return source.replace(before, after);
}
function versionCheck(version: string) {
  if (version !== '0.22.4') throw new Error('Review native visual export before upgrading BlockSuite');
}
export function patchNativeExportManager(source: string, version: string) {
  versionCheck(version);
  source = replace(source, 'imageProxyEndpoint: DEFAULT_IMAGE_PROXY_ENDPOINT,', "imageProxyEndpoint: '',");
  source = replace(source, 'if (count > 10 * 60)', 'if (count >= 100)');
  source = replace(source, '        ctx.drawImage(\n          canvasData,', "        if (!canvasData.width || !canvasData.height) throw new Error('部分画板区块尚未完成显示，导出已停止，请稍后重试，原内容保留。');\n        ctx.drawImage(\n          canvasData,");
  return replace(source, '      await this._checkReady();', "      if (!await this._checkReady()) throw new Error('Export resources are not ready');");
}
export function patchNativeFileExporter(source: string, version: string) {
  versionCheck(version);
  return replace(source, '    const safeFilename = getSafeFileName(filename);', `    const safeFilename = getSafeFileName(filename);
    if (!document.dispatchEvent(new CustomEvent('${visualExportEvent}', {
      cancelable: true, detail: { filename: safeFilename, dataURL },
    }))) return;`);
}
