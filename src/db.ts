import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { protectPath } from './permissions.ts';

export const DEFAULT_DB_PATH = fileURLToPath(new URL('../data/bridge.db', import.meta.url));
export interface DbOptions { dbPath?: string; schemaPath?: string; authorizedSids?: readonly string[] }

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
    // Protect the directory before SQLite creates database/WAL/SHM files.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    protectPath(dirname(path), options.authorizedSids);
    if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
    protectPath(path, options.authorizedSids);
    for (const suffix of ['-wal','-shm']) if (existsSync(path + suffix)) protectPath(path + suffix, options.authorizedSids);
  }
  const db = new DatabaseSync(path);
  try {
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) > 1) throw new Error('Unsupported newer database schema');
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    const schema = readFileSync(options.schemaPath ?? fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
    transaction(db, () => {
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 1) throw new Error('Unsupported newer database schema');
      db.exec(schema);
      const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name));
      const additions: Record<string, string> = {
        version: 'INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0)', attempt: 'INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0)',
        claimed_instance: 'TEXT', attempt_executor: 'TEXT', attempt_instance: 'TEXT', created_by: 'TEXT', created_instance: 'TEXT',
      };
      for (const [column, definition] of Object.entries(additions)) {
        if (!columns.has(column)) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
      }
      // Preserve legacy business rows. Missing trusted ownership fails closed.
      db.exec('PRAGMA user_version=1');
    });
    return db;
  } catch (error) { db.close(); throw error; }
}
export function now(): string { return new Date().toISOString(); }
export function uuid(): string { return randomUUID(); }
