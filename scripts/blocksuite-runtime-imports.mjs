import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Excluded source packages are not traversed by Vite's dependency scanner.
// Collect their actual runtime imports, including deep imports, so their
// third-party dependencies still receive CommonJS conversion and deduplication.
export function blockSuiteRuntimeImports(directory, packages) {
  const imports = new Set();
  const sourcePackageIds = new Set(packages.map(name => `@blocksuite/${name}`));
  function walk(sourceDirectory) {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const path = join(sourceDirectory, entry.name);
      if (entry.isDirectory() && entry.name !== '__tests__') walk(path);
      if (!entry.isFile() || !entry.name.endsWith('.ts') || /\.(test|spec|d)\.ts$/.test(entry.name)) continue;
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false);
      function visit(node) {
        let specifier;
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
          const bindings = node.importClause?.namedBindings;
          const onlyTypes = !node.importClause?.name && bindings &&
            ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly);
          if (!onlyTypes) specifier = node.moduleSpecifier.text;
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)) {
          const onlyTypes = node.exportClause && ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.every(item => item.isTypeOnly);
          if (!onlyTypes) specifier = node.moduleSpecifier.text;
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          specifier = node.arguments[0].text;
        }
        const packageId = specifier?.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier?.split('/')[0];
        if (specifier && !specifier.startsWith('.') && !specifier.startsWith('/') &&
          !sourcePackageIds.has(packageId) && !specifier.startsWith('node:') &&
          !specifier.endsWith('.css') && specifier !== '@emoji-mart/data') imports.add(specifier);
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  for (const name of packages) walk(join(directory, name, 'src'));
  return [...imports].sort();
}
