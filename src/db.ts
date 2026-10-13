import { execFileSync } from 'node:child_process';
import { WINDOWS_POWERSHELL } from './permissions.ts';
import { DatabaseSync, backup } from 'node:sqlite';
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
export interface DbOptions { dbPath?: string; schemaPath?: string; authorizedSids?: readonly string[]; allowMigrations?: boolean; busyTimeoutMs?: number; readOnly?: boolean }

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
  if (options.readOnly) {
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      if(schemaVersion(db)!==SCHEMA_VERSION)throw new BridgeError('SCHEMA','Read-only MCP requires an existing current-schema database; no migration attempted');
      db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000};`);
      return db;
    }catch(error){db.close();throw error;}
  }
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

let ownProcessToken: string | undefined;
function processToken(pid: number): string | null {
  if(process.platform==='win32') {
    const script=`$ErrorActionPreference='Stop';$p=Get-Process | Where-Object Id -eq ${pid};if($p){[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)}`;
    const token=execFileSync(WINDOWS_POWERSHELL,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    return token || null;
  }
  try {const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
export function processOwner(): string { return ownProcessToken ??= `${process.pid}:${processToken(process.pid)}`; }
export function ownerAlive(owner: string | null): boolean | null {
  if(!owner)return null;
  const [pid,token]=owner.split(':');
  if(Number(pid)===process.pid)return owner===processOwner();
  try {return processToken(Number(pid))===token;}
  catch {return null;} // Unknown ownership is explicitly retained; never assumed dead.
}

/** SQLite online backup includes committed WAL pages. Never overwrite a file. */
export async function backupDatabase(sourcePath:string,destinationPath:string,authorizedSids:readonly string[]=[]):Promise<{pages:number}> {
  const source=resolve(sourcePath),destination=resolve(destinationPath);
  if(source===destination || existsSync(destination))throw new BridgeError('CONFLICT','Backup/restore destination must be a new file');
  const parent=dirname(destination);
  if([resolve(homedir()),resolve(tmpdir()),parse(destination).root].includes(parent) || (existsSync(parent)&&lstatSync(parent).isSymbolicLink()))throw new BridgeError('CONFIG','Backup requires a dedicated directory');
  mkdirSync(parent,{recursive:true,mode:0o700});protectPath(parent,authorizedSids);
  closeSync(openSync(destination,'wx',0o600));protectPath(destination,authorizedSids);
  const db=new DatabaseSync(source,{readOnly:true});
  try {const pages=await backup(db,destination);protectPath(destination,authorizedSids);return {pages};}
  finally{db.close();}
}
export async function restoreDatabase(backupPath:string,newPath:string,authorizedSids:readonly string[]=[]):Promise<{pages:number}> {
  // A fresh destination cannot replace an active ledger. The operator stops the
  // old worker and switches its config only after inspecting the restored copy.
  const source=new DatabaseSync(resolve(backupPath),{readOnly:true});
  try {if(source.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw new BridgeError('DB','Backup integrity check failed');}
  finally{source.close();}
  return backupDatabase(backupPath,newPath,authorizedSids);
}
