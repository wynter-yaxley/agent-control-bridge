import type { DatabaseSync } from 'node:sqlite';
import { BridgeError } from './errors.ts';
export const SCHEMA_VERSION = 2;
export function schemaVersion(db: DatabaseSync): number { return Number(db.prepare('PRAGMA user_version').get()!.user_version); }
export function migrateSchema(db: DatabaseSync, schema: string): void {
  let version = schemaVersion(db);
  if (version > SCHEMA_VERSION) throw new BridgeError('SCHEMA', 'Unsupported newer database schema');
  if (version === 0) {
    db.exec(schema);
    const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name));
    const additions: Record<string, string> = { version: 'INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0)', attempt: 'INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0)', claimed_instance: 'TEXT', attempt_executor: 'TEXT', attempt_instance: 'TEXT', created_by: 'TEXT', created_instance: 'TEXT' };
    for (const [name, type] of Object.entries(additions)) if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    db.exec('PRAGMA user_version=1'); version = 1;
  }
  if (version === 1) {
    const checks: Record<string, string> = {
      projects: "id IS NULL OR id=''", sessions: "id IS NULL OR id='' OR source NOT IN ('codex','chatgpt','pi','manual')",
      tasks: "id IS NULL OR id='' OR status NOT IN ('QUEUED','RUNNING','WAITING_APPROVAL','BLOCKED','SUCCEEDED','FAILED','CANCELLED','UNKNOWN') OR (executor IS NOT NULL AND executor NOT IN ('codex','pi','chatgpt','hermes')) OR typeof(priority)!='integer'",
      approvals: "id IS NULL OR id='' OR decision NOT IN ('pending','approved','rejected')", deliverables: "id IS NULL OR id=''",
      alerts: "id IS NULL OR id='' OR severity NOT IN ('info','warn','error') OR (task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks WHERE tasks.id=alerts.task_id))",
    };
    for (const [table, predicate] of Object.entries(checks)) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`).get()) throw new BridgeError('SCHEMA', `Legacy ${table} violates constraints; manual review required, no data deleted`);
      for (const operation of ['INSERT', 'UPDATE']) {
        // Fixed allowlisted SQL definitions, never untrusted input.
        const expression = predicate.replace(/\b(id|source|status|executor|priority|decision|severity|task_id)\b/g, 'NEW.$1').replaceAll('tasks.NEW.id', 'tasks.id').replaceAll('alerts.NEW.task_id', 'NEW.task_id');
        db.exec(`CREATE TRIGGER check_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN ${expression} BEGIN SELECT RAISE(ABORT,'Invalid ${table} value'); END`);
      }
    }
    db.exec(`CREATE UNIQUE INDEX session_identity ON sessions(source,external_id) WHERE external_id IS NOT NULL;
      ALTER TABLE sessions ADD COLUMN source_created_at TEXT;
      CREATE TABLE prompts (
        id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), source TEXT NOT NULL CHECK(source IN ('chatgpt','mock-chatgpt')),
        requested_model TEXT NOT NULL, actual_model TEXT, requested_reasoning TEXT NOT NULL, actual_reasoning TEXT,
        generated_at TEXT NOT NULL, prompt_hash TEXT NOT NULL, content TEXT NOT NULL, source_message_id TEXT,
        verified INTEGER NOT NULL CHECK(verified IN (0,1)), delivery_status TEXT NOT NULL CHECK(delivery_status IN ('PENDING','DELIVERING','DELIVERED','FAILED','REVIEW_REQUIRED')),
        codex_execution_id TEXT, error_code TEXT,
        UNIQUE(task_id,prompt_hash));
      CREATE TABLE watcher_notifications(task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, status TEXT NOT NULL, completion_id INTEGER NOT NULL,
        observed_at TEXT NOT NULL, PRIMARY KEY(task_id,completion_id,status));
      CREATE TRIGGER independent_success BEFORE UPDATE OF status ON tasks
        WHEN NEW.status='SUCCEEDED' AND (OLD.status!='WAITING_APPROVAL' OR acb_can_succeed()!=1)
        BEGIN SELECT RAISE(ABORT,'Independent review required'); END;
      CREATE TRIGGER no_initial_success BEFORE INSERT ON tasks WHEN NEW.status='SUCCEEDED'
        BEGIN SELECT RAISE(ABORT,'Independent review required'); END;
      CREATE TABLE conversation_workspaces(project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id),
        workspace_path TEXT NOT NULL,workspace_key TEXT NOT NULL UNIQUE,chatgpt_conversation_id TEXT NOT NULL UNIQUE,chatgpt_conversation_name TEXT NOT NULL,registered_at TEXT NOT NULL);
      CREATE TABLE codex_conversations(conversation_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES conversation_workspaces(project_id));
      ALTER TABLE prompts ADD COLUMN source_conversation_id TEXT;
      ALTER TABLE prompts ADD COLUMN codex_conversation_id TEXT;
      PRAGMA user_version=2;`);
  }
}
