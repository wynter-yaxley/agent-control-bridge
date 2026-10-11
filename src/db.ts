import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, openSync, closeSync, lstatSync } from 'node:fs';
import { dirname, resolve, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { protectPath } from './permissions.ts';
import { migrateSchema, SCHEMA_VERSION, schemaVersion } from './migrations.ts';
import { BridgeError } from './errors.ts';
import { installReviewBoundary } from './review-boundary.ts';

export const DEFAULT_DB_PATH = fileURLToPath(new URL('../data/bridge.db', import.meta.url));
export interface DbOptions { dbPath?: string; schemaPath?: string; authorizedSids?: readonly string[]; allowMigrations?: boolean; busyTimeoutMs?: number }

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  const nested = db.isTransaction;
  const savepoint = `sp_${randomUUID().replaceAll('-', '')}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (nested) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
    else if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function createDb(options: DbOptions = {}): DatabaseSync {
  const path = options.dbPath === ':memory:' ? ':memory:' : resolve(options.dbPath ?? DEFAULT_DB_PATH);
  if (path !== ':memory:') {
    const parent=dirname(path);
    if([resolve(homedir()),resolve(tmpdir()),parse(path).root].includes(parent)||(existsSync(parent)&&lstatSync(parent).isSymbolicLink())) throw new BridgeError('CONFIG','Database requires a dedicated non-symlink data directory; refusing to change shared root permissions');
    // Protect the directory before SQLite creates database/WAL/SHM files.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    protectPath(dirname(path), options.authorizedSids);
    if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
    protectPath(path, options.authorizedSids);
    for (const suffix of ['-wal','-shm']) if (existsSync(path + suffix)) protectPath(path + suffix, options.authorizedSids);
  }
  const db = new DatabaseSync(path);
  try {
    const current = schemaVersion(db);
    if (current > SCHEMA_VERSION) throw new BridgeError('SCHEMA', 'Unsupported newer database schema');
    const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>String(row.name)));
    const hasTables = tableNames.has('tasks');
    if ((!hasTables && tableNames.size>0) || (current===SCHEMA_VERSION && ['projects','sessions','tasks','events','approvals','deliverables','audit_log','alerts','prompts','watcher_notifications','conversation_workspaces','codex_conversations','project_access','prompt_generation_ops','prompt_dispatches','background_requests','execution_runs','execution_events','notification_outbox','notification_delivery','project_operations'].some(name=>!tableNames.has(name)))) throw new BridgeError('SCHEMA','Database structure does not match the bridge schema; no upgrade attempted');
    if (hasTables && current < SCHEMA_VERSION && !options.allowMigrations) throw new BridgeError('SCHEMA', 'Schema upgrade required; back up and explicitly run migrate');
    const budget = options.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(budget) || budget < 0 || budget > 30000) throw new BridgeError('CONFIG', 'Invalid database busy timeout');
    db.exec(`PRAGMA busy_timeout=${budget}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;`);
    const schema = readFileSync(options.schemaPath ?? fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
    installReviewBoundary(db);
    if (current < SCHEMA_VERSION) transaction(db, () => migrateSchema(db, schema));
    return db;
  } catch (error) { db.close(); throw error; }
}
export function now(): string { return new Date().toISOString(); }
export function uuid(): string { return randomUUID(); }
