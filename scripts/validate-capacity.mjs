import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as Y from 'yjs';

// Fix these before running. Results never select the acceptance thresholds.
const plan = {
  members: 10, documentsPerMember: 4, paragraphs: 1000, charactersPerParagraph: 200,
  rounds: 30, intervalMs: 1000, concurrentUploads: 4, attachmentBytes: 50_000_000,
  thresholds: { initialSyncMs: 10_000, propagationP95Ms: 1000, propagationP99Ms: 2000,
    convergenceMs: 5000, servicePeakRssMiB: 512, serviceLoopP99Ms: 250, backupRestoreMs: 30_000 },
};
const directory = resolve('.local/verification/capacity-' + Date.now()); await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(resolve(directory, 'plan.json'), JSON.stringify(plan, null, 2));
const child = fork(new URL('./capacity-service.mjs', import.meta.url), [directory], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const messages = [], waiters = new Set();
child.on('message', message => { messages.push(message); for (const wake of waiters) wake(); });
const ipc = type => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Service deadline: ' + type)); }, 40_000);
  const check = () => { const index = messages.findIndex(message => message.type === type || message.type === 'failure'); if (index < 0) return;
    const [value] = messages.splice(index, 1); clearTimeout(timer); waiters.delete(check);
    value.type === 'failure' ? reject(new Error(value.message)) : resolve(value);
  }; waiters.add(check); check();
});
const peers = [], clients = [], errors = [], propagations = [], receipts = [], deliveries = new Map();
const encoded = bytes => Buffer.from(bytes).toString('base64');
const decoded = text => Buffer.from(text, 'base64');
const percentile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1];
let report;
try {
  const { origin, owner, epoch } = await ipc('ready');
  const request = (path, cookie = owner, method = 'GET', body) => fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const scopes = Array.from({ length: plan.documentsPerMember }, (_, index) => ({ docId: 'capacity-' + index, epoch, generation: 1 }));
  for (const scope of scopes) {
    assert.equal((await request('/api/documents', owner, 'POST', { id: scope.docId, title: scope.docId })).status, 201);
  }
  for (let index = 0; index < plan.members; index++) {
    const invitation = await (await request('/api/invitations', owner, 'POST', { role: 'edit' })).json();
    const response = await request('/api/auth/invite', '', 'POST', { token: invitation.token, nickname: 'capacity-' + index }); assert.equal(response.status, 200);
    clients.push({ cookie: response.headers.get('set-cookie').split(';')[0], member: (await response.json()).member, docs: new Map() });
  }
  class Peer {
    constructor(client, scope) {
      this.client = client; this.scope = scope; this.doc = new Y.Doc(); this.pending = new Map();
      this.ready = new Promise((resolve, reject) => { this.opened = resolve; this.failed = reject; });
      this.ws = new WebSocket(origin.replace('http', 'ws') + '/api/sync', { headers: { Origin: origin, Cookie: client.cookie } });
      this.ws.on('error', error => { errors.push(error.message); this.failed(error); });
      this.ws.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ready') this.send({ type: 'open', stateVector: encoded(Y.encodeStateVector(this.doc)) }, 'open');
        else if (message.type === 'sync') { Y.applyUpdate(this.doc, decoded(message.update)); this.opened(); }
        else if (message.type === 'saved') { const pending = this.pending.get(message.requestId); if (pending) { clearTimeout(pending.timer); receipts.push(performance.now() - pending.started); this.pending.delete(message.requestId); pending.resolve(message); } }
        else if (message.type === 'error') { if (this.expectRateLimit && message.code === 'rate_limited') this.rateLimitErrors = (this.rateLimitErrors ?? 0) + 1; else errors.push(message.code); this.pending.get(message.requestId)?.reject(new Error(message.code)); }
        else if (message.type === 'update') {
          Y.applyUpdate(this.doc, decoded(message.update));
          const delivery = deliveries.get(message.update);
          if (delivery && !delivery.seen.has(this.client.member.id)) { delivery.seen.add(this.client.member.id); propagations.push(performance.now() - delivery.started); }
        }
      });
    }
    send(message, requestId = randomUUID()) { this.ws.send(JSON.stringify({ v: 1, requestId, ...this.scope, ...message })); return requestId; }
    push(update, measured = false) {
      const value = encoded(update), requestId = randomUUID(), started = performance.now();
      if (measured) deliveries.set(value, { started, seen: new Set([this.client.member.id]) });
      const response = new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Saved receipt deadline')); }, 10_000); this.pending.set(requestId, { resolve, reject, started, timer }); });
      this.send({ type: 'push', update: value }, requestId); return response;
    }
  }
  const initialStarted = performance.now();
  for (const client of clients) for (const scope of scopes) { const peer = new Peer(client, scope); peers.push(peer); client.docs.set(scope.docId, peer); }
  await Promise.race([Promise.all(peers.map(peer => peer.ready)), delay(plan.thresholds.initialSyncMs).then(() => { throw new Error('Initial sync deadline'); })]);
  const first = peers[0], blocks = first.doc.getMap('blocks');
  const block = (id, flavour, props, children = []) => { const value = new Y.Map(); blocks.set(id, value); value.set('sys:id', id); value.set('sys:flavour', flavour); value.set('sys:version', 1); value.set('sys:children', Y.Array.from(children)); for (const [key, prop] of Object.entries(props)) value.set('prop:' + key, prop); return value; };
  first.doc.transact(() => {
    block('page', 'affine:page', { title: new Y.Text('Capacity baseline') }, ['surface', 'note']);
    block('surface', 'affine:surface', {});
    block('note', 'affine:note', { xywh: '[0,0,800,600]', background: '--affine-background-secondary-color', displayMode: 'both' }, Array.from({ length: plan.paragraphs }, (_, index) => 'p' + index));
    for (let index = 0; index < plan.paragraphs; index++) block('p' + index, 'affine:paragraph', { type: 'text', text: new Y.Text('文'.repeat(plan.charactersPerParagraph)) });
  });
  const seed = Y.encodeStateAsUpdate(first.doc); await first.push(seed);
  while (clients.some(client => client.docs.get(scopes[0].docId).doc.getMap('blocks').size !== blocks.size)) { assert(performance.now() - initialStarted < plan.thresholds.initialSyncMs); await delay(10); }
  const initialSyncMs = performance.now() - initialStarted;
  const overflowStatus = await new Promise((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/api/sync', { headers: { Origin: origin, Cookie: clients[0].cookie } });
    ws.on('open', () => { ws.terminate(); reject(new Error('Connection limit was bypassed')); });
    ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); ws.terminate(); });
    ws.on('error', () => {});
  }); assert.equal(overflowStatus, 429);
  const upload = async (index, size = plan.attachmentBytes) => {
    const prefix = Buffer.from('pageTogether-capacity-' + index), chunk = Buffer.alloc(64 * 1024, index), hash = createHash('sha256');
    hash.update(prefix); let remaining = size - prefix.length; while (remaining) { const bytes = chunk.subarray(0, Math.min(remaining, chunk.length)); hash.update(bytes); remaining -= bytes.length; }
    const digest = hash.digest(), key = digest.toString('base64url') + '=';
    const client = clients[index % clients.length], started = performance.now();
    for (let attempt = 0; attempt < 10; attempt++) {
      let position = 0;
      const body = new ReadableStream({ async pull(controller) {
        if (position >= size) { controller.close(); return; }
        const bytes = position === 0 ? prefix : chunk.subarray(0, Math.min(size - position, chunk.length)); position += bytes.length; controller.enqueue(bytes); await delay(1);
      } });
      const response = await fetch(origin + '/api/blobs/' + encodeURIComponent(key), { method: 'PUT', duplex: 'half', body,
        headers: { Origin: origin, Cookie: client.cookie, 'Content-Length': String(size), 'X-PageTogether-Upload': JSON.stringify({ ...scopes[0], memberId: client.member.id, accessRevision: client.member.accessRevision }) }, signal: AbortSignal.timeout(30_000) });
      const value = await response.json();
      if (response.status !== 429 || value.code !== 'uploads_busy') return { status: response.status, value, key, busyRetries: attempt, durationMs: performance.now() - started, digest: digest.toString('hex') };
      await delay(Math.min(200 * 2 ** attempt, 3000));
    }
    throw new Error('Upload retry budget exhausted');
  };
  console.log('Capacity plan fixed; 10 identities, 40 document connections, 1000 paragraphs, 30 edit rounds.');
  const uploadPromise = Promise.all(Array.from({ length: plan.concurrentUploads }, (_, index) => upload(index)));
  const abusive = clients[0].docs.get(scopes[3].docId); abusive.expectRateLimit = true;
  for (let index = 0; index < 100; index++) abusive.send({ type: 'open', stateVector: encoded(Y.encodeStateVector(abusive.doc)) });
  for (let round = 0; round < plan.rounds; round++) {
    const start = performance.now();
    await Promise.all(clients.map((client, index) => {
      const peer = client.docs.get(scopes[0].docId), vector = Y.encodeStateVector(peer.doc);
      peer.doc.transact(() => { const text = peer.doc.getMap('blocks').get('p' + index).get('prop:text'); text.insert(text.length, ` [${index}:${round}]`); });
      return peer.push(Y.encodeStateAsUpdate(peer.doc, vector), true);
    }));
    if ((round + 1) % 10 === 0) console.log(`Saved ${round + 1} / ${plan.rounds} rounds`);
    await delay(Math.max(0, plan.intervalMs - (performance.now() - start)));
  }
  const uploads = await uploadPromise; for (const upload of uploads) { assert.equal(upload.status, 200); assert.equal(upload.value.size, plan.attachmentBytes); assert.equal(upload.value.saved, true); }
  const convergenceStarted = performance.now();
  const expected = clients[0].docs.get(scopes[0].docId).doc.getMap('blocks').toJSON();
  while (clients.some(client => JSON.stringify(client.docs.get(scopes[0].docId).doc.getMap('blocks').toJSON()) !== JSON.stringify(expected))) { assert(performance.now() - convergenceStarted < plan.thresholds.convergenceMs); await delay(10); }
  assert.equal(propagations.length, plan.rounds * plan.members * (plan.members - 1));
  assert(abusive.rateLimitErrors > 0);
  const convergenceMs = performance.now() - convergenceStarted;
  const downloadStarted = performance.now();
  await Promise.all(clients.map(async client => { const response = await fetch(origin + '/api/blobs/' + encodeURIComponent(uploads[0].key), { headers: { Cookie: client.cookie }, signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200);
    let size = 0; const digest = createHash('sha256'); for await (const chunk of response.body) { size += chunk.length; digest.update(chunk); }
    assert.equal(size, plan.attachmentBytes); assert.equal(digest.digest('hex'), uploads[0].digest);
  }));
  const downloadMs = performance.now() - downloadStarted;
  assert.equal((await upload(8, plan.attachmentBytes + 1)).status, 413);
  child.send({ type: 'recover' }); const recovery = await ipc('recover');
  child.send({ type: 'metrics' }); const metrics = await ipc('metrics');
  assert.equal(recovery.restoredBlobs, plan.concurrentUploads); assert.equal(recovery.revisionsPreserved, true);
  report = { plan, initialSyncMs, primaryDocumentBytes: seed.byteLength, edits: plan.rounds * plan.members,
    deliveries: propagations.length, propagationP95Ms: percentile(propagations, .95), propagationP99Ms: percentile(propagations, .99),
    savedP95Ms: percentile(receipts, .95), convergenceMs, overflowStatus, rateLimitErrors: abusive.rateLimitErrors,
    uploadMs: uploads.map(value => value.durationMs), uploadBusyRetries: uploads.map(value => value.busyRetries), tenDownloadsMs: downloadMs, metrics, recovery, unexpectedErrors: errors };
  assert.equal(errors.length, 0); assert(initialSyncMs <= plan.thresholds.initialSyncMs);
  assert(report.propagationP95Ms <= plan.thresholds.propagationP95Ms); assert(report.propagationP99Ms <= plan.thresholds.propagationP99Ms);
  assert(metrics.peakRssMiB <= plan.thresholds.servicePeakRssMiB); assert(metrics.loopP99Ms <= plan.thresholds.serviceLoopP99Ms);
  assert(recovery.durationMs <= plan.thresholds.backupRestoreMs);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (report) await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  for (const peer of peers) { peer.ws.terminate(); peer.doc.destroy(); }
  if (child.connected) child.send({ type: 'stop' });
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000).then(() => { if (child.exitCode === null) child.kill('SIGTERM'); })]);
}
