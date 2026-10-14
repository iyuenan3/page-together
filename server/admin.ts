import { resolve } from 'node:path';
import { backup, restore } from './backup.js';
import { Store } from './store.js';
import { exportRecoveredBlobs, lockData } from './blob-recovery.js';

const [command, value] = process.argv.slice(2);
const data = resolve(process.env.PAGETOGETHER_DATA_DIR ?? 'data');
if (command === 'restore' && value) {
  const result = await restore(resolve(value), data);
  // Deliberate local administrator output, never an application log.
  console.log(JSON.stringify(result));
} else {
  const release = command === 'recover-attachments' ? lockData(data) : undefined;
  const store = new Store(data);
  try {
    if (command === 'init' && value) console.log(JSON.stringify(store.initialize(value)));
    else if (command === 'backup' && value) { await backup(store, resolve(value)); console.log('Backup completed'); }
    else if (command === 'recover-attachments' && value) console.log(JSON.stringify(exportRecoveredBlobs(store, resolve(value))));
    else throw new Error('Usage: server:admin init <nickname> | backup <new-directory> | restore <backup-directory> | recover-attachments <new-directory>');
  } finally { store.close(); release?.(); }
}
