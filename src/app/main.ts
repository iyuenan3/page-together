import { AdapterPanel } from '@blocksuite/affine/fragments/adapter-panel';
import { FramePanel } from '@blocksuite/affine/fragments/frame-panel';
import { OutlinePanel } from '@blocksuite/affine/fragments/outline';
import type { DocMode } from '@blocksuite/affine/model';
import { FeatureFlagService } from '@blocksuite/affine/shared/services';
import { Text } from '@blocksuite/affine/store';
import '@toeverything/theme/style.css';
import 'katex/dist/katex.min.css';
import * as Y from 'yjs';
import { canEdit, type DocumentInfo, type Member } from '../../shared/protocol';
import { EditorView } from '../editor/editor';
import { api, RequestError } from './api';
import { LocalPersistence } from './local';
import { toBase64, type SaveState } from './sync';
import { ProductionWorkspace, type ProductionDoc } from './workspace';
import { showDrafts } from './drafts';
import '../lab/style.css';
import './style.css';

interface Session { member: Member; epoch: string; paused: boolean }
const root = document.querySelector<HTMLDivElement>('#app')!;
const fragment = new URLSearchParams(location.hash.slice(1));
let invitation = fragment.get('invite') ?? '';
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
let workspace: ProductionWorkspace | undefined;
let current: ProductionDoc | undefined;
let mode: DocMode = 'page';
let selection = 0;
let editor: EditorView | undefined;
let panelKind: 'outline' | 'frame' | 'adapter' | undefined;
let syncNotice = '';

