// Separate process keeps client allocations out of service resource measurements.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as Y from 'yjs';
import { createApp } from '../build/server/app.js';
import { backup, restore } from '../build/server/backup.js';
import { hash, Store } from '../build/server/store.js';

const directory = process.argv[2];
await mkdir(directory, { recursive: true, mode: 0o700 });
const app = createApp({ directory: join(directory, 'live'), origin: 'http://127.0.0.1:0' });
const first = app.store.initialize('capacity-owner');
const owner = app.store.recoverOwner(first.recoveryCode);
app.server.listen(0, '127.0.0.1');
await new Promise(resolve => app.server.once('listening', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`; app.setOrigin(origin);
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
let peakRss = 0;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }; sample();
const timer = setInterval(sample, 100);
process.send({ type: 'ready', origin, owner: 'pt_session=' + owner.session, epoch: app.store.epoch });
process.on('message', async message => {
  try {
    if (message.type === 'metrics') {
      sample(); process.send({ type: 'metrics', peakRss, peakRssMiB: peakRss / 1024 ** 2, loopP99Ms: loop.percentile(99) / 1e6, cpu: process.cpuUsage() });
    } else if (message.type === 'recover') {
      const started = performance.now(), before = app.store.listDocuments(hash(owner.session));
      const states = new Map(before.map(record => { const doc = app.store.hydrate(record.id); try { return [record.id, hash(Y.encodeStateAsUpdate(doc))]; } finally { doc.destroy(); } }));
      await backup(app.store, join(directory, 'backup'));
      const recovery = await restore(join(directory, 'backup'), join(directory, 'restored'));
      const restored = new Store(join(directory, 'restored'));
      try {
        const revisions = restored.db.prepare('SELECT id,revision FROM documents ORDER BY id').all();
        const valid = before.every(doc => revisions.some(row => row.id === doc.id && row.revision === doc.revision));
        if (!valid || !restored.paused || restored.epoch === app.store.epoch) throw new Error('restored state mismatch');
        for (const record of before) { const doc = restored.hydrate(record.id); try { if (hash(Y.encodeStateAsUpdate(doc)) !== states.get(record.id)) throw new Error('restored content mismatch'); } finally { doc.destroy(); } }
        await writeFile(join(directory, 'recovery.json'), JSON.stringify(recovery), { mode: 0o600 });
        process.send({ type: 'recover', durationMs: performance.now() - started, revisionsPreserved: true, contentPreserved: true, restoredBlobs: restored.db.prepare('SELECT count(*) AS count FROM blobs').get().count });
      } finally { restored.close(); }
    } else if (message.type === 'stop') {
      clearInterval(timer); loop.disable(); await app.close(); process.exit(0);
    }
  } catch (error) { process.send({ type: 'failure', message: error.message }); }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { clearInterval(timer); await app.close(); process.exit(); });
