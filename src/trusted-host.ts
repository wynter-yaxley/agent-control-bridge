import type { DatabaseSync } from 'node:sqlite';
import { resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { now } from './db.ts';
import { BridgeError } from './errors.ts';
import { requireNoSecrets } from './security.ts';
import { TaskStore } from './tasks.ts';
import type { CodexAppServerExecutorOptions } from './codex-app-server.ts';

const key = (value: string) => /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? win32.normalize(value).toLowerCase().replace(/\\$/, '') : resolve(value);
const inside = (path: string, root: string) => { const child = key(path), base = key(root), sep = /^[a-zA-Z]:[\\/]|^\\\\/.test(root) ? '\\' : '/'; return child === base || child.startsWith(base + sep); };

/** Codex command/file approvals become durable ledger approvals for the run's
 * task. Only an independent reviewer can decide them (TaskStore.decideApproval).
 * Nothing is accepted automatically: out-of-workspace scope, secrets, a foreign
 * run/thread/turn, cancellation or no decision before the deadline all decline. */
export function createLedgerCodexApproval(options: { db: DatabaseSync; authority: CallerAuthority; executor: CallerContext; timeoutMs: number; pollMs?: number }): NonNullable<CodexAppServerExecutorOptions['approve']> {
  const { db, authority, executor } = options, pollMs = options.pollMs ?? 1000;
  return async ({ method, params, target, dispatchId }, signal) => {
    const run = db.prepare('SELECT task_id,conversation_id,workspace_path,state,execution_id FROM execution_runs WHERE id=?').get(dispatchId);
    if (!run || run.state !== 'RUNNING' || run.conversation_id !== target.codexConversationId || key(String(run.workspace_path)) !== key(target.workspacePath) ||
        params.threadId !== target.codexConversationId || typeof params.turnId !== 'string' || run.execution_id == null || params.turnId !== run.execution_id) return 'decline';
    for (const scope of [params.cwd, params.grantRoot]) if (scope !== undefined && scope !== null && (typeof scope !== 'string' || !inside(scope, target.workspacePath))) return 'decline';
    const command = typeof params.command === 'string' ? params.command : Array.isArray(params.command) ? params.command.map(String).join(' ') : null;
    const action = JSON.stringify({ kind: 'codex-approval', method, runId: dispatchId, threadId: params.threadId, turnId: params.turnId, itemId: typeof params.itemId === 'string' ? params.itemId : null,
      workspace: target.workspacePath, cwd: params.cwd ?? null, grantRoot: params.grantRoot ?? null, command: command?.slice(0, 2000) ?? null, truncated: (command?.length ?? 0) > 2000,
      reason: typeof params.reason === 'string' ? params.reason.slice(0, 500) : null });
    let approval: string;
    try { requireNoSecrets(action); approval = new TaskStore(db, authority).requestApproval(String(run.task_id), action.slice(0, 4096), executor); }
    catch { return 'decline'; }
    const deadline = Date.now() + options.timeoutMs;
    while (!signal.aborted && Date.now() < deadline) {
      const decision = db.prepare('SELECT decision FROM approvals WHERE id=?').get(approval)?.decision;
      if (decision === 'approved') return 'accept';
      if (decision === 'rejected') return 'decline';
      try { await delay(pollMs, undefined, { signal }); } catch { break; }
    }
    // Close the request so a late decision cannot be mistaken for one that applied.
    db.prepare("UPDATE approvals SET decision='rejected',decided_by='acb:expired',decided_at=?,reason='No reviewer decision before the deadline; declined' WHERE id=? AND decision='pending'").run(now(), approval);
    return db.prepare('SELECT decision FROM approvals WHERE id=?').get(approval)?.decision === 'approved' ? 'accept' : 'decline';
  };
}

/** Pending approvals visible to a reviewer (all) or a controller (its projects only). */
export function pendingApprovals(db: DatabaseSync, authority: CallerAuthority, context: CallerContext) {
  const caller = authority.resolve(context);
  if (!caller || (!caller.reviewer && !caller.controller)) throw new BridgeError('AUTH', 'Controller or independent reviewer required');
  return db.prepare(`SELECT a.id approvalId,a.task_id taskId,t.project_id projectId,a.action,a.requested_by requestedBy,a.requested_at requestedAt FROM approvals a JOIN tasks t ON t.id=a.task_id
    WHERE a.decision='pending' AND (?=1 OR EXISTS(SELECT 1 FROM project_access p WHERE p.project_id=t.project_id AND p.principal=?)) ORDER BY a.requested_at LIMIT 100`).all(caller.reviewer ? 1 : 0, caller.principal).map(row => ({ ...row }));
}

/** Native workspace + ordinary GPT initialization becomes a ledger approval that
 * only an independent reviewer can decide. One approval covers this exact
 * name/path for a short window, so a single bundle is not asked three times.
 * Rejection, cancellation or no decision before the deadline refuse. The helper
 * task carrying the approval is cancelled once the decision is closed. */
export function createLedgerInitializationApproval(options: { db: DatabaseSync; authority: CallerAuthority; controller: CallerContext; timeoutMs: number; pollMs?: number; reuseMs?: number }): (name: string, path: string, signal: AbortSignal) => Promise<boolean> {
  const { db, authority, controller } = options, pollMs = options.pollMs ?? 1000, reuseMs = options.reuseMs ?? 600000, approved = new Map<string, number>();
  return async (name, path, signal) => {
    const scope = `${name}\0${key(path)}`;
    if ((approved.get(scope) ?? 0) > Date.now()) return true;
    const store = new TaskStore(db, authority);
    let created: ReturnType<TaskStore['createTaskWithApproval']>;
    try { created = store.createTaskWithApproval({ kind: 'gui-initialization', title: 'Approve native workspace and ordinary GPT initialization', executor: null },
      JSON.stringify({ kind: 'gui-initialization', name, path, effects: ['native-workspace', 'ordinary-gpt'], reuseSeconds: reuseMs / 1000 }), controller); }
    catch { return false; }
    try {
      const deadline = Date.now() + options.timeoutMs;
      while (!signal.aborted && Date.now() < deadline) {
        const decision = db.prepare('SELECT decision FROM approvals WHERE id=?').get(created.approvalId)?.decision;
        if (decision !== 'pending') break;
        try { await delay(pollMs, undefined, { signal }); } catch { break; }
      }
      db.prepare("UPDATE approvals SET decision='rejected',decided_by='acb:expired',decided_at=?,reason='No reviewer decision before the deadline; refused' WHERE id=? AND decision='pending'").run(now(), created.approvalId);
      const accepted = db.prepare('SELECT decision FROM approvals WHERE id=?').get(created.approvalId)?.decision === 'approved' && !signal.aborted;
      if (accepted) approved.set(scope, Date.now() + reuseMs);
      return accepted;
    } finally {
      const task = store.getTask(created.task.id);
      if (task?.status === 'QUEUED') store.cancel(task.id, controller, 'Initialization approval closed', task.version);
    }
  };
}
