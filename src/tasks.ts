import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { EXECUTORS, TASK_STATUSES, isAllowedTransition, type Task, type TaskStatus, type Executor } from './types.ts';
import { now, uuid, transaction } from './db.ts';
import { CallerAuthority, type CallerContext, type CallerIdentity } from './caller.ts';

export type TaskResult = { ok: true; task: Task } | { ok: false; code: string; error: string };
class Rejected extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
function reject(code: string, message: string): never { throw new Rejected(code, message); }
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) reject('INPUT', `Invalid ${field}`);
}
function lease(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) reject('INPUT', 'Lease must be 1..86400 seconds');
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export class TaskStore {
  #db: DatabaseSync;
  #authority: CallerAuthority;
  constructor(db: DatabaseSync, authority: CallerAuthority) { this.#db = db; this.#authority = authority; }
  #caller(context: unknown): Readonly<CallerIdentity> {
    return this.#authority.resolve(context) ?? reject('AUTH', 'Authorized caller context required');
  }
  #task(id: string, version?: number): Task {
    text(id, 'task ID');
    const task = this.getTask(id) ?? reject('NOT_FOUND', 'Task not found');
    if (!Number.isSafeInteger(version) || version! < 0) reject('INPUT', 'Expected task version required');
    if (task.version !== version) reject('CONFLICT', 'Stale task version; reread before retry');
    return task;
  }
  #holder(task: Task, caller: Readonly<CallerIdentity>, requireLiveLease = true): void {
    if (task.claimed_by !== caller.principal || task.claimed_instance !== caller.instance ||
        task.attempt_executor !== caller.principal || task.attempt_instance !== caller.instance || !caller.executor ||
        (task.executor !== null && task.executor !== caller.executor)) reject('OWNER', 'Caller is not the holder of this attempt');
    if (requireLiveLease && (!task.claim_expires_at || task.claim_expires_at <= now())) reject('LEASE', 'Attempt lease expired');
  }
  #event(id: string, type: string, payload: unknown, caller: Readonly<CallerIdentity>): void {
    this.#db.prepare('INSERT INTO events(task_id,type,payload,source,observed_at) VALUES(?,?,?,?,?)')
      .run(id, type, payload === undefined ? null : JSON.stringify(payload), caller.principal, now());
  }
  #audit(caller: Readonly<CallerIdentity>, action: string, detail: string): void {
    this.#db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), caller.principal, action, detail);
  }
  #cas(task: Task, to: TaskStatus, patch: Record<string, SQLInputValue> = {}): void {
    if (!isAllowedTransition(task.status, to)) reject('STATE', `Illegal transition ${task.status} -> ${to}`);
    this.#update(task, { ...patch, status: to, updated_at: now(), finished_at: ['SUCCEEDED','FAILED','CANCELLED'].includes(to) ? now() : null });
  }
  #update(task: Task, patch: Record<string, SQLInputValue>): void {
    // Only internal fixed column names reach this helper; never CLI/Agent data.
    const entries = Object.entries(patch);
    const result = this.#db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key}=?`).join(',')}, version=version+1
      WHERE id=? AND status=? AND version=? AND claimed_by IS ? AND claimed_instance IS ? AND attempt=?`)
      .run(...entries.map(([, value]) => value), task.id, task.status, task.version, task.claimed_by, task.claimed_instance, task.attempt);
    if (result.changes !== 1) reject('CONFLICT', 'Concurrent task update rejected');
  }
  #mutate(action: () => Task): TaskResult {
    try { return { ok: true, task: transaction(this.#db, action) }; }
    catch (error) {
      if (error instanceof Rejected) return { ok: false, code: error.code, error: error.message };
      // Preserve original exception for the trusted host; CLI prints no raw DB payloads.
      throw error;
    }
  }
  createTask(input: { projectId?: string | null; sessionId?: string | null; kind: string; title: string; executor?: Executor | null; priority?: number }, context: CallerContext): Task {
    const caller = this.#caller(context);
    text(input.kind, 'kind'); text(input.title, 'title');
    if (input.executor != null && !EXECUTORS.includes(input.executor)) reject('INPUT', 'Invalid executor');
    if (!Number.isSafeInteger(input.priority ?? 0)) reject('INPUT', 'Invalid priority');
    return transaction(this.#db, () => {
      const id = uuid(), time = now();
      this.#db.prepare(`INSERT INTO tasks(id,project_id,session_id,kind,title,status,executor,priority,created_at,updated_at,created_by,created_instance)
        VALUES(?,?,?,?,?,'QUEUED',?,?,?,?,?,?)`).run(id, input.projectId ?? null, input.sessionId ?? null, input.kind, input.title,
        input.executor ?? null, input.priority ?? 0, time, time, caller.principal, caller.instance);
      this.#event(id, 'created', null, caller);
      this.#audit(caller, 'task_create', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  getTask(id: string): Task | null { return this.#db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task ?? null; }
  listTasks(filter: { status?: TaskStatus; projectId?: string; executor?: Executor } = {}): Task[] {
    if (filter.status && !TASK_STATUSES.includes(filter.status)) reject('INPUT', 'Invalid status');
    if (filter.executor && !EXECUTORS.includes(filter.executor)) reject('INPUT', 'Invalid executor');
    const clauses: string[] = [], values: SQLInputValue[] = [];
    for (const [key, value] of [['status',filter.status], ['project_id',filter.projectId], ['executor',filter.executor]] as const) {
      if (value) { clauses.push(`${key}=?`); values.push(value); }
    }
    return this.#db.prepare(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY priority DESC,created_at ASC`).all(...values) as unknown as Task[];
  }
  claim(id: string, context: CallerContext, leaseSeconds = 600, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      if (!caller.executor || (task.executor !== null && task.executor !== caller.executor)) reject('OWNER', 'Executor is not assigned to this task');
      if (task.status !== 'QUEUED' || task.claimed_by !== null || task.claimed_instance !== null) reject('STATE', 'Task is not unclaimed QUEUED');
      this.#cas(task, 'RUNNING', { claimed_by: caller.principal, claimed_instance: caller.instance,
        attempt_executor: caller.principal, attempt_instance: caller.instance, attempt: task.attempt + 1,
        executor: caller.executor, claim_expires_at: lease(leaseSeconds), started_at: now() });
      this.#event(id, 'claimed', { executor: caller.executor, instance: caller.instance, attempt: task.attempt + 1 }, caller);
      this.#audit(caller, 'task_claim', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  executorFinished(id: string, context: CallerContext, note?: string, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      this.#holder(task, caller);
      if (task.status !== 'RUNNING') reject('STATE', 'Only RUNNING can finish');
      this.#cas(task, 'WAITING_APPROVAL');
      this.#event(id, 'executor_finished', { note: note ?? null, attempt: task.attempt }, caller);
      this.#audit(caller, 'task_finish', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  verify(id: string, context: CallerContext, pass: boolean, reason?: string, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      if (!caller.reviewer) reject('AUTH', 'Independent reviewer capability required');
      if (!task.attempt_executor || caller.principal === task.attempt_executor) reject('AUTH', 'Executor principal cannot review its own attempt');
      if (typeof pass !== 'boolean') reject('INPUT', 'Explicit boolean review decision required');
      if (task.status !== 'WAITING_APPROVAL') reject('STATE', 'Task is not awaiting review');
      this.#cas(task, pass ? 'SUCCEEDED' : 'FAILED', { claim_expires_at: null });
      this.#event(id, pass ? 'verified_pass' : 'verified_fail', { reason: reason ?? null, attempt: task.attempt }, caller);
      this.#audit(caller, pass ? 'task_verify_pass' : 'task_verify_fail', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  cancel(id: string, context: CallerContext, reason?: string, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      if (task.claimed_by !== null) this.#holder(task, caller, false);
      else if (task.created_by !== caller.principal || task.created_instance !== caller.instance) reject('OWNER', 'Only the creating instance may cancel an unclaimed task');
      this.#cas(task, 'CANCELLED', { claim_expires_at: null });
      this.#event(id, 'cancelled', { reason: reason ?? null }, caller); this.#audit(caller, 'task_cancel', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  renew(id: string, context: CallerContext, leaseSeconds = 600, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      this.#holder(task, caller);
      if (!['RUNNING','BLOCKED','WAITING_APPROVAL'].includes(task.status)) reject('STATE', 'Task has no renewable active attempt');
      this.#update(task, { claim_expires_at: lease(leaseSeconds), updated_at: now() });
      this.#event(id, 'lease_renewed', { leaseSeconds }, caller); this.#audit(caller, 'task_renew', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  transition(id: string, to: TaskStatus, context: CallerContext, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      if (!TASK_STATUSES.includes(to)) reject('INPUT', 'Invalid status');
      if (['SUCCEEDED','WAITING_APPROVAL','CANCELLED','RUNNING'].includes(to)) reject('STATE', 'Use claim/finish/verify/cancel/resume; direct transition forbidden');
      if (to === 'QUEUED') {
        if (!caller.reviewer) reject('AUTH', 'Only an authorized reviewer may requeue');
        this.#cas(task, to, { claimed_by: null, claimed_instance: null, claim_expires_at: null, started_at: null });
      } else {
        this.#holder(task, caller);
        if (!['RUNNING','BLOCKED'].includes(task.status)) reject('STATE', 'Use independent verification for review decisions');
        this.#cas(task, to, { claim_expires_at: to === 'FAILED' ? null : task.claim_expires_at });
      }
      this.#event(id, `status:${task.status}->${to}`, { attempt: task.attempt }, caller); this.#audit(caller, 'task_transition', `task=${id} to=${to}`);
      return this.getTask(id)!;
    });
  }
  resume(id: string, context: CallerContext, expectedVersion?: number): TaskResult {
    return this.#mutate(() => {
      const caller = this.#caller(context), task = this.#task(id, expectedVersion);
      this.#holder(task, caller);
      if (!['BLOCKED','WAITING_APPROVAL'].includes(task.status)) reject('STATE', 'Task is not resumable');
      this.#cas(task, 'RUNNING'); this.#event(id, 'resumed', null, caller); this.#audit(caller, 'task_resume', `task=${id}`);
      return this.getTask(id)!;
    });
  }
  requestApproval(id: string, action: string, context: CallerContext): string {
    const caller = this.#caller(context); text(action, 'approval action');
    return transaction(this.#db, () => {
      const task = this.getTask(id) ?? reject('NOT_FOUND', 'Task not found');
      if (task.claimed_by) this.#holder(task, caller);
      else if (task.created_by !== caller.principal || task.created_instance !== caller.instance) reject('OWNER', 'Approval requester must own the task');
      const approval = uuid();
      this.#db.prepare('INSERT INTO approvals(id,task_id,action,requested_by,requested_at) VALUES(?,?,?,?,?)').run(approval, id, action, caller.principal, now());
      this.#event(id, 'approval_requested', { approval, action }, caller); this.#audit(caller, 'approval_request', `approval=${approval}`);
      return approval;
    });
  }
  decideApproval(id: string, decision: 'approved' | 'rejected', context: CallerContext, reason?: string): void {
    const caller = this.#caller(context);
    if (!caller.reviewer) reject('AUTH', 'Reviewer capability required');
    if (!['approved','rejected'].includes(decision)) reject('INPUT', 'Invalid approval decision');
    transaction(this.#db, () => {
      const approval = this.#db.prepare('SELECT task_id,requested_by FROM approvals WHERE id=?').get(id);
      if (!approval) reject('NOT_FOUND', 'Approval not found');
      if (approval.requested_by === caller.principal) reject('AUTH', 'Requester cannot approve its own action');
      const result = this.#db.prepare("UPDATE approvals SET decision=?,decided_by=?,decided_at=?,reason=? WHERE id=? AND decision='pending'")
        .run(decision, caller.principal, now(), reason ?? null, id);
      if (result.changes !== 1) reject('CONFLICT', 'Approval is already decided');
      this.#event(String(approval.task_id), 'approval_decision', { approval: id, decision }, caller);
      this.#audit(caller, 'approval_decision', `approval=${id} decision=${decision}`);
    });
  }
  createTaskWithApproval(input: Parameters<TaskStore['createTask']>[0], action: string, context: CallerContext): { task: Task; approvalId: string } {
    return transaction(this.#db, () => { const task = this.createTask(input, context); return { task, approvalId: this.requestApproval(task.id, action, context) }; });
  }
  recordAudit(context: CallerContext, action: string, detail: string): void { this.#audit(this.#caller(context), action, detail); }
  sweepExpiredLeases(context: CallerContext): { taskId: string; claimedBy: string }[] {
    const caller = this.#caller(context);
    return transaction(this.#db, () => {
      const rows = this.#db.prepare("SELECT id AS taskId,claimed_by AS claimedBy FROM tasks WHERE status IN ('RUNNING','BLOCKED','WAITING_APPROVAL') AND claim_expires_at < ?").all(now()) as unknown as {taskId: string; claimedBy: string}[];
      for (const row of rows) {
        if (!this.#db.prepare("SELECT 1 FROM alerts WHERE task_id=? AND severity='warn' AND message LIKE '%lease_expired%' AND acknowledged_at IS NULL").get(row.taskId)) {
          this.#db.prepare("INSERT INTO alerts(id,task_id,severity,message,created_at) VALUES(?,?,'warn',?,?)").run(uuid(), row.taskId, 'lease_expired: disconnected; task state unchanged', now());
          this.#event(row.taskId, 'lease_expired', null, caller); this.#audit(caller, 'lease_expired', `task=${row.taskId}`);
        }
      }
      return rows;
    });
  }
}
