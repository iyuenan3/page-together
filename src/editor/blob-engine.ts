import { BlobEngine } from '@blocksuite/affine/sync';
import { untrackedObservable } from './observable';

/** 0.22.4 ResourceController subscribes synchronously inside a signal effect. */
export class NativeBlobEngine extends BlobEngine {
  override blobState$(key: string) {
    const state = super.blobState$(key);
    return state ? untrackedObservable(state) : null;
  }
}
