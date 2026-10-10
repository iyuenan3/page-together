# Third-party notices

pageTogether-authored code is MIT. That license does not replace the licenses of imported components.

- BlockSuite 0.22.4 package manifests declare MIT. The upstream repository retains MPL-2.0 material. The application and editor lab import official published packages without changing their source. [Pinned upstream source](https://github.com/toeverything/blocksuite/tree/a5091e72365a47351f370ca23f212ef43a9d42f0).
- `@toeverything/theme` 1.1.23 includes an MPL-2.0 LICENSE. Its original license text is preserved in the build output.
- Lit 3.3.3 is BSD-3-Clause; RxJS 7.8.2 is Apache-2.0; Yjs, Preact Signals, React, and KaTeX carry their own MIT notices.

`npm run build` generates `dist/THIRD_PARTY_LICENSES.txt` from installed runtime package manifests and original LICENSE, COPYING, and NOTICE files. The inventory also identifies source packages where a published package does not include a license file. Preserve these notices with distributed builds and retain source availability for MPL components. Dependency versions and integrity hashes are recorded in `package-lock.json`.
