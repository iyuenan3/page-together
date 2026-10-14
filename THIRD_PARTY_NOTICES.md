# Third-party notices

pageTogether-authored code is MIT. That license does not replace the licenses of imported components.

- BlockSuite 0.22.4 package manifests declare MIT. The upstream repository retains MPL-2.0 material. The application and editor lab import official published packages, with version-checked compatibility transforms at build time. Installed source files remain unchanged. [Pinned upstream source](https://github.com/toeverything/blocksuite/tree/a5091e72365a47351f370ca23f212ef43a9d42f0).
- `@toeverything/theme` 1.1.23 includes an MPL-2.0 LICENSE. Its original license text is preserved in the build output.
- Lit 3.3.3 is BSD-3-Clause; RxJS 7.8.2 is Apache-2.0; Yjs, Preact Signals, React, and KaTeX carry their own MIT notices.
- PDF.js (`pdfjs-dist` 6.4.299) is Apache-2.0. Its worker, CMaps, standard fonts, image decoders and ICC profiles are bundled locally. Ancillary components retain their own licenses, both alongside the assets and in the generated notice inventory. [Pinned release](https://github.com/mozilla/pdf.js/releases/tag/v6.4.299).
- The bundled `pageTogether Han Supplement` is a renamed supplementary-CJK subset of [BabelStone Han](https://babelstone.co.uk/Fonts/Han.html) 16.0.3, under the Arphic Public License (1999). The [original license](public/assets/HAN-LICENSE.txt) and font copyright records are preserved. The modified font includes 32,993 mappings; the pinned source hash, subset ranges and output hash are in [han-coverage.json](public/assets/han-coverage.json). Regeneration uses `scripts/build-han-font.py` with `fonttools[woff]==4.60.1` and the exact official input recorded in the manifest.

`npm run build` generates `dist/THIRD_PARTY_LICENSES.txt` from installed runtime package manifests and original LICENSE, COPYING, and NOTICE files. The inventory also identifies source packages where a published package does not include a license file. Preserve these notices with distributed builds and retain source availability for MPL components. Dependency versions and integrity hashes are recorded in `package-lock.json`.
