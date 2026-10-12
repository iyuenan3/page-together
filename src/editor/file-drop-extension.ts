import { AttachmentDropOption } from '@blocksuite/affine/blocks/attachment';
import { ImageDropOption } from '@blocksuite/affine/blocks/image';
import type { FileDropOptions } from '@blocksuite/affine/components/drop-indicator';
import { Container, createIdentifier } from '@blocksuite/affine/global/di';
import type { ExtensionType } from '@blocksuite/affine/store';
import { dropFileGroup } from './file-drop';

// BlockSuite 0.22.4 stops at the first accepting file handler. Reuse its exact
// image/attachment callbacks, filtering their inputs and continuing mixed drops.
// The DI identifier is private upstream; keep this adapter tied to the pinned version.
const identifier = createIdentifier<FileDropOptions>('FileDropConfigExtension');
const native = new Container();
ImageDropOption.setup(native); AttachmentDropOption.setup(native);
const handlers = native.provider().getAll(identifier);

export const CompleteFileDropExtension: ExtensionType = {
  setup(di) {
    for (const options of handlers.values()) {
      const nativeDrop = options.onDrop;
      if (!nativeDrop) throw new Error('Native file drop handler unavailable');
      di.override(identifier(options.flavour), {
        ...options,
        onDrop: props => !props.std.store.readonly && dropFileGroup(props, options.flavour === 'affine:image', nativeDrop),
      });
    }
  },
};
