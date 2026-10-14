import { createApp } from '../server/app.js';
const directory = process.env.TEST_DATA_DIR;
if (!directory) throw new Error('TEST_DATA_DIR required');
const app = createApp({ directory, origin: 'http://127.0.0.1:0' });
if (process.env.TEST_CRASH_BLOB_COMMIT === '1') {
  app.store.db.function('crash_blob_commit', () => { process.kill(process.pid, 'SIGKILL'); });
  app.store.db.exec('CREATE TEMP TRIGGER crash_blob BEFORE INSERT ON blobs BEGIN SELECT crash_blob_commit(); END');
}
app.server.listen(0, '127.0.0.1', () => {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected address');
  const origin = `http://127.0.0.1:${address.port}`;
  app.setOrigin(origin); process.send?.({ origin });
});
process.on('SIGTERM', () => { app.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
