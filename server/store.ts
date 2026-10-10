import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import { canEdit, type DocumentInfo, type DocumentScope, type Member, type Role } from '../shared/protocol.js';
import { ApiError, identifier, requireThat, text } from './errors.js';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const day = 86_400_000;
interface SqlMember extends Omit<Member, 'owner' | 'active'> { owner: number; active: number }
interface SqlDocument extends Omit<DocumentInfo, 'deleted'> { deleted: number; snapshot: Buffer }
export interface StoreOptions {
  now?: () => number;
  invitationDays?: number;
  sessionDays?: number;
  maxDocumentBytes?: number;
  maxDocuments?: number;
  maxBlobBytes?: number;
  blobQuotaBytes?: number;
}

export class Store {
  readonly db: Database.Database;
  readonly now: () => number;
  readonly options: Required<Omit<StoreOptions, 'now'>>;

  constructor(readonly directory: string, options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.options = {
      invitationDays: options.invitationDays ?? 7,
      sessionDays: options.sessionDays ?? 30,
      maxDocumentBytes: options.maxDocumentBytes ?? 8 * 1024 * 1024,
      maxDocuments: options.maxDocuments ?? 256,
      maxBlobBytes: options.maxBlobBytes ?? 50_000_000,
      blobQuotaBytes: options.blobQuotaBytes ?? 2 * 1024 * 1024 * 1024,
    };
    for (const value of Object.values(this.options)) requireThat(Number.isSafeInteger(value) && value > 0, 400, 'invalid_configuration');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, 'space.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, nickname TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('manage','edit','view')),
        owner INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON members(owner) WHERE owner=1;
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL,
        issuer TEXT NOT NULL REFERENCES members(id), member_id TEXT REFERENCES members(id),
        recovery INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL, snapshot BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS updates (
        doc_id TEXT NOT NULL REFERENCES documents(id), revision INTEGER NOT NULL,
        data BLOB NOT NULL, PRIMARY KEY(doc_id, revision)
      );
      CREATE TABLE IF NOT EXISTS blobs (
        key TEXT PRIMARY KEY, size INTEGER NOT NULL, hash TEXT NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('epoch', randomUUID());
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('paused', '0');
  }

  private transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  setting(key: string) {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  get epoch() { return this.setting('epoch')!; }
  get paused() { return this.setting('paused') === '1'; }
  getMember(id: string): Member {
    const row = this.db.prepare('SELECT * FROM members WHERE id=?').get(id) as SqlMember | undefined;
    requireThat(row, 404, 'member_not_found');
    return { ...row, owner: !!row.owner, active: !!row.active };
  }
  initialize(nickname: string) {
    return this.transaction(() => {
      requireThat(!this.db.prepare('SELECT id FROM members LIMIT 1').get(), 409, 'already_initialized');
      const id = randomUUID(), recoveryCode = token();
      this.db.prepare('INSERT INTO members VALUES (?,?,?,1,1)').run(id, text(nickname, 80), 'manage');
      this.db.prepare('INSERT INTO settings VALUES (?,?)').run('recovery_hash', hash(recoveryCode));
      return { member: this.getMember(id), recoveryCode };
    });
  }
  authenticate(sessionHash: string, allowPaused = false): Member {
    const row = this.db.prepare('SELECT member_id FROM sessions WHERE hash=? AND expires>?').get(sessionHash, this.now()) as { member_id: string } | undefined;
    requireThat(row, 401, 'session_expired');
    const member = this.getMember(row.member_id);
    requireThat(member.active, 403, 'access_revoked');
    requireThat(!this.paused || (allowPaused && member.owner), 503, 'space_paused');
    return member;
  }
  private newSession(memberId: string) {
    const session = token();
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(session), memberId, this.now() + this.options.sessionDays * day);
    return { session, member: this.getMember(memberId) };
  }
  recoverOwner(code: string) {
    return this.transaction(() => {
      requireThat(typeof code === 'string' && hash(code) === this.setting('recovery_hash'), 401, 'invalid_recovery');
      const owner = this.db.prepare('SELECT id FROM members WHERE owner=1').get() as { id: string } | undefined;
      requireThat(owner, 401, 'invalid_recovery');
      const recoveryCode = token();
      this.db.prepare('UPDATE settings SET value=? WHERE key=?').run(hash(recoveryCode), 'recovery_hash');
      this.db.prepare('DELETE FROM sessions WHERE member_id=?').run(owner.id);
      this.db.prepare('UPDATE members SET active=1 WHERE id=?').run(owner.id);
      return { ...this.newSession(owner.id), recoveryCode };
    });
  }
  logout(sessionHash: string) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash); }
  invite(sessionHash: string, role: Role, memberId?: string, recovery = false) {
    return this.transaction(() => {
      const issuer = this.authenticate(sessionHash, true);
      requireThat(issuer.role === 'manage', 403, 'forbidden');
      requireThat(role === 'edit' || role === 'view', 400, 'invalid_role');
      if (memberId) {
        requireThat(issuer.owner, 403, 'owner_required');
        const target = this.getMember(memberId);
        requireThat(!target.owner, 403, 'owner_protected');
        role = target.role;
      }
      const invitation = token(), id = randomUUID(), expires = this.now() + this.options.invitationDays * day;
      this.db.prepare('INSERT INTO invitations VALUES (?,?,?,?,?,?,?)').run(id, hash(invitation), role, issuer.id, memberId ?? null, recovery ? 1 : 0, expires);
      return { id, token: invitation, expires };
    });
  }
  redeemInvite(invitation: string, nickname: string) {
    return this.transaction(() => {
      requireThat(!this.paused, 503, 'space_paused');
      const row = this.db.prepare('SELECT * FROM invitations WHERE hash=? AND expires>?').get(hash(text(invitation)), this.now()) as { id: string; issuer: string; role: Role; member_id: string | null; recovery: number } | undefined;
      requireThat(row, 401, 'invalid_invitation');
      const issuer = this.getMember(row.issuer);
      requireThat(issuer.active && issuer.role === 'manage', 401, 'invalid_invitation');
      const memberId = row.member_id ?? randomUUID();
      if (!row.member_id) {
        this.db.prepare('INSERT INTO members VALUES (?,?,?,0,1)').run(memberId, text(nickname, 80), row.role);
      } else {
        if (row.recovery) this.db.prepare('DELETE FROM sessions WHERE member_id=?').run(memberId);
        this.db.prepare('UPDATE members SET active=1 WHERE id=?').run(memberId);
      }
      this.db.prepare('DELETE FROM invitations WHERE id=?').run(row.id);
      return this.newSession(memberId);
    });
  }
  revokeInvite(sessionHash: string, id: string) {
    requireThat(this.authenticate(sessionHash, true).role === 'manage', 403, 'forbidden');
    this.db.prepare('DELETE FROM invitations WHERE id=?').run(id);
  }
  members(sessionHash: string) {
    this.authenticate(sessionHash, true);
    return (this.db.prepare('SELECT id FROM members').all() as { id: string }[]).map(row => this.getMember(row.id));
  }
  changeMember(sessionHash: string, id: string, role: Role, active: boolean) {
    return this.transaction(() => {
      const actor = this.authenticate(sessionHash, true), target = this.getMember(id);
      requireThat(actor.role === 'manage', 403, 'forbidden');
      requireThat(!target.owner, 403, 'owner_protected');
      requireThat(actor.owner || (target.role !== 'manage' && role !== 'manage'), 403, 'owner_required');
      requireThat(['manage', 'edit', 'view'].includes(role), 400, 'invalid_role');
      this.db.prepare('UPDATE members SET role=?, active=? WHERE id=?').run(role, active ? 1 : 0, id);
      this.db.prepare('DELETE FROM invitations WHERE member_id=? OR issuer=?').run(id, id);
      if (!active) this.db.prepare('DELETE FROM sessions WHERE member_id=?').run(id);
      return this.getMember(id);
    });
  }
  resume(sessionHash: string) {
    requireThat(this.authenticate(sessionHash, true).owner, 403, 'owner_required');
    this.db.prepare('UPDATE settings SET value=? WHERE key=?').run('0', 'paused');
  }
  listDocuments(sessionHash: string, trash = false): DocumentInfo[] {
    const member = this.authenticate(sessionHash);
    requireThat(!trash || member.role === 'manage', 403, 'forbidden');
    const rows = this.db.prepare('SELECT id,title,generation,revision,deleted,createdAt FROM documents WHERE deleted=? ORDER BY createdAt').all(trash ? 1 : 0) as Omit<SqlDocument, 'snapshot'>[];
    return rows.map(row => ({ ...row, deleted: !!row.deleted }));
  }
  createDocument(sessionHash: string, id: string, title: string): DocumentInfo {
    return this.transaction(() => {
      requireThat(canEdit(this.authenticate(sessionHash).role), 403, 'read_only');
      identifier(id);
      const previous = this.db.prepare('SELECT * FROM documents WHERE id=?').get(id) as SqlDocument | undefined;
      if (previous) {
        requireThat(!previous.deleted, 409, 'document_deleted');
        const { snapshot: _, ...record } = previous;
        return { ...record, deleted: false };
      }
      const count = (this.db.prepare('SELECT count(*) AS count FROM documents').get() as { count: number }).count;
      requireThat(count < this.options.maxDocuments, 413, 'document_quota');
      const empty = new Y.Doc();
      const snapshot = Buffer.from(Y.encodeStateAsUpdate(empty));
      empty.destroy();
      const createdAt = this.now();
      this.db.prepare('INSERT INTO documents(id,title,createdAt,snapshot) VALUES (?,?,?,?)').run(id, text(title, 256), createdAt, snapshot);
      return { id, title, createdAt, generation: 1, revision: 0, deleted: false };
    });
  }
  lifecycle(sessionHash: string, id: string, restore: boolean) {
    return this.transaction(() => {
      requireThat(this.authenticate(sessionHash).role === 'manage', 403, 'forbidden');
      const result = this.db.prepare('UPDATE documents SET deleted=?, generation=generation+1 WHERE id=? AND deleted=?').run(restore ? 0 : 1, id, restore ? 1 : 0);
      requireThat(result.changes, 409, 'lifecycle_conflict');
    });
  }
  authorizeDocument(sessionHash: string, scope: DocumentScope, write = false): DocumentInfo {
    const member = this.authenticate(sessionHash);
    requireThat(scope.epoch === this.epoch, 409, 'space_epoch_changed');
    requireThat(!write || canEdit(member.role), 403, 'read_only');
    const row = this.db.prepare('SELECT id,title,generation,revision,deleted,createdAt FROM documents WHERE id=?').get(scope.docId) as Omit<SqlDocument, 'snapshot'> | undefined;
    requireThat(row, 404, 'document_not_found');
    requireThat(!row.deleted, 409, 'document_deleted');
    requireThat(row.generation === scope.generation, 409, 'document_generation_changed');
    return { ...row, deleted: false };
  }
  private hydrate(id: string) {
    const doc = new Y.Doc({ guid: id });
    try {
      const row = this.db.prepare('SELECT snapshot FROM documents WHERE id=?').get(id) as { snapshot: Buffer };
      Y.applyUpdate(doc, row.snapshot);
      const updates = this.db.prepare('SELECT data FROM updates WHERE doc_id=? ORDER BY revision').all(id) as { data: Buffer }[];
      for (const update of updates) Y.applyUpdate(doc, update.data);
      return doc;
    } catch (error) { doc.destroy(); throw error; }
  }
  pull(sessionHash: string, scope: DocumentScope, vector: Uint8Array) {
    const record = this.authorizeDocument(sessionHash, scope);
    const doc = this.hydrate(scope.docId);
    try {
      return { update: Y.encodeStateAsUpdate(doc, vector), stateVector: Y.encodeStateVector(doc), revision: record.revision };
    } catch { throw new ApiError(400, 'invalid_state_vector'); }
    finally { doc.destroy(); }
  }
  push(sessionHash: string, scope: DocumentScope, update: Uint8Array) {
    return this.transaction(() => {
      const record = this.authorizeDocument(sessionHash, scope, true);
      requireThat(update.byteLength <= this.options.maxDocumentBytes, 413, 'update_too_large');
      const doc = this.hydrate(scope.docId);
      try {
        const before = Y.encodeStateAsUpdate(doc);
        try { Y.applyUpdate(doc, update); } catch { throw new ApiError(400, 'invalid_update'); }
        const after = Y.encodeStateAsUpdate(doc);
        requireThat(after.byteLength <= this.options.maxDocumentBytes, 413, 'document_too_large');
        const updateHash = hash(update);
        if (Buffer.from(before).equals(Buffer.from(after))) return { revision: record.revision, updateHash };
        const revision = record.revision + 1;
        let title = record.title;
        for (const block of doc.getMap<Y.Map<unknown>>('blocks').values()) {
          if (!(block instanceof Y.Map) || block.get('sys:flavour') !== 'affine:page') continue;
          const value = block.get('prop:title');
          if (value instanceof Y.Text) title = value.toString().slice(0, 256) || '无标题';
        }
        this.db.prepare('INSERT INTO updates VALUES (?,?,?)').run(scope.docId, revision, Buffer.from(update));
        this.db.prepare('UPDATE documents SET revision=?, title=? WHERE id=?').run(revision, title, scope.docId);
        const logBytes = (this.db.prepare('SELECT coalesce(sum(length(data)),0) AS size FROM updates WHERE doc_id=?').get(scope.docId) as { size: number }).size;
        if (revision % 32 === 0 || logBytes >= this.options.maxDocumentBytes * 2) {
          this.db.prepare('UPDATE documents SET snapshot=? WHERE id=?').run(Buffer.from(after), scope.docId);
          this.db.prepare('DELETE FROM updates WHERE doc_id=?').run(scope.docId);
        }
        return { revision, updateHash, titleChanged: title !== record.title };
      } finally { doc.destroy(); }
    });
  }
  blob(sessionHash: string, key: string) {
    this.authenticate(sessionHash);
    return this.db.prepare('SELECT * FROM blobs WHERE key=?').get(key) as { key: string; size: number; hash: string } | undefined;
  }
  listBlobs(sessionHash: string) {
    this.authenticate(sessionHash);
    return (this.db.prepare('SELECT key FROM blobs').all() as { key: string }[]).map(row => row.key);
  }
  commitBlob(sessionHash: string, key: string, size: number, digest: string) {
    return this.transaction(() => {
      requireThat(canEdit(this.authenticate(sessionHash).role), 403, 'read_only');
      const old = this.db.prepare('SELECT hash FROM blobs WHERE key=?').get(key) as { hash: string } | undefined;
      if (old) { requireThat(old.hash === digest, 409, 'blob_conflict'); return; }
      const total = (this.db.prepare('SELECT coalesce(sum(size),0) AS total FROM blobs').get() as { total: number }).total;
      requireThat(total + size <= this.options.blobQuotaBytes, 413, 'blob_quota');
      this.db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(key, size, digest);
    });
  }
  close() { this.db.close(); }
}
