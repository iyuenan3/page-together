/** Preview only known passive formats. Active documents are displayed as text. */
export type AttachmentPreview = { kind: 'image' | 'pdf' | 'audio' | 'video' | 'text'; mime: string };
export const TEXT_PREVIEW_BYTES = 128 * 1024;
const formats: Record<string, AttachmentPreview> = {
  png: { kind: 'image', mime: 'image/png' }, jpg: { kind: 'image', mime: 'image/jpeg' }, jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' }, webp: { kind: 'image', mime: 'image/webp' }, avif: { kind: 'image', mime: 'image/avif' }, bmp: { kind: 'image', mime: 'image/bmp' }, svg: { kind: 'image', mime: 'image/svg+xml' },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' }, wav: { kind: 'audio', mime: 'audio/wav' }, ogg: { kind: 'audio', mime: 'audio/ogg' }, m4a: { kind: 'audio', mime: 'audio/mp4' }, flac: { kind: 'audio', mime: 'audio/flac' },
  mp4: { kind: 'video', mime: 'video/mp4' }, webm: { kind: 'video', mime: 'video/webm' }, mov: { kind: 'video', mime: 'video/quicktime' },
};
const textExtensions = new Set(['txt', 'md', 'csv', 'json', 'log', 'html', 'htm', 'xml', 'css', 'js', 'ts', 'yaml', 'yml']);
export function attachmentPreview(name = '', type = ''): AttachmentPreview | undefined {
  const mime = type.toLowerCase().split(';')[0].trim();
  if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mime)) return { kind: 'text', mime: 'text/plain' };
  const known = Object.values(formats).find(format => format.mime === mime);
  if (known) return known;
  if (mime && mime !== 'application/octet-stream') return undefined;
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return textExtensions.has(extension) ? { kind: 'text', mime: 'text/plain' } : formats[extension];
}
/** Native image blocks can omit filename/MIME metadata on another member's device. */
export async function cachedAttachmentPreview(name: string, type: string, blob: Blob) {
  const known = attachmentPreview(name, type);
  if (known || type && type.toLowerCase().split(';')[0].trim() !== 'application/octet-stream') return known;
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const starts = (signature: number[], offset = 0) => signature.every((byte, index) => bytes[index + offset] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return formats.png;
  if (starts([255, 216, 255])) return formats.jpg;
  const header = new TextDecoder('ascii').decode(bytes);
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return formats.gif;
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return formats.webp;
  return undefined;
}
export async function attachmentText(blob: Blob) {
  const truncated = blob.size > TEXT_PREVIEW_BYTES;
  const bytes = await blob.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
  if (text.includes('\0')) throw new Error('该文件不是可预览的 UTF-8 文本，请下载原文件');
  return { text, truncated };
}
