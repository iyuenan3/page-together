type Reference = { type: string; docId?: string; blobId?: string; fileName?: string; url?: string };
type Actions = {
  baseURL: string;
  openDocument: (id: string) => void;
  readAttachment: (key: string) => Promise<Blob | null>;
  download: (name: string, data: Blob) => void;
  openURL: (url: string) => void;
};

export async function openFootnote(reference: Reference, actions: Actions) {
  if (reference.type === 'doc' && reference.docId) { actions.openDocument(reference.docId); return; }
  if (reference.type === 'attachment' && reference.blobId) {
    const data = await actions.readAttachment(reference.blobId);
    if (!data) throw new Error('脚注附件尚未缓存或无法读取，请联网后重试');
    actions.download(reference.fileName || '脚注附件', data); return;
  }
  if (reference.type === 'url' && reference.url) {
    let url: URL;
    try { url = new URL(reference.url, actions.baseURL); } catch { throw new Error('脚注链接无效，原内容保留'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('脚注链接仅支持 HTTP 或 HTTPS，原内容保留');
    actions.openURL(url.href); return;
  }
  throw new Error('脚注缺少可用目标，原内容保留');
}