function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function errorMessage(error: unknown) {
  if (error instanceof RequestError) {
    const descriptions: Record<string, string> = {
      session_expired: '会话已失效，请恢复原成员身份。本机离线内容仍保留。',
      invalid_invitation: '邀请无效、过期或已使用，请联系所有者。',
      invalid_recovery: '恢复码无效，请使用最近保存的恢复码。',
      space_paused: '空间正在恢复维护，请等待所有者确认。',
      read_only: '当前为查看权限，不能写入。',
      forbidden: '当前没有此操作权限。',
      rate_limited: '操作过于频繁，请稍后重试。',
    };
    return descriptions[error.code] ?? '操作未完成：' + error.code;
  }
  return error instanceof TypeError ? '网络不可用，本机内容保留，联网后可重试。' : error instanceof Error ? error.message : '操作未完成，请重试。';
}
function report(error: unknown) {
  const target = document.querySelector('#notice');
  if (target) target.textContent = errorMessage(error);
}
function button(label: string, action: () => unknown) {
  const element = document.createElement('button'); element.textContent = label;
  element.onclick = () => { Promise.resolve().then(action).catch(report); }; return element;
}
function dialog(title: string) {
  const element = document.createElement('dialog'), heading = document.createElement('h2');
  heading.textContent = title; element.append(heading); document.body.append(element);
  element.addEventListener('close', () => element.remove()); element.showModal(); return element;
}
function recoveryMaterial(code: string) {
  return new Promise<void>(resolve => {
    const box = dialog('保存新的离线恢复码');
    const note = document.createElement('p'), value = document.createElement('pre');
    note.textContent = '旧恢复码和旧会话已失效。请把新码保存在离线安全位置，本页面关闭后不会再次显示。';
    value.textContent = code;
    box.addEventListener('cancel', event => event.preventDefault());
    box.append(note, value, button('下载恢复码', () => download('pageTogether-recovery.txt', new Blob([code], { type: 'text/plain' }))), button('我已保存，进入空间', () => { box.close(); resolve(); }));
  });
}
function savedSession(): Session | undefined {
  try { return JSON.parse(localStorage.getItem('page-together-session') ?? 'null') ?? undefined; } catch { return undefined; }
}
function cacheSession(session: Session) {
  try { localStorage.setItem('page-together-session', JSON.stringify(session)); }
  catch { report(new Error('本机身份缓存保存失败')); }
}
async function exportLocal() {
  const session = savedSession();
  if (!session) throw new Error('此设备没有已记录的成员缓存');
  const local = workspace?.local ?? new LocalPersistence(session.member.id);
  try {
    const memory = workspace ? [...new Set([...workspace.docs.values(), ...workspace.retired, ...current ? [current] : []])].map(doc => ({ scope: doc.sync.scope, data: toBase64(Y.encodeStateAsUpdate(doc.spaceDoc)) })) : [];
    const [documentResult, draftResult, blobResult] = await Promise.allSettled([local.documents(), local.drafts(), local.blobs()]);
    const documents = documentResult.status === 'fulfilled' ? documentResult.value.map(row => ({ ...row, data: toBase64(row.data) })) : [];
    const drafts = draftResult.status === 'fulfilled' ? draftResult.value.map(row => ({ ...row, data: toBase64(row.data) })) : [];
    const attachments = blobResult.status === 'fulfilled' ? blobResult.value : [];
    const readErrors = [documentResult, draftResult, blobResult].flatMap(result => result.status === 'rejected' ? [errorMessage(result.reason)] : []);
    if (!memory.length && !documents.length && !drafts.length && !attachments.length) throw new Error('此设备没有可读取的本机内容，请保留当前页面后重试');
    download('pageTogether-local-drafts.json', new Blob([JSON.stringify({ format: 1, documents, drafts, memory, readErrors })], { type: 'application/json' }));
    if (attachments.length) {
      const box = dialog('离线附件');
      const note = document.createElement('p'); note.textContent = '正文与离线稿已导出。附件保留在此设备，可分别下载。'; box.append(note);
      for (const row of attachments) box.append(button('下载附件 ' + row.blobKey.slice(0, 10), () => download(row.blobKey + '.bin', row.data)));
      box.append(button('关闭', () => box.close()));
    }
  } finally { if (!workspace) await local.close().catch(report); }
}
function showLogin(message = '') {
  workspace?.dispose(); workspace = undefined; current = undefined;
  root.innerHTML = `<main class="login"><div class="brand">pageTogether</div><p>和受邀朋友一起记录、整理和创作</p><form id="invite-form"><h2>通过邀请进入</h2><label>昵称<input name="nickname" required maxlength="80" autocomplete="nickname"></label><label>邀请内容<input name="invitation" required autocomplete="off" spellcheck="false"></label><button type="submit">进入共享空间</button></form><details><summary>所有者恢复访问</summary><form id="recovery-form"><label>离线恢复码<input name="code" type="password" required autocomplete="off"></label><button type="submit">恢复所有者访问</button></form></details><p id="notice" role="alert"></p><div id="local-export"></div></main>`;
  root.querySelector<HTMLInputElement>('[name=invitation]')!.value = invitation;
  root.querySelector('#notice')!.textContent = message;
  root.querySelector('#local-export')!.append(button('导出此设备保留的离线内容', exportLocal));
  function login(form: HTMLFormElement, recover: boolean) {
    form.onsubmit = event => {
      event.preventDefault();
      const submit = form.querySelector<HTMLButtonElement>('button')!; submit.disabled = true;
      const values = new FormData(form);
      const entered = String(values.get('invitation') ?? '').trim();
      let token = entered;
      try { token = new URLSearchParams(new URL(entered).hash.slice(1)).get('invite') ?? entered; } catch {}
      const body = recover ? { code: String(values.get('code')).trim() } : { nickname: String(values.get('nickname')).trim(), token };
      api<Session & { recoveryCode?: string }>(recover ? 'auth/recover' : 'auth/invite', 'POST', body)
        .then(async result => {
          invitation = ''; form.reset();
          localStorage.setItem('page-together-signed-out', 'false');
          if (result.recoveryCode) await recoveryMaterial(result.recoveryCode);
          await enter(result);
        }).catch(report).finally(() => { submit.disabled = false; });
    };
  }
  login(root.querySelector('#invite-form')!, false); login(root.querySelector('#recovery-form')!, true);
}
async function inviteMember(member?: Member, recovery = false) {
  const box = dialog(member ? '为成员恢复或增加设备' : '邀请朋友');
  const select = document.createElement('select');
  for (const [value, label] of [['edit', '编辑'], ['view', '查看']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
  const output = document.createElement('textarea'); output.readOnly = true; output.rows = 3;
  const notice = document.createElement('p'); notice.textContent = member ? (recovery ? '兑换后撤销该成员旧会话。' : '新设备与原设备可以同时使用。') : '邀请默认 7 天有效，只可兑换一次。';
  if (!member) box.append(select);
  box.append(notice, button('生成邀请', async () => {
    const result = await api<{ token: string }>('invitations', 'POST', { role: select.value, memberId: member?.id, recovery });
    output.value = location.origin + '/#invite=' + encodeURIComponent(result.token);
  }), output, button('复制邀请', () => navigator.clipboard.writeText(output.value)), button('关闭', () => box.close()));
}
async function members() {
  const rows = await api<Member[]>('members'), box = dialog('空间成员');
  for (const row of rows) {
    const line = document.createElement('div'), name = document.createElement('span'), select = document.createElement('select');
    name.textContent = row.nickname + (row.owner ? '（所有者）' : row.active ? '' : '（已移除）');
    for (const [value, label] of [['manage', '管理'], ['edit', '编辑'], ['view', '查看']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
    select.value = row.role; select.disabled = row.owner || (!workspace!.member.owner && row.role === 'manage');
    line.append(name, select);
    if (!row.owner) {
      const save = button('保存角色', () => update(select.value as Member['role'], row.active));
      const toggle = button(row.active ? '移除' : '恢复资格', () => update(row.role, !row.active));
      async function update(role: Member['role'], active: boolean) {
        save.disabled = toggle.disabled = select.disabled = true;
        try {
          Object.assign(row, await api<Member>('members/' + row.id, 'PATCH', { role, active }));
          name.textContent = row.nickname + (row.active ? '' : '（已移除）');
          select.value = row.role;
          toggle.textContent = row.active ? '移除' : '恢复资格';
        } finally {
          save.disabled = toggle.disabled = false;
          select.disabled = !workspace!.member.owner && row.role === 'manage';
        }
      }
      line.append(save, toggle);
      if (workspace!.member.owner) line.append(button('增加设备', () => inviteMember(row)), button('恢复身份', () => inviteMember(row, true)));
    }
    box.append(line);
  }
  box.append(button('关闭', () => box.close()));
}
async function trash() {
  const records = await api<DocumentInfo[]>('documents?trash=1'), box = dialog('回收站');
  for (const row of records) {
    const line = document.createElement('div'), name = document.createElement('span'); name.textContent = row.title;
    line.append(name, button('恢复文档', async () => { await api('documents/' + row.id + '/restore', 'POST'); await workspace!.refresh(); box.close(); })); box.append(line);
  }
  if (!records.length) box.append('回收站为空');
  box.append(button('关闭', () => box.close()));
}
function renderDocuments() {
  const nav = root.querySelector('#documents'); if (!nav || !workspace) return;
  nav.replaceChildren(...[...workspace.docs.values()].map(doc => {
    const item = button(doc.meta?.title || '无标题', () => selectDocument(doc));
    item.className = 'document' + (doc === current ? ' active' : ''); return item;
  }));
}
function renderPresence() {
  const target = root.querySelector('#online-members'); if (!target) return;
  const presence = current?.sync.presence;
  target.replaceChildren();
  if (!presence?.connected) { target.textContent = '离线，在线状态不可用'; return; }
  const members = presence.members(), count = document.createElement('span'); count.textContent = `此文档在线 ${members.length} 人`; target.append(count);
  for (const member of members) {
    const badge = document.createElement('span'); badge.className = 'online-member'; badge.textContent = member.name;
    badge.title = member.devices > 1 ? `${member.devices} 个页面在线` : member.name;
    badge.style.borderColor = member.color; target.append(badge);
  }
}
async function saveStatus() {
  if (!workspace) return;
  const active = workspace;
  const labels: Record<SaveState, string> = { loading: '正在加载', local: '已保存到此设备', syncing: '正在同步', cloud: '已保存到云端', blocked: '同步暂停，离线稿保留', 'storage-error': '本机保存失败' };
  const visibleDocs = [...new Set([...active.docs.values(), ...current ? [current] : []])];
  const states = visibleDocs.filter(doc => doc.loaded || doc.ready || doc.sync.state !== 'loading').map(doc => doc.sync.state);
  const priority: SaveState[] = ['storage-error', 'blocked', 'syncing', 'loading', 'local', 'cloud'];
  let state = priority.find(value => states.includes(value)) ?? 'cloud';
  let pendingBlobs: Awaited<ReturnType<LocalPersistence['blobs']>> = [];
  try { pendingBlobs = await active.local.blobs(active.epoch, true); }
  catch { state = 'storage-error'; }
  if (workspace !== active) return;
  const label = root.querySelector('#save-status');
  if (label) { label.textContent = labels[state] + (pendingBlobs.length ? '，有附件待上传' : ''); label.setAttribute('data-state', pendingBlobs.length && state === 'cloud' ? 'local' : state); }
  const reason = visibleDocs.find(doc => doc.sync.reason)?.sync.reason;
  const notice = root.querySelector('#notice')!;
  if (reason) { notice.textContent = reason; syncNotice = reason; }
  else if (notice.textContent === syncNotice) { notice.textContent = ''; syncNotice = ''; }
  root.querySelector<HTMLButtonElement>('#new-doc')!.disabled = !canEdit(active.member.role) || !navigator.onLine;
  root.querySelector<HTMLButtonElement>('#delete-doc')!.hidden = active.member.role !== 'manage';
  root.querySelector<HTMLDivElement>('#management')!.hidden = active.member.role !== 'manage';
  root.querySelector<HTMLButtonElement>('#reopen-cloud')!.hidden = current?.sync.state !== 'blocked';
  renderPresence();
}
function updatePanel() {
  if (!editor?.std || !current || !panelKind) return;
  const target = root.querySelector('#panel-content')!;
  if (panelKind === 'adapter') { const panel = new AdapterPanel(); panel.store = current.getStore(); target.replaceChildren(panel); }
  else if (panelKind === 'outline') { const panel = new OutlinePanel(); panel.editor = editor.std.host; target.replaceChildren(panel); }
  else if (mode === 'edgeless') { const panel = new FramePanel(); panel.host = editor.std.host; target.replaceChildren(panel); }
  else target.textContent = '切换到画板后查看画框。';
}
async function selectDocument(doc: ProductionDoc) {
  const selected = ++selection;
  await doc.prepare();
  if (selected !== selection || !workspace) return;
  const store = doc.getStore(); store.load();
  if (!store.root) throw new Error('文档正文尚未初始化，请稍后重新打开或联系管理者');
  if (current !== doc) current?.sync.presence?.setActive(false);
  current = doc;
  doc.sync.presence?.setActive(true);
  root.querySelector('#empty-space')?.remove();
  store.get(FeatureFlagService).setFlag('enable_advanced_block_visibility', true);
  store.get(FeatureFlagService).setFlag('enable_callout', true);
  editor!.setContext(store, mode); renderDocuments(); await saveStatus();
}
async function enter(session: Session, offlineRecords?: DocumentInfo[]) {
  if (session.paused) {
    workspace?.dispose(); current = undefined;
    root.innerHTML = '<main class="login"><h1>空间恢复维护中</h1><p>请先核对成员资格和恢复结果，再恢复访问。</p><p id="notice" role="alert"></p></main>';
    workspace = new ProductionWorkspace(session.member, session.epoch, []); workspace.report = report;
    root.firstElementChild!.append(button('检查成员', members), button('确认恢复访问', async () => { await api('maintenance/resume', 'POST'); await bootstrap(); })); return;
  }
  const records = offlineRecords ?? await api<DocumentInfo[]>('documents');
  workspace?.dispose();
  workspace = new ProductionWorkspace(session.member, session.epoch, records);
  workspace.report = report;
  workspace.presenceChanged = renderPresence;
  workspace.accessChanged = member => cacheSession({ ...session, member });
  workspace.changed = () => { renderDocuments(); void saveStatus().catch(report); };
  workspace.cacheCatalog();
  cacheSession(session);
  root.innerHTML = `<aside class="sidebar"><div class="brand">pageTogether</div><p id="member-name"></p><div id="online-members" aria-label="当前文档在线成员" role="status"></div><button id="new-doc" class="new-doc">＋ 新建文档</button><nav id="documents" aria-label="文档"></nav><div id="management"></div><div id="local-tools"></div><p id="notice" role="alert"></p></aside><main class="main"><header class="toolbar"><div class="mode-tabs"><button id="page-mode" aria-pressed="true">正文</button><button id="edgeless-mode" aria-pressed="false">画板</button></div><div class="panel-tools"><button id="outline-panel">大纲</button><button id="frame-panel">画框</button><button id="adapter-panel">导入导出</button></div><span id="save-status" role="status">正在加载</span></header><div class="work-area"><div id="editor-region" class="editor-region"></div><aside id="panel-region" class="native-panel" hidden><div class="panel-heading"><span>原生面板</span><button id="close-panel">关闭</button></div><div id="panel-content"></div></aside></div><footer><button id="delete-doc">移入回收站</button><button id="retry-save">重试本机保存</button><button id="reopen-cloud" hidden>保留离线稿并读取云端</button><button id="logout">退出空间</button></footer></main>`;
  root.querySelector('#member-name')!.textContent = session.member.nickname;
  editor = new EditorView(); root.querySelector('#editor-region')!.append(editor);
  workspace.slots.docListUpdated.subscribe(renderDocuments);
  root.querySelector<HTMLButtonElement>('#new-doc')!.onclick = () => {
    Promise.resolve().then(() => workspace!.createDoc()).then(async doc => {
      await doc.prepare();
      const store = doc.getStore();
      store.load(() => {
        const page = store.addBlock('affine:page', { title: new Text('无标题') });
        store.addBlock('affine:surface', {}, page);
        const note = store.addBlock('affine:note', {}, page);
        store.addBlock('affine:paragraph', { text: new Text('') }, note);
      });
      await selectDocument(doc);
    }).catch(report);
  };
  for (const value of ['page', 'edgeless'] as const) root.querySelector<HTMLButtonElement>('#' + value + '-mode')!.onclick = () => {
    mode = value; root.querySelector('#page-mode')!.setAttribute('aria-pressed', String(mode === 'page')); root.querySelector('#edgeless-mode')!.setAttribute('aria-pressed', String(mode === 'edgeless'));
    if (current) editor!.setContext(current.getStore(), mode);
  };
  editor.addEventListener('mode-change', event => { mode = (event as CustomEvent<DocMode>).detail; if (current) editor!.setContext(current.getStore(), mode); });
  editor.addEventListener('doc-change', event => { const doc = workspace!.getDoc((event as CustomEvent<string>).detail); if (doc) void selectDocument(doc).catch(report); });
  editor.addEventListener('context-ready', updatePanel);
  for (const kind of ['outline', 'frame', 'adapter'] as const) root.querySelector<HTMLButtonElement>('#' + kind + '-panel')!.onclick = () => { panelKind = kind; root.querySelector<HTMLDivElement>('#panel-region')!.hidden = false; updatePanel(); };
  root.querySelector<HTMLButtonElement>('#close-panel')!.onclick = () => { panelKind = undefined; root.querySelector<HTMLDivElement>('#panel-region')!.hidden = true; root.querySelector('#panel-content')!.replaceChildren(); };
  root.querySelector<HTMLButtonElement>('#delete-doc')!.onclick = () => { if (current) { try { workspace!.removeDoc(current.id); } catch (error) { report(error); } } };
  root.querySelector<HTMLButtonElement>('#retry-save')!.onclick = () => { for (const doc of workspace!.docs.values()) if (doc.loaded || doc.ready || doc.sync.state !== 'loading') void doc.sync.retryLocalSave(); void workspace!.blobs.flush(); };
  root.querySelector<HTMLButtonElement>('#reopen-cloud')!.onclick = () => {
    const active = workspace, doc = current;
    if (!active || !doc) return;
    Promise.resolve().then(async () => {
      const session = await api<Session>('session');
      if (session.member.id !== active.member.id) throw new Error('请先恢复原成员身份');
      if (session.epoch !== active.epoch || session.paused) { await enter(session); return; }
      const records = await api<DocumentInfo[]>('documents');
      const record = records.find(row => row.id === doc.id);
      if (!record || record.generation !== doc.record.generation) { await enter(session); return; }
      active.member = session.member; active.accessChanged(session.member);
      await selectDocument(await active.reopenCloud(doc));
      report(new Error('旧离线稿已保留，可通过“导出本机内容与离线稿”下载；当前显示云端正文。'));
    }).catch(report);
  };
  root.querySelector<HTMLButtonElement>('#logout')!.onclick = () => {
    if ([...workspace!.docs.values(), ...workspace!.retired].some(doc => doc.sync.hasStorageFailure)) { report(new Error('本机保存失败，请先重试保存或导出当前修改，并保留页面')); return; }
    api('logout', 'POST').then(() => { localStorage.setItem('page-together-signed-out', 'true'); showLogin('已退出空间，本机离线内容仍保留。'); }).catch(report);
  };
  if (session.member.role === 'manage') root.querySelector('#management')!.append(button('邀请朋友', () => inviteMember()), button('成员管理', members), button('回收站', trash));
  root.querySelector('#local-tools')!.append(button('查看离线稿与人工合并', () => showDrafts(workspace!, current)), button('导出本机内容与离线稿', exportLocal));
  renderDocuments();
  const first = workspace.docs.values().next().value;
  if (first) await selectDocument(first);
  else { const empty = document.createElement('p'); empty.id = 'empty-space'; empty.textContent = '空间中还没有文档。'; root.querySelector('#editor-region')!.append(empty); }
  void workspace.blobs.flush(); await saveStatus();
}
async function bootstrap() {
  try { await enter(await api<Session>('session')); }
  catch (error) {
    const cached = savedSession();
    if (error instanceof RequestError && [401, 403].includes(error.status) && cached) {
      const local = workspace?.local ?? new LocalPersistence(cached.member.id);
      try { await local.blockPending('身份或访问资格已失效，离线稿与附件保留供导出'); }
      finally { if (!workspace) await local.close(); }
    }
    if (error instanceof TypeError && cached && localStorage.getItem('page-together-signed-out') !== 'true') {
      const catalog = JSON.parse(localStorage.getItem('page-together-catalog-' + cached.member.id) ?? 'null') as { epoch: string; records: DocumentInfo[] } | null;
      if (catalog?.epoch === cached.epoch) { await enter(cached, catalog.records); report(error); return; }
    }
    showLogin(error instanceof RequestError && error.status === 401 ? '' : errorMessage(error));
  }
}
window.addEventListener('pagehide', () => workspace?.dispose());
window.addEventListener('beforeunload', event => {
  if (workspace && [...workspace.docs.values(), ...workspace.retired].some(doc => doc.sync.hasStorageFailure)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('online', () => { if (workspace) { void workspace.refresh().catch(report); void workspace.blobs.flush(); } });
void bootstrap().catch(error => showLogin(errorMessage(error)));
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(report);
