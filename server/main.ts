import { resolve } from 'node:path';
import { createApp } from './app.js';

const origin = process.env.PAGETOGETHER_ORIGIN;
if (!origin) throw new Error('PAGETOGETHER_ORIGIN is required');
const app = createApp({
  origin,
  directory: resolve(process.env.PAGETOGETHER_DATA_DIR ?? 'data'),
  staticDirectory: resolve('dist'),
  invitationDays: Number(process.env.PAGETOGETHER_INVITATION_DAYS ?? 7),
  sessionDays: Number(process.env.PAGETOGETHER_SESSION_DAYS ?? 30),
  maxDocumentBytes: Number(process.env.PAGETOGETHER_MAX_DOCUMENT_BYTES ?? 8 * 1024 * 1024),
  maxDocuments: Number(process.env.PAGETOGETHER_MAX_DOCUMENTS ?? 256),
  maxBlobBytes: Number(process.env.PAGETOGETHER_MAX_BLOB_BYTES ?? 50_000_000),
  blobQuotaBytes: Number(process.env.PAGETOGETHER_BLOB_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024),
  maxConnections: Number(process.env.PAGETOGETHER_MAX_CONNECTIONS ?? 40),
});
const port = Number(process.env.PAGETOGETHER_PORT ?? 3000);
if (app.recovery.retained) console.warn('Attachment recovery originals are retained; inspect them with the offline recovery command.');
app.server.listen(port, '127.0.0.1', () => console.log('pageTogether service listening on loopback'));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  if (closing) return;
  closing = true;
  app.close().then(() => process.exit(0)).catch(() => process.exit(1));
});
