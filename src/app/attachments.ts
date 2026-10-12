import { canEdit } from '../../shared/protocol';
import { attachmentError } from './blobs';
import type { CachedBlob } from './local';
import type { ProductionDoc, ProductionWorkspace } from './workspace';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
}
export function downloadAttachment(row: Pick<CachedBlob, 'name' | 'data' | 'blobKey'>) {
  const url = URL.createObjectURL(row.data), link = element('a');
  link.href = url; link.download = row.name || row.blobKey + '.bin'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function showAttachments(active: ProductionWorkspace, target?: ProductionDoc) {
  const box = element('dialog'); box.className = 'attachments-dialog'; box.setAttribute('aria-label', '附件与离线缓存');
  const notice = element('p'); notice.setAttribute('role', 'status');
  const explanation = element('p', '已缓存附件可断网下载。异常附件、恢复前附件和原始副本继续保留；确认重新提交后，会在当前文档追加新的附件卡片，并按当前身份、权限和文档状态上传。旧正文仍保留。');
  const destination = element('p', '重新提交目标：' + (target?.meta?.title || '请先打开文档'));
  const list = element('div'); list.className = 'attachment-list';
  let busy = false, queued = false, closed = false;
  const canAppend = () => !!target && canEdit(active.member.role) && !target.sync.isBlocked && !target.sync.hasStorageFailure;
  const act = (label: string, action: () => unknown) => {
    const button = element('button', label);
    button.onclick = () => {
      button.disabled = true; busy = true;
      Promise.resolve().then(action).catch(error => { notice.textContent = attachmentError(error); }).finally(() => { busy = false; void refresh(); });
    };
    return button;
  };
  const refresh = async () => {
    if (closed) return;
    if (busy) { queued = true; return; }
    busy = true; queued = false;
    try {
      const [cached, drafts] = await Promise.allSettled([active.local.blobs(), active.local.blobDrafts()]);
      if (closed) return;
      const rows: (CachedBlob & { archiveId?: string })[] = [...active.blobs.memory.values(), ...cached.status === 'fulfilled' ? cached.value : [], ...drafts.status === 'fulfilled' ? drafts.value : []];
      list.replaceChildren();
      if (cached.status === 'rejected' || drafts.status === 'rejected') notice.textContent = '部分本机附件读取失败，内存中原文件仍可下载，请保留页面';
      if (!rows.length) list.append(element('p', '此设备暂无附件缓存'));
      for (const row of rows) {
        const item = element('section'); item.className = 'attachment-row';
        const metadata = active.blobMetadata(row.blobKey), name = row.name || metadata.name || '附件 ' + row.blobKey.slice(0, 10);
        item.append(element('h3', name));
        const inMemory = active.blobs.memory.get(row.blobKey) === row;
        const oldEpoch = row.epoch !== active.epoch;
        const linked = !!row.scope || !!active.blobScope(row.blobKey);
        const state = active.blobs.blobState$(row.blobKey).value;
        const status = row.archiveId ? '重新提交前原始副本，保留供下载' : inMemory ? '本机保存失败，原文件仍在页面内存' : oldEpoch ? '恢复前附件，保留在此设备' : row.saved ? '已缓存，已保存到云端' : row.blockedReason || state.errorMessage || (state.uploading ? '正在上传' : linked ? '已保存到此设备，等待上传' : '已保存到此设备，尚未添加到文档，请确认重新提交');
        item.append(element('p', `${(row.data.size / 1_000_000).toFixed(2)} MB · ${status}`));
        const controls = element('div');
        controls.append(act('下载原文件', () => downloadAttachment({ ...row, name })));
        if (inMemory) controls.append(act('重试本机保存', () => active.blobs.retryLocalSave()));
        if (!row.archiveId && !oldEpoch && !row.saved && !row.blockedReason && !inMemory && linked) controls.append(act('重试上传', () => active.blobs.upload(row.blobKey)));
        if (row.archiveId || oldEpoch || row.blockedReason || inMemory || !row.scope && !row.saved) {
          const resubmit = act('确认重新提交到当前文档', async () => {
            if (!target) throw new Error('请先打开当前获准编辑的文档');
            await active.resubmitAttachment(target, { ...row, name, type: row.type || metadata.type });
            notice.textContent = '已按当前权限保存附件并追加卡片，原始副本继续保留';
          });
          resubmit.disabled = !canAppend(); controls.append(resubmit);
        }
        item.append(controls); list.append(item);
      }
    } finally { busy = false; if (queued && !closed) void refresh(); }
  };
  const subscription = active.blobs.changes.subscribe(() => { void refresh(); });
  box.addEventListener('close', () => { closed = true; subscription.unsubscribe(); box.remove(); });
  box.append(element('h2', '附件与离线缓存'), explanation, destination, notice, list, act('刷新附件列表', refresh), act('关闭', () => box.close()));
  document.body.append(box); box.showModal(); await refresh();
}
