import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentPreview, cachedAttachmentPreview, attachmentText, TEXT_PREVIEW_BYTES } from '../src/app/attachment-preview.js';

test('active document types stay text even with a misleading image filename', async () => {
  for (const name of ['unsafe.html', 'unsafe.svg', 'unsafe.pdf']) {
    assert.equal(attachmentPreview(name, 'text/html; charset=utf-8')?.kind, 'text');
  }
  assert.equal(attachmentPreview('script.xhtml', 'application/xhtml+xml'), undefined);
  assert.equal(attachmentPreview('book.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), undefined);
  const source = '<script>alert(1)</script><svg onload="alert(2)"></svg>';
  assert.equal((await attachmentText(new Blob([source]))).text, source);
});

test('preview uses known MIME or filename fallbacks and bounds text decoding at a UTF-8 boundary', async () => {
  assert.equal(attachmentPreview('audio.mp3', 'application/octet-stream')?.kind, 'audio');
  assert.equal(attachmentPreview('unknown', 'image/png')?.kind, 'image');
  assert.equal(attachmentPreview('video.mp4', 'video/mp4')?.kind, 'video');
  assert.equal(attachmentPreview('document.pdf', '')?.kind, 'pdf');
  const value = await attachmentText(new Blob(['x'.repeat(TEXT_PREVIEW_BYTES - 1), '中', 'tail']));
  assert(value.truncated); assert.equal(value.text, 'x'.repeat(TEXT_PREVIEW_BYTES - 1));
  await assert.rejects(() => attachmentText(new Blob([Uint8Array.of(255, 128)])));
  await assert.rejects(() => attachmentText(new Blob(['text\0binary'])));
});

test('remote native images without filename metadata still preview, explicit document MIME stays authoritative', async () => {
  const jpeg = new Blob([Uint8Array.of(255, 216, 255, 224)]);
  assert.equal((await cachedAttachmentPreview('附件 hash', 'application/octet-stream', jpeg))?.mime, 'image/jpeg');
  assert.equal((await cachedAttachmentPreview('附件 hash', '', new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)])))?.mime, 'image/png');
  assert.equal((await cachedAttachmentPreview('附件 hash', 'text/html', jpeg))?.kind, 'text');
  assert.equal(await cachedAttachmentPreview('附件 hash', 'application/pdf+custom', jpeg), undefined);
  assert.equal(await cachedAttachmentPreview('附件 hash', '', new Blob(['<svg onload="alert(1)"></svg>'])), undefined);
});
