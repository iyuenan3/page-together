import { AttachmentEmbedProvider } from '@blocksuite/affine/blocks/attachment';
import { LifeCycleWatcher } from '@blocksuite/affine/std';
import { html } from 'lit';
import './pdf-preview';

/** Replace only PDF rendering; retain the native conversion, models and actions. */
export class PdfEmbedExtension extends LifeCycleWatcher {
  static override key = 'page-together-pdf-embed';
  override mounted() {
    const configs = this.std.get(AttachmentEmbedProvider).configs;
    const native = configs.get('pdf');
    if (!native) throw new Error('Native PDF embed config unavailable');
    configs.set('pdf', { ...native, render: (model, url) => html`<page-together-pdf .source=${url} .label=${model.props.name}></page-together-pdf>` });
  }
}
