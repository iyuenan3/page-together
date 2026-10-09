import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const notices = [
  'Third-party components used by the pageTogether editor lab.',
  'This inventory includes installed runtime dependencies and may include components removed by tree shaking.',
  'Project-authored code is MIT; this does not replace third-party licenses.',
  'BlockSuite package manifests declare MIT; the upstream repository also retains MPL-2.0 material.',
  'Pinned source: https://github.com/toeverything/blocksuite/tree/a5091e72365a47351f370ca23f212ef43a9d42f0',
];
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
    if (entry.isFile() && /^(licen[sc]e|copying|notice)([.-].*)?$/i.test(entry.name)) {
      notices.push(`\n${entry.name}\n`, readFileSync(join(directory, entry.name), 'utf8'));
    }
  }
  count++;
}

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/THIRD_PARTY_LICENSES.txt'), notices.join('\n'));
console.log(`Preserved third-party notices for ${count} installed runtime packages.`);
