import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { canEdit, type ClientMessage, type DocumentScope, type Member, type Role, type ServerMessage } from '../shared/protocol.js';
import { ApiError, identifier, requireThat, text } from './errors.js';
import { hash, Store, type StoreOptions } from './store.js';

interface AppOptions extends StoreOptions {
  directory: string;
  origin: string;
  staticDirectory?: string;
  heartbeatMs?: number;
  maxConnections?: number;
}
interface Peer { sessionHash: string; member: Member; subscriptions: Map<string, DocumentScope>; alive: boolean; budget: number; reset: number }

export function createApp(options: AppOptions) {
  const store = new Store(options.directory, options);
  requireThat(Number.isSafeInteger(options.maxConnections ?? 40) && (options.maxConnections ?? 40) > 0, 400, 'invalid_configuration');
  const peers = new Map<WebSocket, Peer>();
  const downloads = new Map<ServerResponse, string>();
  const attempts = new Map<string, { count: number; until: number }>();
  const blobsDirectory = join(options.directory, 'blobs');
  mkdirSync(blobsDirectory, { recursive: true, mode: 0o700 });
  let uploads = 0;
  let origin = new URL(options.origin).origin;
  const isLocal = () => new URL(origin).protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname);
  requireThat(new URL(origin).protocol === 'https:' || isLocal(), 400, 'https_required');
  const cookieName = () => isLocal() ? 'pt_session' : '__Host-pt_session';
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.ceil(store.options.maxDocumentBytes * 4 / 3) + 4096, perMessageDeflate: false });

  function checkOrigin(req: IncomingMessage, required: boolean) {
    requireThat((!required && req.headers.origin === undefined) || req.headers.origin === origin, 403, 'invalid_origin');
    requireThat(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])), 403, 'invalid_origin');
  }
  function sessionHash(req: IncomingMessage) {
    const cookies = (req.headers.cookie ?? '').split(';').map(cookie => cookie.trim());
    const value = cookies.find(cookie => cookie.startsWith(cookieName() + '='))?.slice(cookieName().length + 1) ?? '';
    return hash(value);
  }
  function sessionCookie(session: string, clear = false) {
    return `${cookieName()}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : store.options.sessionDays * 86400}${isLocal() ? '' : '; Secure'}`;
  }
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function authRate(req: IncomingMessage) {
    const now = Date.now(), key = req.socket.remoteAddress ?? 'unknown';
    // Never trust forwarded addresses from arbitrary clients.
    for (const [address, entry] of attempts) if (entry.until <= now) attempts.delete(address);
    requireThat(attempts.size < 4096 || attempts.has(key), 429, 'rate_limited');
    const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    requireThat(++entry.count <= 20, 429, 'rate_limited');
    attempts.set(key, entry);
  }
  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'json_required');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      requireThat(size <= 16_384, 413, 'request_too_large');
      chunks.push(Buffer.from(chunk));
    }
    try {
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString());
      requireThat(result && typeof result === 'object' && !Array.isArray(result), 400, 'invalid_json');
      return result as Record<string, unknown>;
    } catch { throw new ApiError(400, 'invalid_json'); }
  }
  function encode(data: Uint8Array) { return Buffer.from(data).toString('base64'); }
  function decode(data: unknown, max: number): Buffer {
    const value = typeof data === 'string' ? data : '';
    requireThat(value.length <= Math.ceil(max / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 400, 'invalid_binary');
    const decoded = Buffer.from(value, 'base64');
    requireThat(decoded.length <= max && decoded.toString('base64') === value, 400, 'invalid_binary');
    return decoded;
  }
  function send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > store.options.maxDocumentBytes * 2) { ws.close(4408, 'slow_consumer'); return; }
    ws.send(JSON.stringify(message));
  }
  function validPeer(ws: WebSocket, peer: Peer): boolean {
    try {
      const current = store.authenticate(peer.sessionHash);
      if (current.accessRevision !== peer.member.accessRevision) throw new ApiError(403, 'access_changed');
      return true;
    } catch { ws.close(4403, 'access_changed'); return false; }
  }
  function recheckConnections() {
    for (const [ws, peer] of peers) {
      if (!validPeer(ws, peer)) continue;
      for (const scope of peer.subscriptions.values()) {
        try { store.authorizeDocument(peer.sessionHash, scope); }
        catch { ws.close(4409, 'document_changed'); break; }
      }
    }
    for (const [res, session] of downloads) {
      try { store.authenticate(session); } catch { res.destroy(); }
    }
  }
  function catalogChanged() {
    recheckConnections();
    for (const [ws, peer] of peers) if (validPeer(ws, peer)) send(ws, { v: 1, type: 'catalog' });
  }
  async function upload(req: IncomingMessage, res: ServerResponse, session: string, key: string) {
    requireThat(canEdit(store.authenticate(session).role), 403, 'read_only');
    requireThat(/^[A-Za-z0-9_-]{43}=$/.test(key), 400, 'invalid_blob_key');
    requireThat(uploads < 2, 429, 'uploads_busy');
    if (req.headers['content-length']) requireThat(Number(req.headers['content-length']) <= store.options.maxBlobBytes, 413, 'attachment_too_large');
    uploads++;
    const temporary = join(blobsDirectory, '.tmp-' + randomUUID());
    const destination = join(blobsDirectory, key);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let published = false, committed = false;
    try {
      file = await open(temporary, 'wx', 0o600);
      const digest = createHash('sha256');
      let size = 0;
      for await (const raw of req) {
        const chunk = Buffer.from(raw);
        size += chunk.byteLength;
        requireThat(size <= store.options.maxBlobBytes, 413, 'attachment_too_large');
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
      const bytes = digest.digest(), checksum = bytes.toString('hex');
      requireThat(bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_') === key, 400, 'blob_hash_mismatch');
      await file.sync();
      await file.close();
      file = undefined;
      // Recheck after all asynchronous file work, before publishing authority.
      requireThat(canEdit(store.authenticate(session).role), 403, 'read_only');
      try { linkSync(temporary, destination); published = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireThat(hash(readFileSync(destination)) === checksum, 409, 'blob_conflict');
      }
      const directory = openSync(blobsDirectory, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      store.commitBlob(session, key, size, checksum);
      committed = true;
      json(res, 200, { key, size, saved: true });
    } finally {
      uploads--;
      await file?.close();
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // A failed quota/SQL check must not consume unbounded disk space.
      // Never remove an existing file or one another request has indexed.
      if (published && !committed && store.db.open && !store.db.prepare('SELECT 1 FROM blobs WHERE key=?').get(key)) {
        try { unlinkSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url ?? '/', origin), path = url.pathname;
    if (!path.startsWith('/api/')) {
      requireThat(req.method === 'GET' && options.staticDirectory, 404, 'not_found');
      const root = resolve(options.staticDirectory);
      const relative = path === '/' ? 'index.html' : decodeURIComponent(path).slice(1);
      const file = resolve(root, relative);
      requireThat(file.startsWith(root + sep) && statSync(file, { throwIfNoEntry: false })?.isFile(), 404, 'not_found');
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain' };
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return;
    }
    checkOrigin(req, !['GET', 'HEAD'].includes(req.method ?? ''));
    if (req.method === 'POST' && ['/api/auth/invite', '/api/auth/recover'].includes(path)) {
      authRate(req);
      const data = await body(req);
      const result = path.endsWith('recover') ? store.recoverOwner(text(data.code)) : store.redeemInvite(text(data.token), text(data.nickname, 80));
      recheckConnections();
      res.setHeader('Set-Cookie', sessionCookie(result.session));
      const { session: _, ...publicResult } = result;
      json(res, 200, { ...publicResult, epoch: store.epoch, paused: store.paused });
      return;
    }
    const session = sessionHash(req), member = store.authenticate(session, true);
    if (req.method === 'GET' && path === '/api/session') { json(res, 200, { member, epoch: store.epoch, paused: store.paused }); return; }
    if (req.method === 'POST' && path === '/api/logout') {
      store.logout(session); recheckConnections(); res.setHeader('Set-Cookie', sessionCookie('', true)); json(res, 200, {}); return;
    }
    if (req.method === 'POST' && path === '/api/maintenance/resume') { store.resume(session); json(res, 200, {}); return; }
    if (req.method === 'GET' && path === '/api/members') { json(res, 200, store.members(session)); return; }
    if (req.method === 'POST' && path === '/api/invitations') {
      const data = await body(req);
      json(res, 201, store.invite(session, data.role as Role, data.memberId === undefined ? undefined : identifier(data.memberId), data.recovery === true)); return;
    }
    const invitation = path.match(/^\/api\/invitations\/([a-zA-Z0-9_-]+)$/);
    if (invitation && req.method === 'DELETE') { store.revokeInvite(session, invitation[1]); json(res, 200, {}); return; }
    const targetMember = path.match(/^\/api\/members\/([a-zA-Z0-9_-]+)$/);
    if (targetMember && req.method === 'PATCH') {
      const data = await body(req);
      requireThat(typeof data.active === 'boolean', 400, 'invalid_input');
      const target = store.changeMember(session, targetMember[1], data.role as Role, data.active);
      recheckConnections(); json(res, 200, target); return;
    }
    if (path === '/api/documents') {
      if (req.method === 'GET') { json(res, 200, store.listDocuments(session, url.searchParams.get('trash') === '1')); return; }
      if (req.method === 'POST') {
        const data = await body(req);
        const record = store.createDocument(session, identifier(data.id), text(data.title, 256));
        catalogChanged(); json(res, 201, record); return;
      }
    }
    const document = path.match(/^\/api\/documents\/([a-zA-Z0-9_-]+)(?:\/(trash|restore))?$/);
    if (document && req.method === 'POST' && document[2]) {
      store.lifecycle(session, document[1], document[2] === 'restore'); catalogChanged(); json(res, 200, {}); return;
    }
    if (path === '/api/blobs' && req.method === 'GET') { json(res, 200, store.listBlobs(session)); return; }
    const blob = path.match(/^\/api\/blobs\/([^/]+)$/);
    if (blob) {
      const key = decodeURIComponent(blob[1]);
      requireThat(/^[A-Za-z0-9_-]{43}=$/.test(key), 400, 'invalid_blob_key');
      if (req.method === 'PUT') { await upload(req, res, session, key); return; }
      if (req.method === 'GET') {
        const record = store.blob(session, key);
        requireThat(record, 404, 'blob_not_found');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'Content-Length': record.size, 'Cache-Control': 'no-store' });
        downloads.set(res, session);
        res.on('close', () => downloads.delete(res));
        createReadStream(join(blobsDirectory, key)).on('error', () => res.destroy()).pipe(res); return;
      }
    }
    throw new ApiError(404, 'not_found');
  }
  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const failure = error instanceof ApiError ? error : new ApiError(500, 'internal_error');
      json(res, failure.status, { code: failure.code });
      req.resume();
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.on('upgrade', (req, socket, head) => {
    try {
      requireThat(req.url === '/api/sync', 404, 'not_found');
      checkOrigin(req, true);
      requireThat(peers.size < (options.maxConnections ?? 40), 429, 'connections_busy');
      const session = sessionHash(req), member = store.authenticate(session);
      wss.handleUpgrade(req, socket, head, ws => {
        const peer: Peer = { sessionHash: session, member, subscriptions: new Map(), alive: true, budget: 60, reset: Date.now() + 1000 };
        peers.set(ws, peer);
        ws.on('error', () => ws.terminate());
        ws.on('close', () => peers.delete(ws));
        ws.on('pong', () => { peer.alive = true; });
        send(ws, { v: 1, type: 'ready', epoch: store.epoch, member });
        ws.on('message', (raw, binary) => {
          let requestId: string | undefined;
          try {
            requireThat(!binary, 400, 'json_required');
            if (Date.now() >= peer.reset) { peer.budget = 60; peer.reset = Date.now() + 1000; }
            requireThat(--peer.budget >= 0, 429, 'rate_limited');
            const message = JSON.parse(raw.toString()) as ClientMessage;
            requireThat(message && message.v === 1, 400, 'protocol_version');
            requestId = identifier(message.requestId);
            const scope: DocumentScope = { docId: identifier(message.docId), epoch: text(message.epoch), generation: message.generation };
            requireThat(Number.isSafeInteger(scope.generation) && scope.generation > 0, 400, 'invalid_generation');
            if (message.type === 'open') {
              const result = store.pull(session, scope, decode(message.stateVector, 65536));
              peer.subscriptions.set(scope.docId, scope);
              send(ws, { v: 1, type: 'sync', requestId, ...scope, update: encode(result.update), stateVector: encode(result.stateVector), revision: result.revision });
            } else if (message.type === 'push') {
              requireThat(peer.subscriptions.has(scope.docId), 409, 'open_required');
              const bytes = decode(message.update, store.options.maxDocumentBytes);
              const saved = store.push(session, scope, bytes);
              // No await between authorization, durable commit and receipt.
              send(ws, { v: 1, type: 'saved', requestId, ...scope, ...saved });
              for (const [other, otherPeer] of peers) {
                if (other === ws || !otherPeer.subscriptions.has(scope.docId) || !validPeer(other, otherPeer)) continue;
                try {
                  store.authorizeDocument(otherPeer.sessionHash, scope);
                  send(other, { v: 1, type: 'update', ...scope, update: message.update, revision: saved.revision });
                } catch { other.close(4403, 'access_changed'); }
              }
              if (saved.titleChanged) catalogChanged();
            } else throw new ApiError(400, 'invalid_message');
          } catch (error) {
            const failure = error instanceof ApiError ? error : error instanceof SyntaxError ? new ApiError(400, 'invalid_message') : new ApiError(500, 'storage_unavailable');
            send(ws, { v: 1, type: 'error', requestId, code: failure.code });
            if ([401, 403, 429, 503].includes(failure.status)) ws.close(4403, failure.code);
          }
        });
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  const heartbeat = setInterval(() => {
    recheckConnections();
    for (const [ws, peer] of peers) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!peer.alive) { ws.terminate(); continue; }
      peer.alive = false; ws.ping();
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  return {
    server, store,
    setOrigin(value: string) {
      const previous = origin;
      origin = new URL(value).origin;
      if (!(new URL(origin).protocol === 'https:' || isLocal())) { origin = previous; throw new ApiError(400, 'https_required'); }
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of peers.keys()) ws.terminate();
      for (const res of downloads.keys()) res.destroy();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
