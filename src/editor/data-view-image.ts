import { ShadowlessElement } from '@blocksuite/affine/std';
import { html, type PropertyValues } from 'lit';
import { keyed } from 'lit/directives/keyed.js';

/** Remote URLs stay remote: a failed resource must not mutate a stored cell. */
export class DataViewImage extends ShadowlessElement {
  static override properties = {
    source: { type: String }, cover: { type: Boolean },
    failed: { state: true }, attempt: { state: true },
  };
  declare source: string;
  declare cover: boolean;
  private declare failed: boolean;
  private declare attempt: number;
  constructor() {
    super(); this.source = ''; this.cover = false; this.failed = false; this.attempt = 0;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has('source')) { this.failed = false; this.attempt = 0; }
  }
  private retry = () => { this.failed = false; this.attempt++; };
  private fail = (event: Event) => {
    if ((event.currentTarget as HTMLImageElement).isConnected) this.failed = true;
  };
  override render() {
    if (!this.source) return html``;
    if (this.failed) return html`<button type="button" aria-label="重新加载图片" title="图片加载失败，点击重试" @click=${this.retry}>图片加载失败</button>`;
    return keyed(`${this.source}:${this.attempt}`, html`<img data-page-together-image src=${this.source} alt=${this.cover ? '图片封面' : '图片字段'} referrerpolicy="no-referrer" draggable="false"
      style=${this.cover ? 'display:block;width:100%;max-height:160px;object-fit:contain' : 'width:20px;height:20px;object-fit:contain'} @error=${this.fail}>`);
  }
}
customElements.define('page-together-data-view-image', DataViewImage);
