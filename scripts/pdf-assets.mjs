import { readdirSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** Bundle the matching PDF.js fonts, CMaps and decoders for offline use. */
export function pdfAssets() {
  const directory = new URL('../node_modules/pdfjs-dist/', import.meta.url);
  const { version } = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8'));
  const assets = new Map();
  for (const category of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const entry of readdirSync(new URL(category + '/', directory), { withFileTypes: true })) {
      if (entry.isFile()) assets.set(`assets/pdfjs-${version}/${category}/${entry.name}`, readFileSync(new URL(`${category}/${entry.name}`, directory)));
    }
  }
  return {
    name: 'page-together-pdf-assets',
    generateBundle() { for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source }); },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url, 'http://localhost').pathname.slice(1), source = assets.get(path);
        if (!source) return next();
        response.setHeader('Content-Type', extname(path) === '.wasm' ? 'application/wasm' : 'application/octet-stream'); response.end(source);
      });
    },
  };
}
