import { cachedAttachmentPreview, attachmentText } from './attachment-preview';

/** Uses cached bytes only; no remote embeds or document writes. */
export async function showAttachmentPreview(name: string, type: string, blob: Blob, download: () => void) {
  const box = document.createElement('dialog'); box.className = 'attachment-preview-dialog'; box.setAttribute('aria-label', '附件预览');
  const title = document.createElement('h2'); title.textContent = name;
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const content = document.createElement('div'); content.className = 'attachment-preview-content';
  const original = document.createElement('button'); original.textContent = '下载原文件'; original.onclick = download;
  const close = document.createElement('button'); close.textContent = '关闭预览'; close.onclick = () => box.close();
  let url: string | undefined, closed = false;
  box.addEventListener('close', () => {
    closed = true;
    for (const media of content.querySelectorAll('audio,video')) { const player = media as HTMLMediaElement; player.pause(); player.removeAttribute('src'); player.load(); }
    if (url) URL.revokeObjectURL(url); box.remove();
  });
  box.append(title, status, content, original, close); document.body.append(box); box.showModal();
  try {
    const preview = await cachedAttachmentPreview(name, type || blob.type, blob); if (closed) return;
    if (!preview) { status.textContent = '此格式暂不支持浏览器预览，请下载原文件'; return; }
    if (preview.kind === 'pdf' && !navigator.pdfViewerEnabled) { status.textContent = '当前浏览器没有启用 PDF 阅读器，请下载原文件查看'; return; }
    if (preview.kind === 'text') {
      const value = await attachmentText(blob); if (closed) return;
      const text = document.createElement('pre'); text.textContent = value.text; content.append(text);
      status.textContent = value.truncated ? '仅预览前 128 KiB，下载原文件可查看完整内容' : 'UTF-8 纯文本预览';
      return;
    }
    url = URL.createObjectURL(new Blob([blob], { type: preview.mime }));
    const node = document.createElement(preview.kind === 'image' ? 'img' : preview.kind === 'pdf' ? 'iframe' : preview.kind);
    node.setAttribute('src', url);
    node.addEventListener('error', () => { status.textContent = '文件无法预览或浏览器不支持此编码，请下载原文件'; });
    if (node instanceof HTMLImageElement) { node.alt = name; node.onload = () => { status.textContent = '图片预览'; }; }
    else if (node instanceof HTMLIFrameElement) { node.title = 'PDF 预览：' + name; status.textContent = 'PDF 预览由浏览器提供，无法显示时可下载原文件'; }
    else { const player = node as HTMLMediaElement; player.controls = true; player.preload = 'metadata'; player.onloadedmetadata = () => { status.textContent = '可使用播放控件预览'; }; }
    content.append(node);
  } catch { if (!closed) status.textContent = '文件无法预览或不是 UTF-8 文本，请下载原文件'; }
}
