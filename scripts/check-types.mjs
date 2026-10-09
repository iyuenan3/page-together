import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = join(root, 'node_modules/@blocksuite');
const paths = {};

// These packages export their TS sources even though they ship declarations.
// Check our host against the shipped API declarations; keep runtime imports
// unchanged so Vite compiles the original source and native effects.
for (const directory of readdirSync(packages)) {
  const manifest = JSON.parse(readFileSync(join(packages, directory, 'package.json'), 'utf8'));
  for (const [subpath, source] of Object.entries(manifest.exports ?? {})) {
    if (typeof source !== 'string' || !source.startsWith('./src/') || !source.endsWith('.ts')) continue;
    const declaration = join(packages, directory, source.replace('./src/', 'dist/').replace(/\.ts$/, '.d.ts'));
    if (!existsSync(declaration)) {
      throw new Error(`Missing published declaration for ${manifest.name}${subpath.slice(1)}`);
    }
    paths[manifest.name + subpath.slice(1)] = [declaration];
  }
}

const generatedDirectory = join(root, '.local/types');
mkdirSync(generatedDirectory, { recursive: true });
const config = join(generatedDirectory, 'tsconfig.json');
const generatedConfig = JSON.stringify({
  extends: resolve(root, 'tsconfig.json'),
  compilerOptions: { paths },
}, null, 2);
if (!existsSync(config) || readFileSync(config, 'utf8') !== generatedConfig) {
  writeFileSync(config, generatedConfig);
}
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', config], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
