import { BehaviorSubject, Subject } from 'rxjs';
import { MAX_ATTACHMENT_BYTES, blobWriteHeaders, type BlobWriteContext } from '../../shared/attachments.js';
import { canEdit, type DocumentScope, type Member } from '../../shared/protocol.js';
import { api, RequestError } from './api.js';
import { LocalPersistence, type CachedBlob } from './local.js';

interface BlobStatus {
  uploading: boolean; downloading: boolean; overSize: boolean;
  needUpload: boolean; needDownload: boolean; errorMessage?: string | null;
}
interface BlobWorkspace {
  member: Member; epoch: string; local: LocalPersistence;
  blobScope(key: string): DocumentScope | undefined;
  blobMetadata(key: string): { name?: string; type?: string };
  updateAccess(member: Member): void;
  uploaded(): void; changed(): void; report(error: unknown): void;
}
const idle = (): BlobStatus => ({ uploading: false, downloading: false, overSize: false, needUpload: false, needDownload: false });
export async function attachmentKey(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_');
}
export function attachmentError(error: unknown): string {
  if (error instanceof RequestError) {
    const messages: Record<string, string> = {
      attachment_too_large: '附件超过服务端大小上限', blob_quota: '空间附件配额不足，附件仍保留在此设备',
      uploads_busy: '其他附件正在上传，请稍后重试', blob_hash_mismatch: '附件校验失败，原文件仍保留',
      session_expired: '身份已失效，附件已暂停，请恢复身份后明确重新提交', read_only: '当前没有编辑权限，附件已暂停',
      access_revoked: '访问资格已撤销，附件已暂停', access_changed: '权限记录已变化，附件已暂停',
      space_epoch_changed: '空间已从备份恢复，旧附件保留供下载或重新提交',
      document_deleted: '原文档已删除，附件保留供下载或重新提交', document_generation_changed: '原文档代际已变化，附件已暂停',
    };
    return messages[error.code] ?? '附件操作未完成，请重试';
  }
  return error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError' ? '网络不可用，附件保留在此设备，联网后重试' : error instanceof Error ? error.message : '附件操作未完成';
}
export class OfflineBlobSource {
  readonly name = 'authenticated-indexeddb-blobs';
  readonly memory = new Map<string, CachedBlob>();
  readonly changes = new Subject<void>();
  private subjects = new Map<string, BehaviorSubject<BlobStatus>>();
  private reads = new Map<string, Promise<Blob | null>>();
  private unbound = new Set<string>();
  private sending?: Promise<void>;
  private submitting?: Promise<CachedBlob>;
  private rerun = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private disposed = false;
  private persistenceFailed = false;
  private abort = new AbortController();
  constructor(private workspace: BlobWorkspace) {}
  get readonly() { return !canEdit(this.workspace.member.role); }
  get hasStorageFailure() { return this.memory.size > 0 || this.persistenceFailed; }
  get uploading() { return !!this.sending || !!this.submitting; }
  blobState$(key: string) {
    let subject = this.subjects.get(key);
    if (!subject) { subject = new BehaviorSubject(idle()); this.subjects.set(key, subject); }
    return subject;
  }
  private state(key: string, state: Partial<BlobStatus>) {
    const subject = this.blobState$(key); subject.next({ ...subject.value, ...state }); this.workspace.changed(); this.changes.next();
  }
  async session(write = false) {
    const session = await api<{ member: Member; epoch: string }>('session');
    if (session.member.id !== this.workspace.local.memberId) throw new RequestError(409, 'access_changed');
    if (session.epoch !== this.workspace.epoch) throw new RequestError(409, 'space_epoch_changed');
    this.workspace.updateAccess(session.member);
    if (write && !canEdit(session.member.role)) throw new RequestError(403, 'read_only');
    return session;
  }
  async get(key: string): Promise<Blob | null> {
    const memory = this.memory.get(key); if (memory) return memory.data;
    const local = await this.workspace.local.getBlob(this.workspace.epoch, key); if (local) return local;
    if (this.reads.has(key)) return this.reads.get(key)!;
    const read = this.download(key).finally(() => this.reads.delete(key)); this.reads.set(key, read); return read;
  }
  private async download(key: string) {
    this.state(key, { downloading: true, errorMessage: null });
    try {
      await this.session();
      const response = await fetch('/api/blobs/' + encodeURIComponent(key), { credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal, headers: { 'X-PageTogether-Epoch': this.workspace.epoch } });
      if (response.status === 404) { this.state(key, { needDownload: true, errorMessage: '附件尚未上传或此设备尚未缓存，请联网后重新加载' }); return null; }
      if (!response.ok) throw new RequestError(response.status, (await response.json()).code ?? 'blob_read_failed');
      const value = await response.blob();
      if (value.size > MAX_ATTACHMENT_BYTES || await attachmentKey(value) !== key) throw new Error('附件校验失败，未写入本机缓存');
      const metadata = this.workspace.blobMetadata(key);
      try { await this.workspace.local.setBlob(this.workspace.epoch, key, value, true, undefined, metadata); }
      catch (error) {
        this.memory.set(key, { ...metadata, key: this.workspace.epoch + ':' + key, blobKey: key, epoch: this.workspace.epoch, data: value, saved: true });
        this.workspace.report(new Error('附件可读取，但本机缓存失败，请保留页面并重试本机保存'));
      }
      this.state(key, { needDownload: false, errorMessage: null }); return value;
    } catch (error) { if (!this.disposed) this.state(key, { needDownload: true, errorMessage: attachmentError(error) }); throw error; }
    finally { if (!this.disposed) this.state(key, { downloading: false }); }
  }
  async set(key: string, value: Blob) {
    if (this.readonly) throw new RequestError(403, 'read_only');
    if (value.size > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 50 MB');
    if (await attachmentKey(value) !== key) throw new Error('附件内容校验失败');
    const metadata = { name: 'name' in value && typeof value.name === 'string' ? value.name : undefined, type: value.type };
    try {
      const record = await this.workspace.local.setBlob(this.workspace.epoch, key, value, false, this.workspace.member.accessRevision, metadata);
      if (!record.saved && !record.scope && !record.blockedReason) this.unbound.add(record.id!);
      this.state(key, { needUpload: !record.saved, errorMessage: record.blockedReason ?? null }); this.schedule();
    } catch (error) {
      this.memory.set(key, { ...metadata, id: crypto.randomUUID(), key: this.workspace.epoch + ':' + key, blobKey: key, epoch: this.workspace.epoch, data: value, saved: false, accessRevision: this.workspace.member.accessRevision });
      this.state(key, { needUpload: true, errorMessage: '本机附件保存失败，请保留页面并下载原文件' });
      this.workspace.report(new Error('本机附件保存失败，原文件保留在内存，可在附件与离线缓存中下载或重试')); throw error;
    }
    return key;
  }
  async delete(_key: string) { throw new Error('附件暂不永久删除'); }
  async list() { return (await this.workspace.local.blobs(this.workspace.epoch)).map(row => row.blobKey); }
  schedule(delay = 100) {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }
  async retryLocalSave() {
    for (const [key, row] of this.memory) {
      try {
        const record = await this.workspace.local.setBlob(row.epoch, key, row.data, row.saved, row.accessRevision, row);
        this.memory.delete(key); if (!record.saved && !record.scope) this.unbound.add(record.id!);
        this.state(key, { needUpload: !record.saved, errorMessage: record.blockedReason ?? null });
      } catch { this.workspace.report(new Error('本机附件保存仍失败，请保留页面并下载原文件')); }
    }
    if (!this.memory.size) this.persistenceFailed = false;
    this.workspace.changed(); await this.flush();
  }
  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.submitting) { this.rerun = true; return this.submitting.then(() => {}, () => {}); }
    if (this.sending) { this.rerun = true; return this.sending; }
    clearTimeout(this.timer); this.timer = undefined;
    this.sending = this.drain().catch(error => { if (!this.disposed) this.workspace.report(error); }).finally(() => { this.sending = undefined; this.workspace.changed(); });
    return this.sending;
  }
  private async drain() {
    do {
      this.rerun = false;
      const pending = await this.workspace.local.blobs(this.workspace.epoch, true);
      if (!pending.length || this.disposed || this.hasStorageFailure) return;
      // Bind the creating document durably even while the session endpoint is offline.
      for (let index = 0; index < pending.length; index++) {
        const row = pending[index];
        if (row.scope || !this.unbound.has(row.id!)) continue;
        const scope = this.workspace.blobScope(row.blobKey); if (!scope) continue;
        pending[index] = (await this.workspace.local.bindBlob(row.epoch, row.blobKey, scope, row.id))!;
        this.unbound.delete(row.id!);
      }
      let session: Awaited<ReturnType<OfflineBlobSource['session']>>;
      try { session = await this.session(true); }
      catch (error) {
        if (error instanceof RequestError && [401, 403, 409].includes(error.status)) await this.workspace.local.blockPending(attachmentError(error));
        else if (!this.disposed) this.schedule(Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5)));
        for (const row of pending) this.state(row.blobKey, { needUpload: true, errorMessage: attachmentError(error) });
        return;
      }
      for (let row of pending) {
        if (this.disposed) return;
        if (!row.scope && this.unbound.has(row.id!)) continue;
        const guard = row.scope ? await this.workspace.local.checkAccess(row.scope, session.member.accessRevision) : undefined;
        const reason = row.blockedReason ?? guard ?? (row.accessRevision !== session.member.accessRevision ? '权限记录已变化，旧附件暂停，需明确重新提交' : !row.scope ? '原文档尚未核验，旧附件暂停，需明确重新提交' : undefined);
        if (reason) { await this.workspace.local.blockBlob(row.epoch, row.blobKey, reason, row.id); this.state(row.blobKey, { needUpload: true, errorMessage: reason }); continue; }
        try { await this.send(row, { ...row.scope!, memberId: session.member.id, accessRevision: session.member.accessRevision }); }
        catch (error) {
          if (error instanceof RequestError && [401, 403, 409].includes(error.status)) await this.workspace.local.blockBlob(row.epoch, row.blobKey, attachmentError(error), row.id);
          else if (!(error instanceof RequestError) || [429, 500, 503].includes(error.status)) this.schedule(Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5)));
          this.state(row.blobKey, { needUpload: true, errorMessage: attachmentError(error) }); this.workspace.report(new Error(attachmentError(error)));
        }
      }
    } while (this.rerun && !this.disposed);
  }
  private async send(row: CachedBlob, context: BlobWriteContext) {
    this.state(row.blobKey, { uploading: true, errorMessage: null });
    try {
      const response = await fetch('/api/blobs/' + encodeURIComponent(row.blobKey), { method: 'PUT', credentials: 'same-origin', cache: 'no-store', headers: blobWriteHeaders(context), body: row.data, signal: this.abort.signal });
      const receipt = await response.json();
      if (!response.ok) throw new RequestError(response.status, receipt.code ?? 'blob_upload_failed');
      if (receipt.saved !== true || receipt.key !== row.blobKey || receipt.size !== row.data.size) throw new Error('附件保存确认不匹配，原文件保留');
      let acknowledged: boolean;
      try { acknowledged = await this.workspace.local.acknowledgeBlob(row.epoch, row.blobKey, row.id); }
      catch { this.persistenceFailed = true; throw new Error('本机附件保存确认失败，请保留页面并重试本机保存'); }
      if (!acknowledged) { this.rerun = true; return; }
      this.retries = 0; this.state(row.blobKey, { needUpload: false, errorMessage: null }); this.workspace.uploaded();
    } finally { if (!this.disposed) this.state(row.blobKey, { uploading: false }); }
  }
  async upload(key: string) {
    await this.flush(); return !(await this.workspace.local.blobs(this.workspace.epoch, true)).some(row => row.blobKey === key);
  }
  async resubmit(original: CachedBlob, scope: DocumentScope) {
    if (this.submitting) throw new Error('附件正在重新提交，请等待完成');
    await this.sending;
    if (this.submitting) throw new Error('附件正在重新提交，请等待完成');
    if (this.disposed) throw new Error('当前工作区已关闭，原附件继续保留');
    const operation = this.submit(original, scope);
    this.submitting = operation;
    try { return await operation; }
    finally { this.submitting = undefined; this.workspace.changed(); if (this.rerun) this.schedule(); }
  }
  private async submit(original: CachedBlob, scope: DocumentScope) {
    const session = await this.session(true);
    const record = await this.workspace.local.requeueBlob(original, scope, session.member.accessRevision);
    try { await this.send(record, { ...scope, memberId: session.member.id, accessRevision: session.member.accessRevision }); }
    catch (error) {
      if (error instanceof RequestError && [401, 403, 409].includes(error.status)) await this.workspace.local.blockBlob(record.epoch, record.blobKey, attachmentError(error), record.id);
      this.state(record.blobKey, { needUpload: true, errorMessage: attachmentError(error) }); throw error;
    }
    this.memory.delete(original.blobKey); if (!this.memory.size) this.persistenceFailed = false; return record;
  }
  async settled() { await Promise.allSettled([this.sending, this.submitting, ...this.reads.values()]); }
  dispose() { this.disposed = true; this.abort.abort(); clearTimeout(this.timer); for (const subject of this.subjects.values()) subject.complete(); this.changes.complete(); }
}
