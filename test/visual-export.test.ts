import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { nativeExportManagerPath, nativeFileExporterPath, patchNativeExportManager, patchNativeFileExporter, visualExportEvent } from '../scripts/native-export-compatibility.js';

function evaluate(path: string, names: string, dependencies: Record<string, unknown> = {}) {
  const source = readFileSync(path, 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
  return new Function(...Object.keys(dependencies), js + `;return {${names}};`)(...Object.values(dependencies));
}
const resources = evaluate('src/editor/visual-resources.ts', 'fetchVisualImage, visualFile, containImage, decodeVisualImage', { MAX_ATTACHMENT_BYTES: 50_000_000 });
const png = 'data:image/png;base64,iVBORw0KGgo=';
const pdf = 'data:application/pdf;base64,JVBERi0=';

test('visual files validate actual format and signature before offering a download', async () => {
  assert.equal(resources.visualFile(png, 'png').type, 'image/png');
  assert.equal(resources.visualFile(pdf, 'pdf').type, 'application/pdf');
  assert.equal((await resources.visualFile(png, 'png').arrayBuffer()).byteLength, 8);
  assert.throws(() => resources.visualFile(pdf, 'png'), /格式/);
  assert.throws(() => resources.visualFile('data:image/png;base64,YmFk', 'png'), /内容/);
});

test('viewBox-only SVGs receive intrinsic dimensions before the rasterizer decodes cloned bytes', async () => {
  const attributes = new Map([['viewBox', '0 0 120 80']]);
  const svg = { localName: 'svg', hasAttribute: (key: string) => attributes.has(key), getAttribute: (key: string) => attributes.get(key), setAttribute: (key: string, value: string) => attributes.set(key, value) };
  class Reader {
    result = ''; onload = () => {}; onerror = () => {};
    readAsDataURL(blob: Blob) { void blob.text().then(text => { this.result = text; this.onload(); }); }
    abort() {}
  }
  class Decoded {
    naturalWidth = 120; naturalHeight = 80; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(value: string) { if (value) this.onload?.(); }
  }
  const { inlineVisualImage } = evaluate('src/editor/visual-resources.ts', 'inlineVisualImage', {
    DOMParser: class { parseFromString() { return { documentElement: svg }; } },
    XMLSerializer: class { serializeToString() { return JSON.stringify(Object.fromEntries(attributes)); } },
    FileReader: Reader, Image: Decoded,
  });
  const output = JSON.parse(await inlineVisualImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })));
  assert.equal(output.width, '120px'); assert.equal(output.height, '80px');
  attributes.set('width', '240'); attributes.set('height', '160');
  const sized = JSON.parse(await inlineVisualImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })));
  assert.equal(sized.width, '240'); assert.equal(sized.height, '160');
});

test('visual image acquisition goes directly to the source with CORS, no referrer and bounded bytes', async t => {
  const calls: { url: string; options: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls.push({ url, options });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  });
  for (const url of ['https://images.example.test/image.png', 'https://app.example.test/image.png']) {
    assert.equal((await resources.fetchVisualImage(url, 'https://app.example.test', 100, 3)).size, 3);
  }
  assert.equal(calls[0].url, 'https://images.example.test/image.png');
  assert.equal(calls[0].options.mode, 'cors'); assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[1].options.credentials, 'same-origin'); assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].options.cache, 'no-store');
  await assert.rejects(resources.fetchVisualImage('file:///image.png', 'https://app.example.test'), /地址/);
  await assert.rejects(resources.fetchVisualImage('https://images.example.test/image.png', 'https://app.example.test', 100, 2), /限额/);
  t.mock.method(globalThis, 'fetch', async () => new Response('bad', { status: 404 }));
  await assert.rejects(resources.fetchVisualImage('https://images.example.test/missing.png', 'https://app.example.test'), /无法读取/);
  t.mock.method(globalThis, 'fetch', async () => new Response('bad', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(resources.fetchVisualImage('https://images.example.test/html', 'https://app.example.test'), /类型/);
  t.mock.method(globalThis, 'fetch', async () => new Response('a', { headers: { 'content-length': '99', 'content-type': 'image/png' } }));
  await assert.rejects(resources.fetchVisualImage('https://images.example.test/big', 'https://app.example.test', 100, 3), /限额/);
});

