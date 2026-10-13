import { MAX_ATTACHMENT_BYTES } from '../../shared/attachments';

/** Fetch directly with browser CORS enforcement. Never send a URL to a proxy. */
export async function fetchVisualImage(url: string, origin = location.origin, timeout = 10_000, limit = MAX_ATTACHMENT_BYTES): Promise<Blob> {
  const parsed = new URL(url, origin);
  if (!['http:', 'https:', 'blob:', 'data:'].includes(parsed.protocol)) throw new Error('图片地址无法用于导出');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(parsed.href, {
      mode: 'cors', credentials: parsed.origin === origin ? 'same-origin' : 'omit',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok || response.type === 'opaque') throw new Error('图片资源无法读取');
    const type = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (type && !type.startsWith('image/') && type !== 'application/octet-stream') throw new Error('图片响应类型无法用于导出');
    if (Number(response.headers.get('content-length')) > limit) throw new Error('图片超过导出读取限额');
    if (!response.body) throw new Error('图片没有可读取内容');
    const reader = response.body.getReader(), chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { controller.abort(); throw new Error('图片超过导出读取限额'); }
        chunks.push(new Uint8Array(value).buffer);
      }
    } finally { reader.releaseLock(); }
    return new Blob(chunks, { type });
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Decode the exact bytes before handing them to the native DOM rasterizer. */
export async function inlineVisualImage(blob: Blob, timeout = 10_000): Promise<string> {
  // Preserve the native SVG normalization. A viewBox-only SVG otherwise uses
  // the browser's default intrinsic size in html2canvas and can lose detail.
  if (blob.type === 'image/svg+xml') {
    const svg = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').documentElement;
    if (svg.localName !== 'svg') throw new Error('SVG 图片内容无效');
    if (!svg.hasAttribute('width') && !svg.hasAttribute('height')) {
      const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
        svg.setAttribute('width', `${viewBox[2]}px`); svg.setAttribute('height', `${viewBox[3]}px`);
      }
    }
    blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: blob.type });
  }
  const reader = new FileReader(), image = new Image();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('图片解码超时，请稍后重试')), timeout);
      reader.onerror = () => reject(new Error('图片内容无法读取'));
      reader.onload = () => {
        const value = String(reader.result);
        image.onload = () => image.naturalWidth && image.naturalHeight ? resolve(value) : reject(new Error('图片内容无效'));
        image.onerror = () => reject(new Error('图片内容无法解码'));
        image.src = value;
      };
      reader.readAsDataURL(blob);
    });
  } finally { clearTimeout(timer!); reader.abort(); image.onload = image.onerror = null; image.src = ''; }
}

export function visualFile(dataURL: string, format: 'png' | 'pdf'): Blob {
  const type = format === 'png' ? 'image/png' : 'application/pdf';
  const prefix = `data:${type};base64,`;
  if (!dataURL.startsWith(prefix)) throw new Error('导出文件格式不匹配');
  const bytes = Uint8Array.from(atob(dataURL.slice(prefix.length)), character => character.charCodeAt(0));
  const signature = format === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [37, 80, 68, 70, 45];
  if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error('导出文件内容无效');
  return new Blob([bytes], { type });
}

export function containImage(width: number, height: number, naturalWidth: number, naturalHeight: number) {
  if (![width, height, naturalWidth, naturalHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片导出尺寸无效');
  const scale = Math.min(width / naturalWidth, height / naturalHeight);
  const w = naturalWidth * scale, h = naturalHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

export async function decodeVisualImage(image: HTMLImageElement, timeout = 10_000) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('图片解码超时，请稍后重试')), timeout); }),
    ]);
  } finally { clearTimeout(timer!); }
}

/** html2canvas does not implement object-fit. Pre-render our image cells into
 * their cloned display boxes so neither thumbnails nor covers are stretched. */
export async function fitVisualImage(image: HTMLImageElement, dataURL: string) {
  const view = image.ownerDocument.defaultView;
  if (!view || view.getComputedStyle(image).objectFit !== 'contain') return dataURL;
  const { width, height } = image.getBoundingClientRect();
  if (!width || !height) return dataURL;
  const decoded = new Image();
  let timer: ReturnType<typeof setTimeout>;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('图片布局解码超时')), 10_000);
      decoded.onload = () => resolve(); decoded.onerror = () => reject(new Error('图片布局无法解码')); decoded.src = dataURL;
    });
    await decodeVisualImage(decoded);
    const box = containImage(width, height, decoded.naturalWidth, decoded.naturalHeight);
    const dpr = view.devicePixelRatio || 1, pixels = { w: Math.ceil(width * dpr), h: Math.ceil(height * dpr) };
    if (pixels.w * pixels.h > 16_000_000) throw new Error('图片导出尺寸过大，请缩小显示尺寸后重试');
    const canvas = image.ownerDocument.createElement('canvas'); canvas.width = pixels.w; canvas.height = pixels.h;
    const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法排版导出图片');
    context.scale(canvas.width / width, canvas.height / height); context.drawImage(decoded, box.x, box.y, box.w, box.h);
    image.style.width = `${width}px`; image.style.height = `${height}px`; image.style.maxHeight = 'none'; image.style.objectFit = 'fill';
    return canvas.toDataURL('image/png');
  } finally { clearTimeout(timer!); decoded.onload = decoded.onerror = null; decoded.src = ''; }
}
