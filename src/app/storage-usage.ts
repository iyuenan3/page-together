export type Usage = { usage: number; quota: number; ratio: number };
export function validStorageUsage(value: StorageEstimate): Usage | undefined {
  if (typeof value.usage !== 'number' || typeof value.quota !== 'number' || !Number.isFinite(value.usage) || !Number.isFinite(value.quota) || value.usage < 0 || value.quota <= 0) return;
  return { usage: value.usage, quota: value.quota, ratio: value.usage / value.quota };
}

export class StorageUsage {
  value?: Usage;
  failed = false;
  private stopped = false;
  private measuring?: Promise<void>;
  onChange = () => {};
  constructor(private readonly estimate: () => Promise<StorageEstimate>, private readonly timeout = 5000) {}
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.measuring) return this.measuring;
    let timer: ReturnType<typeof setTimeout>;
    this.measuring = Promise.race([
      Promise.resolve().then(this.estimate),
      new Promise<StorageEstimate>((_, reject) => { timer = setTimeout(() => reject(new Error('Storage estimate timed out')), this.timeout); }),
    ]).then(value => {
      const usage = validStorageUsage(value);
      if (!usage) throw new Error('Storage estimate unavailable');
      if (!this.stopped) { this.value = usage; this.failed = false; this.onChange(); }
    }).catch(() => {
      // Keep the last measured pressure when a later estimate cannot be read.
      if (!this.stopped) { this.failed = true; this.onChange(); }
    }).finally(() => { clearTimeout(timer!); this.measuring = undefined; });
    return this.measuring;
  }
  stop() { this.stopped = true; }
}

export function observeStorageUsage(target: HTMLElement) {
  const section = document.createElement('section'), status = document.createElement('p'), button = document.createElement('button');
  section.className = 'local-storage-usage'; status.setAttribute('role', 'status'); button.textContent = '刷新存储估算'; section.append(status, button); target.append(section);
  const usage = new StorageUsage(() => navigator.storage.estimate());
  const mb = (value: number) => (value / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  usage.onChange = () => {
    if (!section.isConnected) return;
    const value = usage.value;
    section.dataset.pressure = value && value.ratio >= 0.9 ? 'high' : 'normal';
    status.textContent = value ? `本站存储估算：${mb(value.usage)} / ${mb(value.quota)} MB，${Math.round(value.ratio * 100)}%。` : '浏览器未提供存储估算，实际保存状态以提示为准。';
    if (value && value.ratio >= 0.9) status.textContent += ' 接近配额，请保留页面并导出本机内容。保存失败后恢复可用空间，再明确重试保存。';
    if (usage.failed && value) status.textContent += ' 本次测量未完成，显示上次估算。';
  };
  button.onclick = () => void usage.refresh();
  const visible = () => { if (document.visibilityState === 'visible') void usage.refresh(); };
  const timer = setInterval(visible, 30_000); document.addEventListener('visibilitychange', visible);
  void usage.refresh();
  return { refresh: () => usage.refresh(), stop: () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); usage.stop(); section.remove(); } };
}