test('visual image deadline aborts both a stalled request and a stalled response body', async t => {
  t.mock.method(globalThis, 'fetch', (_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  await assert.rejects(resources.fetchVisualImage('https://images.example.test/stall', 'https://app.example.test', 5), /aborted/);
  t.mock.method(globalThis, 'fetch', async (_url: string, { signal }: RequestInit) => new Response(new ReadableStream({
    start(controller) { signal!.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true }); },
  }), { headers: { 'content-type': 'image/png' } }));
  await assert.rejects(resources.fetchVisualImage('https://images.example.test/stall-body', 'https://app.example.test', 5), /body aborted/);
});

test('pinned native exporter disables the public proxy and refuses readiness timeouts and source drift', () => {
  const original = readFileSync('node_modules' + nativeExportManagerPath, 'utf8');
  const patched = patchNativeExportManager(original, '0.22.4');
  assert.match(patched, /imageProxyEndpoint: '',/);
  assert.match(patched, /if \(!await this\._checkReady\(\)\) throw/);
  assert.match(patched, /if \(count >= 100\)/);
  assert.throws(() => patchNativeExportManager(original, '0.23.0'), /upgrading/);
  assert.throws(() => patchNativeExportManager(patched, '0.22.4'), /source changed/);
  assert.throws(() => patchNativeFileExporter('', '0.22.4'), /source changed/);
});

test('actual native file exporter can be captured without an automatic download and keeps its normal fallback', () => {
  const source = patchNativeFileExporter(readFileSync('node_modules' + nativeFileExporterPath, 'utf8'), '0.22.4');
  let clicks = 0, appended = 0, event: CustomEvent | undefined;
  const element = { setAttribute() {}, style: {}, click() { clicks++; }, remove() {} };
  const document = { createElement: () => element, body: { append() { appended++; } }, dispatchEvent(value: CustomEvent) { event = value; value.preventDefault(); return !value.defaultPrevented; } };
  const js = ts.transpile(source.replace(/^export /gm, ''), { target: ts.ScriptTarget.ES2022 });
  const exporter = new Function('document', 'CustomEvent', js + ';return FileExporter;')(document, CustomEvent);
  exporter.exportFile('test/image.png', png);
  assert.equal(event!.type, visualExportEvent); assert.equal(event!.detail.filename, 'test image.png');
  assert.equal(clicks, 0); assert.equal(appended, 0);
  document.dispatchEvent = () => true;
  exporter.exportFile('test.png', png); assert.equal(clicks, 1); assert.equal(appended, 1);
});

function managerHarness(options: { images?: string[]; failed?: boolean; font?: Promise<unknown>; styleExtension?: boolean; decode?: (image: any) => Promise<void> } = {}) {
  let reads = 0, native = 0, normalized = 0, fitted = 0, decoded = 0;
  const host: any = { isConnected: true, querySelectorAll(selector: string) {
    return selector === 'img' ? (options.images ?? []).map(src => ({ src, getClientRects: () => [1] })) : options.failed ? [{ querySelector: () => ({}), getClientRects: () => [1] }] : [];
  } };
  class Native { constructor(readonly std: any) {} get editorHost() { return this.std.host; } async exportPng() { native++; } async exportPdf() { native++; } }
  const { VisualExportManager } = evaluate('src/editor/visual-export.ts', 'VisualExportManager', {
    ExportManager: Native, FontLoaderService: 'font', GfxControllerIdentifier: 'gfx',
    isInsidePageEditor: () => false, document: { fonts: { ready: Promise.resolve() }, querySelector: () => options.styleExtension ? {} : null },
    fetchVisualImage: async () => { reads++; return new Blob(); }, inlineVisualImage: async () => 'data:inlined',
    normalizeVisualColors: () => { normalized++; }, fitVisualImage: async () => { fitted++; return 'data:fitted'; },
    decodeVisualImage: async (image: { src: string }) => { assert.equal(image.src, 'data:fitted'); decoded++; await options.decode?.(image); },
    createIdentifier: () => ({}), parseIdentifier: () => ({}), visualExportEvent, visualFile: resources.visualFile,
  });
  const scope = { host, get: () => ({ fontFaces: [{ family: 'Inter', loaded: options.font ?? Promise.resolve() }], elementsBound: {}, getElementsByBound: () => [{ fontFamily: 'Inter' }] }) };
  host.std = scope;
  return { manager: new VisualExportManager(scope), host, scope, reads: () => reads, native: () => native, normalized: () => normalized, fitted: () => fitted, decoded: () => decoded };
}

