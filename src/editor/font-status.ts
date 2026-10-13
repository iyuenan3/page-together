import { FontLoaderService } from '@blocksuite/affine/shared/services';
import { LifeCycleWatcher } from '@blocksuite/affine/std';

/** Expose the real native font load result before users judge or export a canvas. */
export class FontStatusExtension extends LifeCycleWatcher {
  static override key = 'page-together-font-status';
  private active = false;
  override mounted() {
    this.active = true;
    queueMicrotask(() => {
      const faces = this.std.get(FontLoaderService).fontFaces;
      const publish = () => {
        if (!this.active) return;
        this.std.host.dispatchEvent(new CustomEvent('font-status', {
          detail: { total: faces.length, loaded: faces.filter(face => face.status === 'loaded').length, failed: faces.filter(face => face.status === 'error').length },
          bubbles: true, composed: true,
        }));
      };
      publish();
      void Promise.allSettled(faces.map(face => face.loaded)).then(publish);
    });
  }
  override unmounted() { this.active = false; }
}
