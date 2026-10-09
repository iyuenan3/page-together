import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { blockSuiteRuntimeImports } from './scripts/blocksuite-runtime-imports.mjs';

const packageDirectory = new URL('./node_modules/@blocksuite/', import.meta.url);
const sourcePackages = readdirSync(packageDirectory).filter(name => {
  const manifest = JSON.parse(readFileSync(new URL(`${name}/package.json`, packageDirectory), 'utf8'));
  return Object.values(manifest.exports ?? {}).some(
    source => typeof source === 'string' && source.startsWith('./src/')
  );
});

export default defineConfig({
  plugins: [wasm(), vanillaExtractPlugin()],
  resolve: { dedupe: ['yjs', 'lit', '@preact/signals-core'] },
  esbuild: { target: 'es2022' },
  // The WASM plugin sets the optimizer target to esnext. Browsers still need
  // BlockSuite's standard decorators compiled rather than passed through.
  optimizeDeps: {
    // Source packages must pass through Vite's vanilla-extract plugin. Bundling
    // their .css.ts files with the dependency optimizer loses the file scope.
    exclude: sourcePackages.map(name => `@blocksuite/${name}`),
    include: blockSuiteRuntimeImports(fileURLToPath(packageDirectory), sourcePackages),
    esbuildOptions: { supported: { decorators: false } },
  },
  build: { target: 'es2022' },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
});