test('actual export manager caches direct image bytes and changes only cloned images', async () => {
  const h = managerHarness({ images: ['https://images.example.test/a.png', 'https://images.example.test/a.png'] });
  await h.manager.prepare(); assert.equal(h.reads(), 1);
  const clone = { src: 'https://images.example.test/a.png', hasAttribute: () => true };
  await h.manager.replaceImgSrcWithSvg({ querySelectorAll: () => [clone] });
  assert.equal(clone.src, 'data:fitted'); assert.equal(h.reads(), 1);
  assert.equal(h.normalized(), 1); assert.equal(h.fitted(), 1); assert.equal(h.decoded(), 1);
  assert.equal(h.host.querySelectorAll('img')[0].src, 'https://images.example.test/a.png');
  await h.manager.exportPdf(); assert.equal(h.native(), 1); assert.equal(h.manager.images.size, 0);
});

test('cloned image decoding waits for native dimensions and rejects stalled or corrupt output', async () => {
  let release: () => void = () => {};
  const image = { naturalWidth: 0, decode: () => new Promise<void>(resolve => { release = () => { image.naturalWidth = 40; resolve(); }; }) };
  const decoding = resources.decodeVisualImage(image, 100); assert.equal(image.naturalWidth, 0);
  release(); await decoding; assert.equal(image.naturalWidth, 40);
  await assert.rejects(resources.decodeVisualImage({ decode: () => new Promise(() => {}) }, 5), /超时/);
  await assert.rejects(resources.decodeVisualImage({ decode: () => Promise.reject(new Error('corrupt')) }, 5), /corrupt/);
});

test('production clone hook finishes decoding before the actual native parser snapshots intrinsic dimensions', async () => {
  let start: () => void = () => {}, release: () => void = () => {};
  const started = new Promise<void>(resolve => { start = resolve; }), ready = new Promise<void>(resolve => { release = resolve; });
  const h = managerHarness({ decode: async image => { start(); await ready; image.naturalWidth = 40; image.naturalHeight = 40; } });
  const clone = { src: 'https://images.example.test/a.png', naturalWidth: 0, naturalHeight: 0, hasAttribute: () => true };
  const source = readFileSync('node_modules/html2canvas/dist/lib/dom/replaced-elements/image-element-container.js', 'utf8');
  function Base(this: { context: unknown }, context: unknown) { this.context = context; }
  const NativeImage = new Function('require', 'exports', source + '\nreturn exports.ImageElementContainer;')(() => ({ ElementContainer: Base }), {});
  const context = { cache: { addImage() {} } };
  assert.equal(new NativeImage(context, clone).intrinsicWidth, 0, 'unready native image dimensions would omit the image');
  const hook = h.manager.replaceImgSrcWithSvg({ querySelectorAll: () => [clone] });
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.normalized(), 0, 'the clone must not reach subsequent parsing while decode is pending');
  release(); await hook;
  assert.equal(new NativeImage(context, clone).intrinsicWidth, 40);
  assert.equal(new NativeImage(context, clone).intrinsicHeight, 40);
});

test('image cell containment preserves aspect ratio in square thumbnails and wide covers', () => {
  const square = resources.containImage(20, 20, 120, 80);
  for (const [key, expected] of Object.entries({ x: 0, y: 10 / 3, w: 20, h: 40 / 3 })) assert.ok(Math.abs(square[key] - expected) < 1e-10);
  assert.deepEqual(resources.containImage(360, 160, 120, 80), { x: 60, y: 0, w: 240, h: 160 });
  assert.throws(() => resources.containImage(20, 20, 0, 80), /尺寸/);
});

