import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createDb } from './db.ts';
const demos = new WeakSet<DatabaseSync>();
export function isDemoDatabase(db: DatabaseSync): boolean { return demos.has(db); }
export function isolatedDemo() {
  const root = mkdtempSync(join(tmpdir(), 'acb-demo-'));
  const db = createDb({ dbPath: join(root, 'demo.sqlite') }); demos.add(db);
  return { db, root, close: () => { demos.delete(db); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
