import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfPageScale } from './pdf-layout';

/** Shared by cached previews and native attachment embeds. Never runs PDF actions. */
export class PdfPreview extends HTMLElement {
  private input?: Blob | string;
  private stop?: () => void;
  label = 'PDF';
  set source(value: Blob | string) {
    if (this.input === value) return;
    this.input = value;
    if (this.isConnected) this.start();
  }
  connectedCallback() { this.contentEditable = 'false'; this.start(); }
  disconnectedCallback() { this.stop?.(); this.stop = undefined; }

  private start() {
    this.stop?.();
    const source = this.input; if (!source) return;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = ':host{display:block;background:#f2f4f3;color:#19251f;padding:12px;box-sizing:border-box;font:14px/1.5 system-ui}nav{display:flex;align-items:center;gap:12px;flex-wrap:wrap}nav,details{position:relative;z-index:2}button,a{font:inherit}canvas{display:block;max-width:100%;height:auto;margin:12px auto;background:white}canvas[hidden]{display:none}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}p{margin:8px 0}';
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = '正在读取 PDF';
    const nav = document.createElement('nav'); nav.setAttribute('aria-label', 'PDF 翻页');
    const previous = document.createElement('button'); previous.textContent = '上一页'; previous.disabled = true;
    const next = document.createElement('button'); next.textContent = '下一页'; next.disabled = true;
    const counter = document.createElement('span');
    const canvas = document.createElement('canvas'); canvas.hidden = true; canvas.setAttribute('role', 'img');
    const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('pre');
    summary.textContent = '本页文字'; details.append(summary, text);
    // Keep read-only controls above the native Note mask without disabling selection.
    for (const controls of [nav, details]) for (const kind of ['pointerdown', 'mousedown', 'click']) controls.addEventListener(kind, event => event.stopPropagation());
    nav.append(previous, counter, next); root.append(style, status, nav, canvas, details);
    let disposed = false, task: PDFDocumentLoadingTask | undefined, pdf: PDFDocumentProxy | undefined, render: RenderTask | undefined, pageNumber = 1;
    const abort = new AbortController();
    const release = () => { disposed = true; abort.abort(); render?.cancel(); void task?.destroy().catch(() => {}); canvas.width = canvas.height = 0; };
    const fail = () => { if (!disposed) { status.textContent = 'PDF 无法预览、已加密或渲染超时，请下载原文件查看'; previous.disabled = next.disabled = true; canvas.hidden = true; } };
    const timer = setTimeout(() => { fail(); release(); }, 30_000);
    this.stop = () => { clearTimeout(timer); release(); };
    const draw = async (number: number) => {
      if (!pdf || disposed) return;
      previous.disabled = next.disabled = true; status.textContent = '正在绘制 PDF';
      const deadline = setTimeout(() => { fail(); release(); }, 30_000);
      try {
        const page = await pdf.getPage(number); if (disposed) return;
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: pdfPageScale(original.width, original.height, this.clientWidth || 800, devicePixelRatio) });
        canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable');
        canvas.setAttribute('aria-label', `${this.label} 第 ${number} 页`);
        render = page.render({ canvasContext: context, canvas, viewport }); await render.promise;
        if (disposed) return;
        canvas.hidden = false; counter.textContent = `第 ${number} / ${pdf.numPages} 页`; status.textContent = 'PDF 已显示';
        text.textContent = '';
        try { const content = await page.getTextContent(); if (!disposed) text.textContent = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').slice(0, 128 * 1024) || '此页没有可提取文字'; } catch { if (!disposed) text.textContent = '此页文字无法提取，请查看页面或下载原文件'; }
        page.cleanup();
        if (!disposed) { previous.disabled = number <= 1; next.disabled = number >= pdf.numPages; }
      } catch { fail(); }
      finally { clearTimeout(deadline); }
    };
    previous.onclick = () => { void draw(--pageNumber); }; next.onclick = () => { void draw(++pageNumber); };
    void (async () => {
      try {
        if (typeof source === 'string' && (!source.startsWith('blob:') || new URL(source).origin !== location.origin)) throw new Error('Only cached PDF bytes are allowed');
        const [library, bytes] = await Promise.all([import('pdfjs-dist'), typeof source === 'string' ? fetch(source, { signal: abort.signal }).then(response => response.arrayBuffer()) : source.arrayBuffer()]);
        if (disposed) return;
        library.GlobalWorkerOptions.workerSrc = workerUrl;
        const assets = new URL(`${import.meta.env.BASE_URL}assets/pdfjs-${library.version}/`, location.href).href;
        task = library.getDocument({ data: new Uint8Array(bytes), cMapUrl: assets + 'cmaps/', standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/', iccUrl: assets + 'iccs/', enableXfa: false, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 16_000_000 });
        task.onPassword = () => { clearTimeout(timer); fail(); release(); };
        pdf = await task.promise; clearTimeout(timer); if (!disposed) await draw(1);
      } catch { clearTimeout(timer); fail(); release(); }
    })();
  }
}
customElements.define('page-together-pdf', PdfPreview);
