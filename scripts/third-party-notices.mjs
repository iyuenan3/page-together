import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const notices = [
  'Third-party components used by pageTogether.',
  'This inventory includes installed runtime dependencies and may include components removed by tree shaking.',
  'Project-authored code is MIT; this does not replace third-party licenses.',
  'BlockSuite package manifests declare MIT; the upstream repository also retains MPL-2.0 material.',
  'Pinned source: https://github.com/toeverything/blocksuite/tree/a5091e72365a47351f370ca23f212ef43a9d42f0',
];
notices.push('\npageTogether Han Supplement, derived from BabelStone Han 16.0.3',
  'Source: https://babelstone.co.uk/Fonts/Han.html',
  'Modified by pageTogether: supplementary CJK subset and renamed font family.',
  readFileSync(join(root, 'public/assets/HAN-LICENSE.txt'), 'utf8'));
let count = 0;

for (const [packagePath, dependency] of Object.entries(lock.packages)) {
  if (!packagePath || dependency.dev || !packagePath.includes('node_modules/')) continue;
  const directory = join(root, packagePath);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) continue; // Optional dependencies for another platform.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  notices.push(
    '\n============================================================',
    `${manifest.name}@${manifest.version}`,
    `Source package: https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
    `Manifest license: ${typeof manifest.license === 'string' ? manifest.license : 'see included license or source package'}`
  );
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(licen[sc]e|copying|notice)([._-].*)?$/i.test(entry.name)) {
      notices.push(`\n${entry.name}\n`, readFileSync(join(directory, entry.name), 'utf8'));
    }
  }
  if (manifest.name === 'pdfjs-dist') {
    for (const category of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
      for (const entry of readdirSync(join(directory, category), { withFileTypes: true })) {
        if (entry.isFile() && /^(licen[sc]e|copying|notice)([._-].*)?$/i.test(entry.name)) {
          notices.push(`\n${category}/${entry.name}\n`, readFileSync(join(directory, category, entry.name), 'utf8'));
        }
      }
    }
  }
  count++;
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
console.log(`Preserved third-party notices for ${count} installed runtime packages.`);
