import { Container } from '@blocksuite/affine/global/di';
import { htmlTextToDeltaMatcher } from '@blocksuite/affine/inlines/preset';
import { HtmlASTToDeltaMatcherIdentifier } from '@blocksuite/affine/shared/adapters';
import type { ExtensionType } from '@blocksuite/affine/store';
import { inlineWhitespace } from './clipboard-whitespace';

const native = new Container(); htmlTextToDeltaMatcher.setup(native);
const identifier = HtmlASTToDeltaMatcherIdentifier('text');
const matcher = native.provider().get(identifier);

/** Preserve spaces between formatted runs; keep the native HTML pipeline. */
export const ClipboardWhitespaceExtension: ExtensionType = {
  setup(di) {
    di.override(identifier, { ...matcher, toDelta: (ast, context) => {
      const space = ast.type === 'text' ? inlineWhitespace(ast.value, context.options.pre, context.options.trim) : undefined;
      return space === undefined ? matcher.toDelta(ast, context) : [{ insert: space }];
    } });
  },
};
