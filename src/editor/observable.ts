import { untracked } from '@preact/signals-core';
import { Observable } from 'rxjs';

/** RxJS subscriptions must not add their consumers' reads to a caller's effect. */
export function untrackedObservable<T>(source: Observable<T>): Observable<T> {
  return new Observable(subscriber => source.subscribe({
    next: value => untracked(() => subscriber.next(value)),
    error: error => subscriber.error(error),
    complete: () => subscriber.complete(),
  }));
}
