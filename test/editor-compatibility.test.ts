import assert from 'node:assert/strict';
import test from 'node:test';
import { effect, signal } from '@preact/signals-core';
import { BehaviorSubject } from 'rxjs';
import { untrackedObservable } from '../src/editor/observable.js';
import { inlineWhitespace } from '../src/editor/clipboard-whitespace.js';

test('native resource consumers do not subscribe an effect to their own merged state', () => {
  const input = signal('first'), state = signal({ uploading: false }), source = new BehaviorSubject({ uploading: false });
  let effects = 0, emissions = 0;
  const stop = effect(() => {
    input.value; effects++;
    const subscription = untrackedObservable(source).subscribe(value => {
      emissions++; state.value = { ...state.value, ...value };
    });
    return () => subscription.unsubscribe();
  });
  assert.equal(effects, 1); assert.equal(emissions, 1);
  source.next({ uploading: true }); assert.equal(state.value.uploading, true); assert.equal(effects, 1);
  input.value = 'second'; assert.equal(effects, 2); assert.equal(emissions, 3);
  stop(); source.next({ uploading: false }); assert.equal(emissions, 3);
});

test('inline-only HTML whitespace survives without changing code, explicit trimming or normal text', () => {
  assert.equal(inlineWhitespace(' '), ' '); assert.equal(inlineWhitespace('\n  \t'), ' ');
  assert.equal(inlineWhitespace(' ', true), undefined); assert.equal(inlineWhitespace(' ', false, true), undefined);
  assert.equal(inlineWhitespace(' text '), undefined); assert.equal(inlineWhitespace(''), undefined);
});
