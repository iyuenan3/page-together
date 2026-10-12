import * as Y from 'yjs';
import type { DocumentScope, ServerMessage } from '../../shared/protocol.js';
import { canEdit } from '../../shared/protocol.js';
import { LocalPersistence } from './local.js';
import { api, RequestError } from './api.js';
import type { Member } from '../../shared/protocol.js';
import { DocumentPresence } from './presence.js';
import type { Awareness } from 'y-protocols/awareness.js';

export type SaveState = 'loading' | 'local' | 'syncing' | 'cloud' | 'blocked' | 'storage-error';
export class DocumentSync {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence: Promise<void> = Promise.resolve();
  private stopped = false;
  private blocked = false;
  private blockedReason = '';
  private localFailed = false;
  private opened = false;
  private synchronizing = false;
  private connecting = false;
  private retries = 0;
  private inFlight?: { requestId: string; ids: string[]; hash: string; timer: ReturnType<typeof setTimeout> };
  private readonly remoteOrigin = {};
  private initial = true;
  private draftIds = '';
  private firstSync?: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  state: SaveState = 'loading';
  reason = '';
  onState = (_state: SaveState, _reason: string) => {};
  onCatalog = () => {};
  onAccess = (_member: Member) => {};
  beforePush?: () => Promise<boolean>;
  readonly presence?: DocumentPresence;
  constructor(
    readonly doc: Y.Doc,
    readonly scope: DocumentScope,
    readonly local: LocalPersistence,
    private accessRevision = 0,
    awareness?: Awareness,
    creation?: Promise<unknown>,
  ) {
    // Native createDefaultDoc writes immediately, before the asynchronous HTTP
    // creation completes. Admit this fresh scope before persisting those writes.
    if (creation) this.sequence = creation.then(() => local.checkAccess(scope, accessRevision), async () => {
      const reason = '创建文档未完成，本机内容保留，暂停上传';
      await local.block(scope, reason); return reason;
    }).then(reason => {
      if (reason) { this.blocked = true; this.blockedReason = reason; this.setState('blocked', reason); }
    }).catch(() => this.storageFailure());
    this.doc.on('update', this.changed);
    if (awareness) this.presence = new DocumentPresence(awareness, update => {
      if (this.opened && !this.blocked && !this.stopped && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ v: 1, type: 'awareness', requestId: crypto.randomUUID(), ...this.scope, update: toBase64(update) }));
    });
  }
  private setState(state: SaveState, reason = '') {
    if (this.localFailed && state !== 'storage-error') return;
    this.state = state; this.reason = reason; this.onState(state, reason);
  }
  private storageFailure(reason = '本机保存失败，请保留页面并重试或导出当前修改') {
    this.localFailed = true; this.setState('storage-error', reason);
  }
  private changed = (update: Uint8Array, origin: unknown) => {
    if (this.stopped) return;
    if (origin !== this.remoteOrigin && !this.blocked) this.setState('syncing');
    this.sequence = this.sequence.then(() => this.local.persist(this.scope, update, origin !== this.remoteOrigin))
      .then(() => { if (!this.blocked && this.state !== 'cloud') this.setState('local'); })
      .catch(() => this.storageFailure());
    void this.sequence.then(() => this.flush());
  };
  async start(waitForRemote = true) {
    await this.sequence;
    if (this.blocked) throw new Error(this.reason);
    if (!this.initial) return;
    const reason = await this.local.checkAccess(this.scope, this.accessRevision);
    const cached = await this.local.load(this.scope);
    if (cached) Y.applyUpdate(this.doc, cached, this.remoteOrigin);
    if (reason) {
      this.blocked = true; this.blockedReason = reason; this.setState('blocked', reason);
      if (!cached) throw new Error(reason);
      return;
    }
    this.setState('local');
    const ready = !cached && waitForRemote ? new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failInitial('此设备尚未缓存文档，连接成功后请重新打开'), 15_000);
      this.firstSync = { resolve, reject, timer };
    }) : undefined;
    void this.connect();
    await ready;
  }
  private failInitial(reason: string) {
    if (!this.firstSync) return;
    clearTimeout(this.firstSync.timer);
    this.firstSync.reject(new Error(reason)); this.firstSync = undefined;
  }
  private async preserveDraft() {
    await this.sequence;
    const pending = await this.local.pending(this.scope);
    const ids = pending.map(row => row.id).sort().join(',');
    if (ids && ids !== this.draftIds) {
      await this.local.draft(this.scope, Y.encodeStateAsUpdate(this.doc));
      this.draftIds = ids;
    }
    return pending;
  }
  private async block(reason: string, memberWide = false) {
    this.blocked = true;
    this.blockedReason = reason;
    this.presence?.close(); this.socket?.close();
    this.setState('blocked', reason);
    this.failInitial(reason);
    try {
      await this.local.block(this.scope, reason);
      await this.preserveDraft();
      if (memberWide) await this.local.blockPending(reason);
    }
    catch { this.localFailed = true; this.setState('storage-error', '暂停状态保存失败，请保留页面并导出当前修改'); }
  }
  private retryConnection() {
    if (!this.blocked && !this.stopped && !this.localFailed) {
      this.setState('local', '连接中断，修改保留在此设备');
      this.timer = setTimeout(() => void this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5)));
    }
  }
  private async connect() {
    if (this.connecting || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.connecting = true;
    clearTimeout(this.timer);
    try { await this.connectSocket(); } finally { this.connecting = false; }
  }
  private async connectSocket() {
    if (this.stopped || this.blocked || this.localFailed) return;
    try {
      const pending = await this.preserveDraft();
      const session = await api<{ member: Member; epoch: string }>('session');
      if (this.stopped) return;
      if (session.member.id !== this.local.memberId) {
        await this.block('浏览器成员身份已切换，原成员离线稿保留，暂停上传'); return;
      }
      this.onAccess(session.member);
      if (session.epoch !== this.scope.epoch || !canEdit(session.member.role) && pending.length > 0) {
        await this.block('权限或恢复状态已变化，离线稿保留，暂停上传'); return;
      }
      const reason = await this.local.checkAccess(this.scope, session.member.accessRevision);
      if (reason) { await this.block(reason); return; }
      this.accessRevision = session.member.accessRevision;
    } catch (error) {
      if (error instanceof RequestError && [401, 403, 409].includes(error.status)) {
        await this.block('需要恢复原成员身份，离线稿保留', true);
      } else if (error instanceof RequestError || error instanceof TypeError) this.retryConnection();
      else { this.localFailed = true; this.setState('storage-error', '离线稿保存失败，请导出当前修改'); }
      this.failInitial('此设备尚未缓存文档，请在连接成功后重新打开'); return;
    }
    if (this.stopped || this.blocked) return;
    const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/sync');
    this.socket = socket;
    let incoming = Promise.resolve();
    socket.onmessage = event => {
      incoming = incoming.then(() => this.message(JSON.parse(event.data) as ServerMessage, socket))
        .catch(async () => { await this.block('同步响应异常，离线稿已保留'); socket.close(); });
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.opened = false; this.synchronizing = false;
      this.presence?.close();
      if (this.inFlight) clearTimeout(this.inFlight.timer);
      this.inFlight = undefined;
      if (!this.blocked && !this.localFailed) {
        this.setState('local', '连接中断，修改保留在此设备');
        this.retryConnection();
      }
    };
  }
  private async message(message: ServerMessage, socket: WebSocket) {
    if (this.stopped || this.socket !== socket) return;
    if (message.v !== 1) throw new Error('protocol_version');
    if (message.type === 'ready') {
      await this.sequence;
      const pending = await this.preserveDraft();
      if (message.member.id !== this.local.memberId) {
        await this.block('浏览器成员身份已切换，原成员离线稿保留，暂停上传'); socket.close(); return;
      }
      if (message.epoch !== this.scope.epoch || !canEdit(message.member.role) && pending.length > 0) {
        await this.block('权限或恢复状态已变化，离线稿保留，暂停上传'); socket.close(); return;
      }
      const reason = await this.local.checkAccess(this.scope, message.member.accessRevision);
      if (reason) { await this.block(reason); socket.close(); return; }
      this.accessRevision = message.member.accessRevision; this.onAccess(message.member);
      this.setState('syncing');
      socket.send(JSON.stringify({ v: 1, type: 'open', requestId: crypto.randomUUID(), ...this.scope, stateVector: toBase64(Y.encodeStateVector(this.doc)) }));
    } else if (message.type === 'sync') {
      if (message.docId !== this.scope.docId || message.epoch !== this.scope.epoch || message.generation !== this.scope.generation) throw new Error('scope_changed');
      await this.preserveDraft();
      Y.applyUpdate(this.doc, fromBase64(message.update), this.remoteOrigin);
      await this.sequence;
      this.opened = true; this.retries = 0; this.initial = false;
      this.presence?.open();
      if (this.firstSync) { clearTimeout(this.firstSync.timer); this.firstSync.resolve(); this.firstSync = undefined; }
      await this.flush();
    } else if (message.type === 'update') {
      if (message.docId !== this.scope.docId || message.epoch !== this.scope.epoch || message.generation !== this.scope.generation) throw new Error('scope_changed');
      Y.applyUpdate(this.doc, fromBase64(message.update), this.remoteOrigin);
    } else if (message.type === 'saved') {
      const receipt = this.inFlight;
      if (!receipt || message.requestId !== receipt.requestId) return;
      if (message.updateHash !== receipt.hash || message.docId !== this.scope.docId || message.epoch !== this.scope.epoch || message.generation !== this.scope.generation) throw new Error('invalid_receipt');
      clearTimeout(receipt.timer); this.inFlight = undefined;
      try { await this.local.acknowledge(receipt.ids); } catch { this.storageFailure(); return; }
      await this.flush();
    } else if (message.type === 'awareness') {
      if (message.docId !== this.scope.docId || message.epoch !== this.scope.epoch || message.generation !== this.scope.generation) throw new Error('scope_changed');
      if (!this.blocked) this.presence?.receive(fromBase64(message.update));
    } else if (message.type === 'error') {
      if (message.code === 'storage_unavailable' || message.code === 'space_paused') {
        socket.close(); return;
      }
      await this.block('同步已暂停：' + message.code + '。本机修改仍可导出'); socket.close();
    } else if (message.type === 'catalog') this.onCatalog();
  }
  private async flush() {
    if (this.synchronizing || this.stopped || this.blocked || this.localFailed || !this.opened || this.inFlight || this.socket?.readyState !== WebSocket.OPEN) return;
    this.synchronizing = true;
    const sequence = this.sequence;
    try {
      await sequence;
      const reason = await this.local.checkAccess(this.scope, this.accessRevision);
      if (reason) { await this.block(reason); return; }
      const pending = await this.local.pending(this.scope);
      if (!pending.length) { if (this.sequence === sequence) this.setState('cloud'); return; }
      if (this.beforePush && !await this.beforePush()) { this.setState('local', '有附件仍保留在此设备，请等待上传或处理附件状态'); return; }
      const update = Y.mergeUpdates(pending.map(row => row.update));
      const digest = await crypto.subtle.digest('SHA-256', update as Uint8Array<ArrayBuffer>);
      const updateHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      if (this.socket?.readyState !== WebSocket.OPEN || this.blocked || this.stopped) return;
      const requestId = crypto.randomUUID();
      this.inFlight = { requestId, ids: pending.map(row => row.id), hash: updateHash, timer: setTimeout(() => this.socket?.close(), 15_000) };
      this.setState('syncing');
      this.socket.send(JSON.stringify({ v: 1, type: 'push', requestId, ...this.scope, update: toBase64(update) }));
    } catch { this.localFailed = true; this.setState('storage-error', '本机保存失败，请导出当前修改'); }
    finally { this.synchronizing = false; if (this.sequence !== sequence) void this.flush(); }
  }
  async retryLocalSave() {
    if (this.stopped) return;
    if (this.blocked) {
      if (!this.localFailed) return;
      try {
        await this.sequence;
        await this.local.block(this.scope, this.blockedReason);
        await this.local.persist(this.scope, Y.encodeStateAsUpdate(this.doc), true);
        await this.preserveDraft(); this.localFailed = false;
        this.setState('blocked', this.blockedReason);
      } catch { this.storageFailure('暂停稿仍无法保存，请保留页面并导出当前修改'); }
      return;
    }
    const recovery = this.sequence.then(async () => {
      try {
        if (this.localFailed) await this.local.persist(this.scope, Y.encodeStateAsUpdate(this.doc), true);
        this.localFailed = false;
      } catch { this.storageFailure('本机保存仍失败，请保留页面并导出当前修改'); }
    });
    this.sequence = recovery;
    await recovery;
    if (this.localFailed) return;
    try {
      this.setState('local');
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) this.connect(); else await this.flush();
    } catch { this.storageFailure('本机保存仍失败，请保留页面并导出当前修改'); }
  }
  get hasStorageFailure() { return this.localFailed; }
  get isBlocked() { return this.blocked; }
  get loading() { return this.initial; }
  settled() { return this.sequence; }
  async pause(reason: string) {
    await this.block(reason); this.stop();
  }
  stop() {
    this.stopped = true;
    this.failInitial('文档已停止加载');
    clearTimeout(this.timer);
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.socket?.close();
    this.presence?.dispose();
    this.doc.off('update', this.changed);
  }
}
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
