import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { now, transaction, uuid } from './db.ts';
import { BridgeError } from './errors.ts';
import { withDeadline } from './deadline.ts';
import { ConversationRegistry } from './topology.ts';
import { promptHash, type DeliveryTarget } from './prompts.ts';
import { TaskStore } from './tasks.ts';
import { isDemoDatabase } from './demo-scope.ts';
import { requireNoSecrets } from './security.ts';

export interface BackgroundExecutor {
  readonly mode: 'codex-exec' | 'codex-app-server' | 'mock';
  inspect(target: DeliveryTarget, signal: AbortSignal): Promise<{ source: 'codex-app-state'; conversationId: string; appProjectId: string; workspacePath: string; local: boolean }>;
  execute(content: string, key: string, target: DeliveryTarget, signal: AbortSignal, onEvent?: (event: Record<string, unknown>) => void): Promise<{ executionId: string; codexConversationId: string; workspacePath: string }>;
}
function samePath(a: string, b: string): boolean {
  const first = resolve(a), second = resolve(b);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export class BackgroundRunner {
  private readonly db: DatabaseSync;
  private readonly authority: CallerAuthority;
  private readonly executor: BackgroundExecutor;
  private readonly options: { timeoutMs: number; leaseSeconds: number };
  constructor(db: DatabaseSync, authority: CallerAuthority, executor: BackgroundExecutor, options: { timeoutMs: number; leaseSeconds: number }) {
    this.db = db; this.authority = authority; this.executor = executor; this.options = options;
    if (options.leaseSeconds * 1000 <= options.timeoutMs) throw new BridgeError('CONFIG', 'Execution lease must exceed the operation timeout');
    if (executor.mode === 'mock' && !isDemoDatabase(db)) throw new BridgeError('PROVENANCE', 'Mock execution requires an isolated Demo database');
  }
  async run(promptId: string, target: DeliveryTarget, context: CallerContext): Promise<string> {
    const caller = this.authority.resolve(context);
    if (caller?.executor !== 'codex' || caller.controller || caller.reviewer) throw new BridgeError('AUTH', 'A separate Codex executor context is required');
    const prompt = this.db.prepare('SELECT * FROM prompts WHERE id=?').get(promptId);
    if (!prompt || prompt.verified !== 1 || prompt.delivery_status !== 'PENDING' || promptHash(String(prompt.content)) !== prompt.prompt_hash ||
        (prompt.source !== 'chatgpt' && !isDemoDatabase(this.db))) throw new BridgeError('PROVENANCE', 'A verified unchanged pending GPT prompt is required');
    const taskId = String(prompt.task_id);
    const registry = new ConversationRegistry(this.db, this.authority);
    const mapping = registry.forTask(taskId);
    registry.assertExecution(taskId, target.codexConversationId, target.workspacePath);
    const inspect = await withDeadline(signal => this.executor.inspect(target, signal), this.options.timeoutMs);
    if (!inspect.local || inspect.source !== 'codex-app-state' || inspect.conversationId !== target.codexConversationId || inspect.appProjectId !== (mapping.app_project_id ?? mapping.project_id) || !samePath(inspect.workspacePath, mapping.workspace_path)) throw new BridgeError('PROVENANCE', 'Background execution target is not the registered local Codex workspace');
    const store = new TaskStore(this.db, this.authority);
    const runId = uuid();
    const attempt = transaction(this.db, () => {
      const current = store.getTask(taskId);
      if (!current || current.status !== 'QUEUED') throw new BridgeError('STATE', 'Task is not queued');
      if (this.db.prepare("SELECT 1 FROM project_operations WHERE state IN ('PROVISIONING','UNCERTAIN')").get()) throw new BridgeError('CONFLICT', 'Native project operation is active or awaiting reconciliation');
      if (this.db.prepare("SELECT 1 FROM execution_runs WHERE state IN ('RUNNING','UNCERTAIN')").get()) throw new BridgeError('CONFLICT', 'Background execution is occupied or awaiting reconciliation');
      const claimed = store.claim(taskId, context, this.options.leaseSeconds, current.version, promptId);
      if (!claimed.ok) throw new BridgeError(claimed.code as import('./errors.ts').ErrorCode, claimed.error);
      if (this.db.prepare('SELECT 1 FROM prompt_dispatches WHERE task_id=? AND attempt=?').get(taskId, claimed.task.attempt)) throw new BridgeError('CONFLICT', 'This attempt already owns an external dispatch');
      this.db.prepare('INSERT INTO prompt_dispatches(task_id,attempt,prompt_id,created_at) VALUES(?,?,?,?)').run(taskId, claimed.task.attempt, promptId, now());
      this.db.prepare("INSERT INTO execution_runs(id,task_id,attempt,prompt_id,project_id,holder,instance,conversation_id,workspace_path,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'RUNNING',?,?)").run(runId, taskId, claimed.task.attempt, promptId, mapping.project_id, caller.principal, caller.instance, target.codexConversationId, target.workspacePath, now(), now());
      if (this.db.prepare("UPDATE prompts SET delivery_status='DELIVERING' WHERE id=? AND delivery_status='PENDING'").run(promptId).changes !== 1) throw new BridgeError('CONFLICT', 'Prompt dispatch changed during claim');
      return claimed.task.attempt;
    });
    try {
      let sequence = 0;
      const onEvent = (event: Record<string, unknown>) => {
        const current = store.getTask(taskId);
        if (!current || current.status !== 'RUNNING' || current.attempt !== attempt || current.claimed_by !== caller.principal || current.claimed_instance !== caller.instance || !current.claim_expires_at || current.claim_expires_at <= now()) throw new BridgeError('CONFLICT', 'Execution event belongs to an expired attempt');
        const kind = typeof event.type === 'string' && /^[a-z_.]{1,100}$/.test(event.type) ? event.type : 'unknown';
        this.db.prepare('INSERT INTO execution_events(run_id,sequence,kind,observed_at) VALUES(?,?,?,?)').run(runId, ++sequence, kind, now());
      };
      const receipt = await withDeadline(signal => this.executor.execute(String(prompt.content), runId, target, signal, onEvent), this.options.timeoutMs);
      registry.assertExecution(taskId, receipt.codexConversationId, receipt.workspacePath);
      if (receipt.codexConversationId !== target.codexConversationId || typeof receipt.executionId !== 'string' || !receipt.executionId.trim() || receipt.executionId.length > 4096) throw new BridgeError('PROVENANCE', 'Codex execution receipt has a different identity');
      requireNoSecrets(receipt.executionId);
      transaction(this.db, () => {
        const current = store.getTask(taskId);
        if (!current || current.attempt !== attempt || current.execution_prompt_id !== promptId) throw new BridgeError('CONFLICT', 'Execution attempt changed');
        const finished = store.executorFinished(taskId, context, 'Background execution completed; independent acceptance required', current.version);
        if (!finished.ok) throw new BridgeError(finished.code as import('./errors.ts').ErrorCode, finished.error);
        this.db.prepare("UPDATE prompts SET delivery_status='DELIVERED',codex_execution_id=?,codex_conversation_id=?,error_code=NULL WHERE id=? AND delivery_status='DELIVERING'").run(receipt.executionId, receipt.codexConversationId, promptId);
        this.db.prepare("UPDATE execution_runs SET state='WAITING_APPROVAL',execution_id=?,updated_at=? WHERE id=? AND state='RUNNING'").run(receipt.executionId, now(), runId);
      });
      return runId;
    } catch (error) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE execution_runs SET state='UNCERTAIN',error_code=?,updated_at=? WHERE id=? AND state='RUNNING'").run(error instanceof BridgeError ? error.code : 'IO', now(), runId);
        this.db.prepare("UPDATE prompts SET error_code='EXECUTION_UNCERTAIN' WHERE id=? AND delivery_status='DELIVERING'").run(promptId);
      });
      throw error;
    }
  }
}
