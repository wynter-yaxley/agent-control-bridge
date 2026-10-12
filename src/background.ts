import type { DatabaseSync } from 'node:sqlite';
import { CallerAuthority, type CallerContext } from './caller.ts';
import type { BridgeConfig } from './config.ts';
import { now, transaction, uuid } from './db.ts';
import { BridgeError, classifyError } from './errors.ts';
import { TaskStore } from './tasks.ts';
import { ConversationRegistry } from './topology.ts';
import { PromptPipeline, promptHash, assertProjectRouteEvidence } from './prompts.ts';
import { createOrdinaryChatAdapter, assertOrdinaryChatCapabilities, type OrdinaryChatHost } from './ordinary-chat.ts';
import { BackgroundRunner, type BackgroundExecutor } from './background-runner.ts';
import { withDeadline } from './deadline.ts';
import { enqueueNotification, NotificationOutbox } from './outbox.ts';
import { ProjectProvisioner, type ProjectHost } from './project-provisioner.ts';
import { requireNoSecrets } from './security.ts';
import { resolve } from 'node:path';
import { inspectCodexThread } from './codex-app-server.ts';
import { checkNativeDesktop } from './native-readonly.ts';
import type { NativeChatMessageHost } from './native-messages.ts';

export interface BackgroundHostBindings {
  ordinaryChat?: OrdinaryChatHost;
  projects?: ProjectHost;
  executor?: BackgroundExecutor;
  executorContext?: CallerContext;
  /** Trusted host may route this read diagnostic to its Windows process. */
  nativeInspector?: typeof checkNativeDesktop;
  chatgptMessages?: NativeChatMessageHost;
}
export class BackgroundBridge {
  readonly outbox: NotificationOutbox;
  readonly projects: ProjectProvisioner;
  private readonly db: DatabaseSync;
  private readonly authority: CallerAuthority;
  private readonly context: CallerContext;
  private readonly config: BridgeConfig;
  private readonly host: BackgroundHostBindings;
  private busy = false;
  private stopped = true;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private readonly onError?: (code: string) => void;
  constructor(db: DatabaseSync, authority: CallerAuthority, context: CallerContext, config: BridgeConfig, host: BackgroundHostBindings = {}, onError?: (code: string) => void) {
    if (!authority.resolve(context)) throw new BridgeError('AUTH', 'An authenticated host context is required');
    this.db = db; this.authority = authority; this.context = context; this.config = config; this.host = host; this.onError = onError;
    this.outbox = new NotificationOutbox(db, authority);
    this.projects = new ProjectProvisioner(db, authority, { root: config.background.workspaceRoot, timeoutMs: config.background.timeoutMs, host: host.projects });
  }
  private controller() {
    const caller = this.authority.resolve(this.context);
    if (!caller?.controller || caller.executor !== 'hermes') throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    return caller;
  }
  assertCallerContext(context: CallerContext): void {
    if (context !== this.context) throw new BridgeError('AUTH', 'MCP connection and bridge must use the same caller context');
  }
  async capabilities(): Promise<{ fullWorkflowReady: boolean; ordinaryChatInstalled: boolean; projectHostInstalled: boolean; codexExecutorInstalled: boolean; blockers: string[] }> {
    const blockers: string[] = [];
    if (!this.config.agents.chatgpt.enabled) blockers.push('CHATGPT_DISABLED');
    if (!this.config.agents.codex.enabled) blockers.push('CODEX_DISABLED');
    if (!this.host.ordinaryChat) blockers.push('ORDINARY_CHAT_HOST_MISSING');
    else {
      try { assertOrdinaryChatCapabilities(await withDeadline(signal => this.host.ordinaryChat!.inspect(signal), this.config.background.timeoutMs)); }
      catch (error) { blockers.push(`ORDINARY_CHAT_${classifyError(error).code}`); }
    }
    if (!this.host.projects) blockers.push('PROJECT_HOST_MISSING');
    else {
      try { assertOrdinaryChatCapabilities(await withDeadline(signal => this.host.projects!.inspect(signal), this.config.background.timeoutMs), true); }
      catch (error) { blockers.push(`PROJECT_HOST_${classifyError(error).code}`); }
    }
    const worker = this.authority.resolve(this.host.executorContext);
    if (!this.host.executor || !worker || worker.executor !== 'codex' || worker.controller || worker.reviewer) blockers.push('CODEX_EXECUTOR_HOST_MISSING');
    // No global readiness promise can establish a target conversation or UI isolation.
    blockers.push('TARGET_ENVIRONMENT_ACCEPTANCE_REQUIRED');
    return { fullWorkflowReady: false, ordinaryChatInstalled: !!this.host.ordinaryChat, projectHostInstalled: !!this.host.projects, codexExecutorInstalled: !!this.host.executor, blockers };
  }
  async inspectCodexTarget(projectId: string, conversationId: string) {
    const caller = this.controller();
    const mapping = this.db.prepare('SELECT w.* FROM conversation_workspaces w JOIN codex_conversations c ON c.project_id=w.project_id JOIN project_access a ON a.project_id=w.project_id WHERE w.project_id=? AND c.conversation_id=? AND a.principal=?').get(projectId, conversationId, caller.principal);
    if (!mapping) throw new BridgeError('AUTH', 'Codex conversation is not registered to this controller/project');
    const executable = this.config.agents.codex.executable;
    if (!executable) throw new BridgeError('DEPENDENCY', 'Configure the official Codex executable before inspection');
    const actual = await withDeadline(signal => inspectCodexThread({ executable, timeoutMs: this.config.watcher.timeoutMs, conversationId, signal }), this.config.watcher.timeoutMs);
    const workspace = resolve(actual.workspacePath), expected = resolve(String(mapping.workspace_path));
    const workspaceMatches = process.platform === 'win32' ? workspace.toLowerCase() === expected.toLowerCase() : workspace === expected;
    return { ok: true, readOnly: true, conversationMatches: actual.conversationId === conversationId, workspaceMatches, local: actual.local,
      canonicalProjectStatus: actual.appProjectId === null ? 'UNAVAILABLE' : actual.appProjectId === (mapping.app_project_id ?? mapping.project_id) ? 'MATCH' : 'MISMATCH',
      threadStatus: actual.status, executionAuthorized: false, nativeHostAcceptanceRequired: true, realModelInvoked: false, ordinaryChatVerified: false };
  }
  async inspectNativeTarget(projectId: string, conversationId: string) {
    const caller = this.controller();
    const mapping = this.db.prepare('SELECT w.* FROM conversation_workspaces w JOIN codex_conversations c ON c.project_id=w.project_id JOIN project_access a ON a.project_id=w.project_id WHERE w.project_id=? AND c.conversation_id=? AND a.principal=?').get(projectId, conversationId, caller.principal);
    if (!mapping) throw new BridgeError('AUTH', 'Native diagnostic targets are not registered to this controller/project');
    const actual = await withDeadline(signal => (this.host.nativeInspector ?? checkNativeDesktop)({ carrierThreadId: conversationId,
      conversationId: String(mapping.chatgpt_conversation_id), expectedTitle: String(mapping.chatgpt_conversation_name), ...this.config.nativeInterface, signal }), this.config.nativeInterface.timeoutMs);
    return { ...actual, executionAuthorized: false, fullWorkflowReady: false };
  }
  async sendChatgptMessage(projectId: string, message: string) {
    const caller = this.controller();
    const mapping = this.db.prepare('SELECT w.chatgpt_conversation_id,w.chatgpt_conversation_name FROM conversation_workspaces w JOIN project_access a ON a.project_id=w.project_id WHERE w.project_id=? AND a.principal=?').get(projectId, caller.principal);
    if (!mapping) throw new BridgeError('AUTH', 'ChatGPT target is not registered to this controller/project');
    if (!this.host.chatgptMessages) throw new BridgeError('UNSUPPORTED', 'Authorized native ChatGPT message tools are not installed');
    requireNoSecrets(message);
    return this.host.chatgptMessages.sendAndWait({ conversationId: String(mapping.chatgpt_conversation_id), name: String(mapping.chatgpt_conversation_name) }, message, this.config.background);
  }
  submit(input: { eventKey: string; projectId: string; title: string; requirement: string; priority?: number }): ReturnType<BackgroundBridge['get']> {
    const caller = this.controller();
    for (const value of [input.eventKey, input.projectId, input.title, input.requirement]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 65536) throw new BridgeError('INPUT', 'Invalid request');
      requireNoSecrets(value);
    }
    const fingerprint = promptHash(JSON.stringify({ projectId: input.projectId, title: input.title, requirement: input.requirement, priority: input.priority ?? 0 }));
    const id = transaction(this.db, () => {
      const existing = this.db.prepare('SELECT id,request_hash FROM background_requests WHERE principal=? AND event_key=?').get(caller.principal, input.eventKey);
      if (existing) {
        if (existing.request_hash !== fingerprint) throw new BridgeError('CONFLICT', 'Request key was reused with different content');
        return String(existing.id);
      }
      const project = this.db.prepare('SELECT w.*,p.name,p.root_path FROM conversation_workspaces w JOIN projects p ON p.id=w.project_id WHERE w.project_id=?').get(input.projectId);
      if (!this.db.prepare('SELECT 1 FROM project_access WHERE project_id=? AND principal=?').get(input.projectId, caller.principal)) throw new BridgeError('AUTH', 'Project is not assigned to this controller');
      if (!project || project.chatgpt_conversation_name !== project.name) throw new BridgeError('PROVENANCE', 'A complete same-name project conversation mapping is required');
      const task = new TaskStore(this.db, this.authority).createTask({ kind: 'development', title: input.title, executor: 'codex', projectId: input.projectId, priority: input.priority }, this.context);
      const requestId = uuid(), time = now();
      this.db.prepare("INSERT INTO background_requests(id,principal,instance,event_key,request_hash,task_id,requirement,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'QUEUED',?,?)").run(requestId, caller.principal, caller.instance, input.eventKey, fingerprint, task.id, input.requirement, time, time);
      enqueueNotification(this.db, caller.principal, `request:${requestId}:queued`, { requestId, taskId: task.id, state: 'QUEUED' });
      return requestId;
    });
    this.wake();
    return this.get(id);
  }
  get(id: string) {
    const caller = this.controller();
    const row = this.db.prepare('SELECT id,task_id,state,error_code FROM background_requests WHERE id=? AND principal=?').get(id, caller.principal);
    if (!row) throw new BridgeError('NOT_FOUND', 'Request not found');
    const task = new TaskStore(this.db, this.authority).getTask(String(row.task_id))!;
    const progress = this.db.prepare('SELECT e.kind,e.observed_at FROM execution_events e JOIN execution_runs r ON r.id=e.run_id WHERE r.task_id=? ORDER BY r.attempt DESC,e.sequence DESC LIMIT 1').get(task.id);
    const terminal = ['SUCCEEDED','FAILED','CANCELLED'].includes(task.status);
    return { requestId: String(row.id), taskId: task.id, projectId: task.project_id, state: terminal ? task.status : String(row.state), taskStatus: task.status, version: task.version, attempt: task.attempt, errorCode: row.error_code === null ? null : String(row.error_code), lastEvent: progress ? { kind: progress.kind, observedAt: progress.observed_at } : null };
  }
  retryBlocked(id: string) {
    this.get(id);
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT task_id,state FROM background_requests WHERE id=?').get(id)!;
      if (row.state !== 'BLOCKED' || this.db.prepare("SELECT 1 FROM execution_runs WHERE task_id=? AND state IN ('RUNNING','UNCERTAIN')").get(row.task_id) ||
          this.db.prepare("SELECT 1 FROM prompt_generation_ops WHERE task_id=? AND state!='COMPLETE'").get(row.task_id)) throw new BridgeError('CONFLICT', 'External outcome must be reconciled before retry');
      this.db.prepare("UPDATE background_requests SET state='QUEUED',error_code=NULL,updated_at=? WHERE id=? AND state='BLOCKED'").run(now(), id);
    });
    this.wake(); return this.get(id);
  }
  start(): void {
    this.controller();
    if (!this.stopped) return;
    // Never infer that an interrupted host operation failed or completed.
    transaction(this.db, () => {
      const caller = this.controller();
      const rows = this.db.prepare("SELECT id,task_id FROM background_requests WHERE principal=? AND state IN ('GENERATING','RUNNING')").all(caller.principal);
      for (const row of rows) {
        enqueueNotification(this.db, caller.principal, `request:${row.id}:restart`, { requestId: row.id, taskId: row.task_id, state: 'HOST_STATUS_UNKNOWN', action: 'Inspect the original holder; do not restart a possibly running operation' });
      }
    });
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.config.background.intervalMs);
    this.wake();
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); }
  async shutdown(): Promise<void> { this.stop(); await this.inFlight; }
  private wake(): void {
    if (!this.stopped) queueMicrotask(() => {
      if (this.stopped || this.busy || this.inFlight) return;
      let processed = false;
      this.inFlight = this.tick().then(value => { processed = value; }).catch(error => this.onError?.(classifyError(error).code)).finally(() => {
        this.inFlight = undefined;
        if (processed) this.wake();
      });
    });
  }
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    const caller = this.controller();
    this.busy = true;
    let id: string | undefined;
    try {
      const row = transaction(this.db, () => {
        if (this.db.prepare("SELECT 1 FROM project_operations WHERE state IN ('PROVISIONING','UNCERTAIN')").get()) return null;
        if (this.db.prepare("SELECT 1 FROM background_requests WHERE state IN ('GENERATING','RUNNING','UNCERTAIN')").get()) return null;
        const next = this.db.prepare("SELECT r.* FROM background_requests r JOIN tasks t ON t.id=r.task_id WHERE r.principal=? AND r.state='QUEUED' AND t.status='QUEUED' ORDER BY t.priority DESC,r.created_at,r.id LIMIT 1").get(caller.principal);
        if (!next) return null;
        if (this.db.prepare("UPDATE background_requests SET state='GENERATING',updated_at=? WHERE id=? AND state='QUEUED'").run(now(), next.id).changes !== 1) return null;
        return next;
      });
      if (!row) return false;
      id = String(row.id);
      if (!this.config.agents.chatgpt.enabled || !this.config.agents.codex.enabled || !this.host.ordinaryChat || !this.host.executor || !this.host.executorContext) throw new BridgeError('UNSUPPORTED', 'Authorized ordinary GPT and Codex background hosts must be installed and enabled');
      assertOrdinaryChatCapabilities(await withDeadline(signal => this.host.ordinaryChat!.inspect(signal), this.config.background.timeoutMs));
      const registry = new ConversationRegistry(this.db, this.authority);
      const mapping = registry.forTask(String(row.task_id));
      const source = createOrdinaryChatAdapter(this.host.ordinaryChat, mapping.chatgpt_conversation_id, mapping.project_name);
      const route = await withDeadline(signal => source.preflight!({ conversationId: mapping.chatgpt_conversation_id, projectId: mapping.app_project_id ?? mapping.project_id, workspacePath: mapping.workspace_path }, signal), this.config.background.timeoutMs);
      assertProjectRouteEvidence(mapping, route);
      const pipeline = new PromptPipeline(this.db, this.authority, source, this.config.agents.chatgpt, { deliver: async () => { throw new BridgeError('UNSUPPORTED', 'Desktop prompt transport is not used by the background runner'); } }, this.config.background.timeoutMs);
      const promptId = await pipeline.generate(String(row.task_id), String(row.requirement), this.context);
      this.db.prepare("UPDATE background_requests SET state='RUNNING',updated_at=? WHERE id=? AND state='GENERATING'").run(now(), id);
      const target = this.db.prepare('SELECT conversation_id FROM codex_conversations WHERE project_id=? ORDER BY conversation_id LIMIT 1').get(mapping.project_id);
      if (!target) throw new BridgeError('PROVENANCE', 'Registered Codex conversation is missing');
      const runner = new BackgroundRunner(this.db, this.authority, this.host.executor, this.config.background);
      await runner.run(promptId, { codexConversationId: String(target.conversation_id), workspacePath: mapping.workspace_path }, this.host.executorContext);
      transaction(this.db, () => {
        this.db.prepare("UPDATE background_requests SET state='WAITING_APPROVAL',updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id!);
        enqueueNotification(this.db, caller.principal, `request:${id}:waiting`, { requestId: id, taskId: row.task_id, state: 'WAITING_APPROVAL' });
      });
      return true;
    } catch (error) {
      if (!id) throw error;
      const row = this.db.prepare('SELECT task_id FROM background_requests WHERE id=?').get(id)!;
      const uncertain = !!this.db.prepare("SELECT 1 FROM prompt_generation_ops WHERE task_id=? AND state='UNCERTAIN'").get(row.task_id) || !!this.db.prepare("SELECT 1 FROM execution_runs WHERE task_id=? AND state='UNCERTAIN'").get(row.task_id);
      const state = uncertain ? 'UNCERTAIN' : 'BLOCKED', code = classifyError(error).code;
      transaction(this.db, () => {
        this.db.prepare('UPDATE background_requests SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, code, now(), id!);
        enqueueNotification(this.db, caller.principal, `request:${id}:${state}:${code}`, { requestId: id, taskId: row.task_id, state, errorCode: code, action: uncertain ? 'Reconcile the original operation before retry' : 'Resolve the reported host capability or provenance blocker' });
      });
      return true;
    } finally { this.busy = false; }
  }
}