test('actual export manager blocks failed images, rejected fonts and a replaced editor scope', async () => {
  const badImage = managerHarness({ failed: true });
  await assert.rejects(badImage.manager.exportPng(), /图片加载失败/); assert.equal(badImage.native(), 0);
  const badFont = managerHarness({ font: Promise.reject(new Error('font failed')) });
  await assert.rejects(badFont.manager.exportPdf(), /字体.*加载失败/); assert.equal(badFont.native(), 0);
  const stale = managerHarness(); stale.host.std = {};
  await assert.rejects(stale.manager.exportPng(), /页面已变化/); assert.equal(stale.native(), 0);
  const extension = managerHarness({ styleExtension: true });
  await assert.rejects(extension.manager.exportPng(), /样式扩展/); assert.equal(extension.native(), 0);
});

test('modern CSS colors are converted through browser pixels only in the export clone', () => {
  const color = 'oklab(60% .1 .1)', gradient = `linear-gradient(${color}, color(srgb 1 0 0 / .5))`;
  const declarations = new Map([['color', color], ['box-shadow', `0 0 2px ${color}`], ['background-image', gradient], ['font-size', '16px']]);
  let selected = '', reads = 0;
  const supported = [color, 'color(srgb 1 0 0 / .5)'];
  const context = {
    clearRect() {}, fillRect() {},
    set fillStyle(value: string) { if (value.startsWith('#') || supported.includes(value)) selected = value; },
    get fillStyle() { return selected; },
    getImageData() { reads++; return { data: selected === color ? [230, 35, 55, 255] : [255, 0, 0, 128] }; },
  };
  const node = () => ({ style: { values: new Map<string, string>(), setProperty(key: string, value: string) { this.values.set(key, value); } } });
  const root = node(), body = node(), cloned: any = node();
  const doc = { documentElement: root, body, createElement: () => ({ getContext: () => context }), defaultView: { getComputedStyle: () => Object.assign([...declarations.keys()], { getPropertyValue: (key: string) => declarations.get(key) }) } };
  cloned.ownerDocument = doc; cloned.querySelectorAll = () => [];
  const { normalizeVisualColors } = evaluate('src/editor/visual-colors.ts', 'normalizeVisualColors');
  normalizeVisualColors(cloned);
  assert.equal(cloned.style.values.get('color'), 'rgba(230, 35, 55, 1)');
  assert.equal(cloned.style.values.get('box-shadow'), '0 0 2px rgba(230, 35, 55, 1)');
  assert.equal(cloned.style.values.get('background-image'), 'linear-gradient(rgba(230, 35, 55, 1), rgba(255, 0, 0, 0.5019607843137255))');
  assert.equal(reads, 2, 'repeated colors share pixel conversion');
  assert.equal(declarations.get('color'), color, 'source style declarations stay untouched');
  declarations.set('color', 'oklab(invalid)'); assert.throws(() => normalizeVisualColors(cloned), /无法转换/);
});

test('capture requires an actual valid file from the current scope and always releases its listener', async () => {
  const document = new EventTarget(), host: any = { isConnected: true };
  let run: () => void = () => {};
  const scope = { host, get: () => ({ exportPng: async () => run(), exportPdf: async () => run() }) }; host.std = scope;
  const { captureVisualExport } = evaluate('src/editor/visual-export.ts', 'captureVisualExport', {
    ExportManager: class {}, document, visualExportEvent, visualFile: resources.visualFile,
  });
  await assert.rejects(captureVisualExport(scope, 'png'), /未生成文件/);
  const dispatch = (dataURL: string) => { const event = new CustomEvent(visualExportEvent, { cancelable: true, detail: { filename: 'test.png', dataURL } }); document.dispatchEvent(event); return event.defaultPrevented; };
  assert.equal(dispatch(png), false, 'failed exports remove the listener');
  run = () => { assert.equal(dispatch(png), true); };
  assert.equal((await captureVisualExport(scope, 'png')).data.type, 'image/png');
  assert.equal(dispatch(png), false, 'successful exports also remove the listener');
  run = () => { dispatch(pdf); }; await assert.rejects(captureVisualExport(scope, 'png'), /格式/);
  run = () => { host.std = {}; dispatch(png); }; await assert.rejects(captureVisualExport(scope, 'png'), /页面已变化/);
});
