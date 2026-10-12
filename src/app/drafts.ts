import * as Y from 'yjs';
import { canEdit } from '../../shared/protocol';
import { EditorView } from '../editor/editor';
import { parseScope, snapshotText, textDifference, type DraftRecord } from './draft-data';
import { SnapshotDoc } from './preview';
import { toBase64 } from './sync';
import type { ProductionDoc, ProductionWorkspace } from './workspace';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
}
export async function showDrafts(active: ProductionWorkspace, target?: ProductionDoc) {
  const [drafts, documents] = await Promise.allSettled([active.local.drafts(), active.local.documents()]);
  const records: DraftRecord[] = [];
  if (drafts.status === 'fulfilled') for (const row of drafts.value.sort((a, b) => b.createdAt - a.createdAt)) {
    const scope = parseScope(row.scope); if (scope) records.push({ ...row, scope, source: 'draft' });
  }
  if (documents.status === 'fulfilled') for (const row of documents.value) {
    const scope = parseScope(row.scope); if (scope) records.push({ ...row, id: 'cache-' + row.scope, scope, source: 'cache' });
  }
  for (const doc of new Set([...active.docs.values(), ...active.retired])) if (doc.loaded || doc.ready) {
    records.unshift({ id: 'memory-' + crypto.randomUUID(), scope: doc.sync.scope, data: Y.encodeStateAsUpdate(doc.spaceDoc), source: 'memory', reason: doc.sync.hasStorageFailure ? '本机保存失败，此份内容来自尚未关闭的页面' : doc.sync.reason });
  }
  const box = element('dialog'); box.className = 'drafts-dialog'; box.setAttribute('aria-label', '离线稿查看与人工合并');
  const notice = element('p'); notice.className = 'draft-notice'; notice.setAttribute('role', 'status');
  const select = element('select'); select.setAttribute('aria-label', '选择本机稿件');
  const descriptions = { draft: '保留稿', cache: '设备缓存', memory: '当前内存稿' };
  for (const row of records) {
    const option = element('option'); option.value = row.id;
    let title = '无法读取的稿件'; try { title = snapshotText(row.data).title; } catch {}
    const time = row.createdAt ? ' · ' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(row.createdAt) : '';
    option.textContent = `${descriptions[row.source]} · ${title}${time}${row.scope.epoch !== active.epoch ? ' · 恢复前内容' : ''}`;
    select.append(option);
  }
  const explanation = element('p', '两侧均为只读快照。可切换正文和画板查看完整内容；文字差异仅作比较辅助，不包含图形和格式。人工合并会把你确认的文字追加为新段落，原稿继续保留。');
  const controls = element('div'); controls.className = 'draft-controls';
  const panes = element('div'); panes.className = 'draft-panes';
  const differences = element('div'); differences.className = 'draft-differences';
  const mergeLabel = element('label', '文字合并区，可先修改再确认追加');
  const merge = element('textarea'); merge.rows = 4; merge.maxLength = 100_000; merge.setAttribute('aria-label', '文字合并区'); mergeLabel.append(merge);
  const actions = element('div'); actions.className = 'draft-controls';
  let previews: SnapshotDoc[] = [], mode: 'page' | 'edgeless' = 'page', draftOnly = '', selectedText = '';
  const act = (label: string, action: () => unknown) => {
    const value = element('button', label);
    value.onclick = () => { value.disabled = true; Promise.resolve().then(action).catch(error => { notice.textContent = error instanceof Error ? error.message : '操作未完成，请重试'; }).finally(() => { value.disabled = value === append && (!target || !canEdit(active.member.role) || target.sync.isBlocked || target.sync.hasStorageFailure); }); };
    return value;
  };
  const render = () => {
    panes.replaceChildren(); for (const preview of previews) preview.dispose(); previews = [];
    const row = records.find(row => row.id === select.value); if (!row) { notice.textContent = '此设备暂无可读取的稿件'; return; }
    const current = target ? { id: 'current', data: Y.encodeStateAsUpdate(target.spaceDoc), scope: target.sync.scope, source: 'memory' as const } : undefined;
    for (const [snapshot, title] of [[row, '本机稿件（只读）'], [current, '当前文档（只读快照）']] as const) {
      const pane = element('section'); pane.append(element('h3', title)); panes.append(pane);
      if (!snapshot) { pane.append(element('p', '请先打开要合入的文档')); continue; }
      const preview = new SnapshotDoc(active, snapshot), store = preview.getStore(); store.load(); previews.push(preview);
      const view = new EditorView();
      if (store.root) view.setContext(store, mode); else pane.append(element('p', '此稿件尚无完整正文，可导出保留'));
      view.addEventListener('mode-change', event => { mode = (event as CustomEvent<'page' | 'edgeless'>).detail; render(); });
      pane.append(view);
      if (snapshot === row) pane.addEventListener('pointerup', () => { selectedText = window.getSelection()?.toString() ?? ''; });
    }
    const diff = textDifference(snapshotText(row.data).text, current ? snapshotText(current.data).text : '');
    draftOnly = diff.draftOnly;
    differences.replaceChildren();
    for (const [title, text] of [['仅本机稿件包含的文字', diff.draftOnly], ['仅当前文档包含的文字', diff.currentOnly]]) {
      const part = element('section'); part.append(element('h3', title), element('pre', text || '无')); differences.append(part);
    }
    const reason = row.reason ? row.reason + '。' : '';
    notice.textContent = reason + (target?.sync.isBlocked ? '当前同步暂停，请先关闭本窗口，保留旧稿并读取云端，再人工合并。' : !canEdit(active.member.role) ? '当前为查看权限，可比较和导出。' : '合并目标：' + (target?.meta?.title || '尚未打开文档'));
    append.disabled = !target || !canEdit(active.member.role) || target.sync.isBlocked || target.sync.hasStorageFailure;
  };
  const append = act('确认追加到当前文档', async () => {
    if (!target) throw new Error('请先打开合并目标');
    await active.appendDraftText(target, merge.value);
    merge.value = ''; render(); notice.textContent = '已追加为新段落，原稿保留。请查看主界面的保存状态。';
  });
  controls.append(select, act('正文对照', () => { mode = 'page'; render(); }), act('画板对照', () => { mode = 'edgeless'; render(); }), act('刷新当前文档对照', render));
  actions.append(act('载入稿件独有文字', () => { merge.value = draftOnly; }), act('载入选中文字', () => { if (!selectedText) throw new Error('请先在左侧稿件选中文字'); merge.value = selectedText; }), append,
    act('导出此稿件', () => {
      const row = records.find(row => row.id === select.value); if (!row) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 1, drafts: [{ ...row, data: toBase64(row.data) }] })], { type: 'application/json' }));
      const link = element('a'); link.href = url; link.download = 'pageTogether-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }), act('关闭', () => box.close()));
  select.onchange = () => { selectedText = ''; merge.value = ''; render(); };
  box.append(element('h2', '离线稿查看与人工合并'), explanation, controls, notice, panes, differences, mergeLabel, actions);
  box.addEventListener('close', () => { box.remove(); for (const preview of previews) preview.dispose(); });
  document.body.append(box); box.showModal(); render();
  if (drafts.status === 'rejected' || documents.status === 'rejected') notice.textContent = '部分本机数据读取失败。当前页面内存稿仍可查看和导出，请保留页面。';
}
