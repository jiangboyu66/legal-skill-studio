import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  AuditEvent,
  Conversation,
  EvalRun,
  MaterialDocument,
  OptimizationRun,
  Org,
  ReviewRequest,
  RulePack,
  RulePackContent,
  Run,
  Skill,
  SkillConfig,
  User,
  Workflow,
  WorkflowDef,
} from '../../../shared/types';
import { DataCipher, keyMissingError } from './crypto';

// node:sqlite is loaded through require so bundlers/test runners don't try to resolve it.
const require = createRequire(import.meta.url);
type Statement = { run: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };
let DatabaseSync: new (file: string) => Database;
{
  const original = process.emitWarning;
  // Silence the one-time "SQLite is experimental" warning; everything else passes through.
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String((w as Error)?.message ?? w).includes('SQLite')) return;
    return (original as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  ({ DatabaseSync } = require('node:sqlite'));
  process.emitWarning = original;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, updated_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, updated_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS rulepacks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, updated_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS versions (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id, version));
   CREATE TABLE IF NOT EXISTS review_requests (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, entity_type TEXT, entity_id TEXT, status TEXT, created_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, created_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT, status TEXT, started_by TEXT, created_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, at TEXT, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_runs_org ON runs(org_id, created_at);
   CREATE INDEX IF NOT EXISTS idx_audit_org ON audit(org_id, at);
   CREATE INDEX IF NOT EXISTS idx_reviews_org ON review_requests(org_id, status);`,
  // v3: evaluation runs and optimisation candidates
  `CREATE TABLE IF NOT EXISTS evals (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, skill_id TEXT, created_at TEXT, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS optimizations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, skill_id TEXT, created_at TEXT, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_evals_skill ON evals(org_id, skill_id, created_at);
   CREATE INDEX IF NOT EXISTS idx_opt_skill ON optimizations(org_id, skill_id, created_at);
   CREATE INDEX IF NOT EXISTS idx_docs_created ON documents(created_at);`,
  // v3.2: chat conversations (private per user; encrypted like runs)
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, updated_at TEXT, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(org_id, user_id, updated_at);`,
];

/** Encodes the JSON payload column; tables holding materials or outputs are encrypted when a key is set. */
export interface Codec {
  encode(json: string): string;
  decode(stored: string): string;
}

const PLAIN: Codec = { encode: (s) => s, decode: (s) => s };

function cipherCodec(cipher?: DataCipher): Codec {
  return {
    encode: (s) => (cipher ? cipher.encryptString(s) : s),
    decode: (s) => {
      if (!DataCipher.isEncryptedString(s)) return s;
      if (!cipher) throw keyMissingError();
      return cipher.decryptString(s);
    },
  };
}

const parse = <T>(row: unknown, codec: Codec = PLAIN): T | undefined => (row ? (JSON.parse(codec.decode((row as { data: string }).data)) as T) : undefined);

/** Org-scoped JSON document table (indexed columns + JSON payload). */
class EntityTable<T extends { id: string; orgId: string }> {
  constructor(
    private db: Database,
    private table: string,
    private extra: (e: T) => Record<string, unknown> = () => ({}),
    readonly codec: Codec = PLAIN,
  ) {}
  get(orgId: string, id: string): T | undefined {
    return parse<T>(this.db.prepare(`SELECT data FROM ${this.table} WHERE id = ? AND org_id = ?`).get(id, orgId), this.codec);
  }
  list(orgId: string): T[] {
    return this.db
      .prepare(`SELECT data FROM ${this.table} WHERE org_id = ?`)
      .all(orgId)
      .map((r) => parse<T>(r, this.codec)!);
  }
  put(e: T): T {
    const cols = { id: e.id, org_id: e.orgId, ...this.extra(e), data: this.codec.encode(JSON.stringify(e)) };
    const keys = Object.keys(cols);
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(cols));
    return e;
  }
  delete(orgId: string, id: string): boolean {
    const before = this.get(orgId, id);
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ? AND org_id = ?`).run(id, orgId);
    return !!before;
  }
}

/**
 * Storage service: SQLite (built-in node:sqlite) with org-scoped repositories.
 * The same interface can be re-implemented on Postgres for production.
 */
export class Db {
  private db: Database;
  orgs: { get: (id: string) => Org | undefined; put: (o: Org) => Org; list: () => Org[] };
  skills: EntityTable<Skill>;
  workflows: EntityTable<Workflow>;
  rulePacks: EntityTable<RulePack>;
  reviews: EntityTable<ReviewRequest>;
  documents: EntityTable<MaterialDocument>;
  runs: EntityTable<Run>;
  evals: EntityTable<EvalRun>;
  optimizations: EntityTable<OptimizationRun>;
  conversations: EntityTable<Conversation>;
  readonly filesDir: string;
  /** Set when DATA_ENCRYPTION_KEY is configured: documents, runs, evals and stored files are encrypted. */
  readonly cipher?: DataCipher;
  private secret: Codec;

  constructor(dataDir: string, opts: { cipher?: DataCipher } = {}) {
    this.cipher = opts.cipher;
    this.secret = cipherCodec(opts.cipher);
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.filesDir = path.join(dataDir, 'files');
    if (!existsSync(this.filesDir)) mkdirSync(this.filesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'app.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    const current = Number((this.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() as { value?: string })?.value ?? 0);
    MIGRATIONS.slice(current).forEach((sql, i) => {
      this.tx(() => {
        this.db.exec(sql);
        this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).run(String(current + i + 1));
      });
    });

    const db = this.db;
    this.orgs = {
      get: (id) => parse<Org>(db.prepare('SELECT data FROM orgs WHERE id = ?').get(id)),
      put: (o) => (db.prepare('INSERT OR REPLACE INTO orgs (id, data) VALUES (?, ?)').run(o.id, JSON.stringify(o)), o),
      list: () => db.prepare('SELECT data FROM orgs').all().map((r) => parse<Org>(r)!),
    };
    this.skills = new EntityTable<Skill>(db, 'skills', (s) => ({ updated_at: s.updatedAt }));
    this.workflows = new EntityTable<Workflow>(db, 'workflows', (w) => ({ updated_at: w.updatedAt }));
    this.rulePacks = new EntityTable<RulePack>(db, 'rulepacks', (r) => ({ updated_at: r.updatedAt }));
    this.reviews = new EntityTable<ReviewRequest>(db, 'review_requests', (r) => ({
      entity_type: r.entityType,
      entity_id: r.entityId,
      status: r.status,
      created_at: r.createdAt,
    }));
    this.documents = new EntityTable<MaterialDocument>(db, 'documents', (d) => ({ created_at: d.createdAt }), this.secret);
    this.runs = new EntityTable<Run>(
      db,
      'runs',
      (r) => ({
        workflow_id: r.workflowId,
        status: r.status,
        started_by: r.startedBy,
        created_at: r.createdAt,
      }),
      this.secret,
    );
    this.evals = new EntityTable<EvalRun>(db, 'evals', (e) => ({ skill_id: e.skillId, created_at: e.createdAt }), this.secret);
    this.optimizations = new EntityTable<OptimizationRun>(db, 'optimizations', (o) => ({ skill_id: o.skillId, created_at: o.createdAt }), this.secret);
    this.conversations = new EntityTable<Conversation>(db, 'conversations', (c) => ({ user_id: c.userId, updated_at: c.updatedAt }), this.secret);
  }

  /** A user's conversations, most recent first. */
  listConversations(orgId: string, userId: string, limit = 100): Conversation[] {
    return this.db
      .prepare(`SELECT data FROM conversations WHERE org_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}`)
      .all(orgId, userId)
      .map((r) => parse<Conversation>(r, this.secret)!);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  isEmpty(): boolean {
    return !(this.db.prepare('SELECT 1 FROM orgs LIMIT 1').get() as unknown);
  }

  // ---------- users & sessions ----------
  getUser(id: string): User | undefined {
    return parse<User>(this.db.prepare('SELECT data FROM users WHERE id = ?').get(id));
  }
  getUserByEmail(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db.prepare('SELECT data, password_hash FROM users WHERE email = ?').get(email.toLowerCase()) as
      | { data: string; password_hash: string }
      | undefined;
    return row ? { ...(JSON.parse(row.data) as User), passwordHash: row.password_hash } : undefined;
  }
  listUsers(orgId: string): User[] {
    return this.db.prepare('SELECT data FROM users WHERE org_id = ?').all(orgId).map((r) => parse<User>(r)!);
  }
  putUser(u: User, passwordHash?: string): User {
    const existing = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id) as { password_hash: string } | undefined;
    const hash = passwordHash ?? existing?.password_hash;
    if (!hash) throw new Error('password hash required for new user');
    this.db
      .prepare('INSERT OR REPLACE INTO users (id, org_id, email, password_hash, data) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, u.orgId, u.email.toLowerCase(), hash, JSON.stringify(u));
    return u;
  }
  createSession(tokenHash: string, userId: string, expiresAt: number) {
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  }
  getSession(tokenHash: string): { userId: string; expiresAt: number } | undefined {
    const r = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { user_id: string; expires_at: number }
      | undefined;
    return r ? { userId: r.user_id, expiresAt: r.expires_at } : undefined;
  }
  deleteSession(tokenHash: string) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }
  deleteUserSessions(userId: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // ---------- immutable version snapshots ----------
  putVersion(type: 'skill' | 'workflow' | 'rulepack', id: string, version: number, data: SkillConfig | WorkflowDef | RulePackContent) {
    this.db.prepare('INSERT OR REPLACE INTO versions (entity_type, entity_id, version, data) VALUES (?, ?, ?, ?)').run(type, id, version, JSON.stringify(data));
  }
  getVersion<T>(type: 'skill' | 'workflow' | 'rulepack', id: string, version: number): T | undefined {
    return parse<T>(this.db.prepare('SELECT data FROM versions WHERE entity_type = ? AND entity_id = ? AND version = ?').get(type, id, version));
  }

  // ---------- runs & audit ----------
  listRuns(orgId: string, opts: { workflowId?: string; startedBy?: string; limit?: number } = {}): Run[] {
    const where = ['org_id = ?'];
    const args: unknown[] = [orgId];
    if (opts.workflowId) (where.push('workflow_id = ?'), args.push(opts.workflowId));
    if (opts.startedBy) (where.push('started_by = ?'), args.push(opts.startedBy));
    return this.db
      .prepare(`SELECT data FROM runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${opts.limit ?? 200}`)
      .all(...args)
      .map((r) => parse<Run>(r, this.secret)!);
  }
  runsByStatus(status: string[]): Run[] {
    return this.db
      .prepare(`SELECT data FROM runs WHERE status IN (${status.map(() => '?').join(',')})`)
      .all(...status)
      .map((r) => parse<Run>(r, this.secret)!);
  }
  listEvals(orgId: string, skillId: string, limit = 20): EvalRun[] {
    return this.db
      .prepare(`SELECT data FROM evals WHERE org_id = ? AND skill_id = ? ORDER BY created_at DESC LIMIT ${limit}`)
      .all(orgId, skillId)
      .map((r) => parse<EvalRun>(r, this.secret)!);
  }
  listOptimizations(orgId: string, skillId: string, limit = 20): OptimizationRun[] {
    return this.db
      .prepare(`SELECT data FROM optimizations WHERE org_id = ? AND skill_id = ? ORDER BY created_at DESC LIMIT ${limit}`)
      .all(orgId, skillId)
      .map((r) => parse<OptimizationRun>(r, this.secret)!);
  }

  // ---------- data protection ----------
  /** Counts encrypted rows and checks that the configured key can read them (startup self-check). */
  encryptionProbe(): { encryptedRows: number; plainRows: number; readable: boolean; error?: string } {
    let encryptedRows = 0;
    let plainRows = 0;
    let sample: string | undefined;
    for (const t of ['documents', 'runs', 'evals', 'conversations']) {
      const r = this.db.prepare(`SELECT SUM(CASE WHEN data LIKE 'enc:v1:%' THEN 1 ELSE 0 END) AS e, SUM(CASE WHEN data LIKE 'enc:v1:%' THEN 0 ELSE 1 END) AS p FROM ${t}`).get() as { e: number | null; p: number | null };
      encryptedRows += r.e ?? 0;
      plainRows += r.p ?? 0;
      if (!sample && (r.e ?? 0) > 0) sample = (this.db.prepare(`SELECT data FROM ${t} WHERE data LIKE 'enc:v1:%' LIMIT 1`).get() as { data: string }).data;
    }
    if (!sample) return { encryptedRows, plainRows, readable: true };
    try {
      this.secret.decode(sample);
      return { encryptedRows, plainRows, readable: true };
    } catch (e) {
      return { encryptedRows, plainRows, readable: false, error: (e as Error).message };
    }
  }

  /**
   * Retention: deletes finished runs, evaluation records and documents created before `cutoffIso`.
   * Documents still referenced by a remaining run are kept. Returns what was removed (ids per org).
   */
  purgeBefore(cutoffIso: string): { runs: { id: string; orgId: string }[]; documents: { id: string; orgId: string }[]; evals: number } {
    const terminal = ['succeeded', 'failed', 'rejected', 'canceled'];
    const runs = this.db
      .prepare(`SELECT id, org_id FROM runs WHERE created_at < ? AND status IN (${terminal.map(() => '?').join(',')})`)
      .all(cutoffIso, ...terminal)
      .map((r) => ({ id: (r as { id: string }).id, orgId: (r as { org_id: string }).org_id }));
    const docs: { id: string; orgId: string }[] = [];
    let evals = 0;
    this.tx(() => {
      for (const r of runs) this.db.prepare('DELETE FROM runs WHERE id = ?').run(r.id);
      evals = Number((this.db.prepare('SELECT COUNT(*) AS n FROM evals WHERE created_at < ?').get(cutoffIso) as { n: number }).n);
      this.db.prepare('DELETE FROM evals WHERE created_at < ?').run(cutoffIso);
      this.db.prepare('DELETE FROM optimizations WHERE created_at < ?').run(cutoffIso);
      this.db.prepare('DELETE FROM conversations WHERE updated_at < ?').run(cutoffIso);
      const referenced = new Set<string>();
      for (const row of this.db.prepare('SELECT data FROM runs').all()) for (const id of Object.values(parse<Run>(row, this.secret)!.documents ?? {})) referenced.add(id);
      for (const row of this.db.prepare('SELECT id, org_id FROM documents WHERE created_at < ?').all(cutoffIso) as { id: string; org_id: string }[]) {
        if (referenced.has(row.id)) continue;
        this.db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
        docs.push({ id: row.id, orgId: row.org_id });
      }
    });
    return { runs, documents: docs, evals };
  }
  addAudit(e: AuditEvent) {
    this.db.prepare('INSERT INTO audit (id, org_id, at, data) VALUES (?, ?, ?, ?)').run(e.id, e.orgId, e.at, JSON.stringify(e));
  }
  listAudit(orgId: string, limit = 300): AuditEvent[] {
    return this.db
      .prepare(`SELECT data FROM audit WHERE org_id = ? ORDER BY at DESC LIMIT ${limit}`)
      .all(orgId)
      .map((r) => parse<AuditEvent>(r)!);
  }

  close() {
    this.db.close();
  }
}
