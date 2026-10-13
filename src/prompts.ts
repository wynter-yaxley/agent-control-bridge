import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, win32 } from 'node:path';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { transaction, now } from './db.ts';
import { BridgeError } from './errors.ts';
import { requireNoSecrets } from './security.ts';
import { ConversationRegistry } from './topology.ts';
import { isDemoDatabase } from './demo-scope.ts';
export interface Generation {
  content: string; sourceConversationId?: string; sourceConversationName?: string; sourceMessageId: string; actualModel: string | null; actualReasoningEffort: string | null;
  completionEvidence?: { source: 'windows-uia' | 'visible-dom'; turnId: string; userMessageId: string; assistantMessageId: string; observedAt: string; nativeCompleted: true; uiIdle: true; replyActions?: true };
}
// Adapter objects are installed by trusted host code, never deserialized from CLI/Agent JSON.
export interface ChatgptAdapter {
  readonly source: 'chatgpt' | 'mock-chatgpt';
  readonly conversationId?: string;
  readonly conversationName?: string;
  // App-side navigation read, distinct from the bridge's expected mapping.
  preflight?(target: { conversationId: string; projectId: string; workspacePath: string }, signal: AbortSignal): Promise<ProjectRouteEvidence>;
  capabilities(): Promise<{ models: string[]; reasoningEfforts: string[]; verified: boolean }>;
  generate(requirement: string, options: { model: string; reasoningEffort: string; signal: AbortSignal }): Promise<Generation>;
  observeGeneration?(request: string, signal: AbortSignal): Promise<Generation>;
}
export interface CodexDelivery {
  target?(signal: AbortSignal): Promise<DeliveryTarget>;
  // Production adapters must independently read the active desktop execution state.
  // DOM labels are observations; local Codex app metadata and exact path/thread IDs
  // must corroborate them. Demo adapters never authorize production delivery.
  preflight?(target: DeliveryTarget, signal: AbortSignal): Promise<ExecutionEvidence>;
  deliver(content: string, key: string, signal: AbortSignal, target: DeliveryTarget | null): Promise<{ executionId: string; codexConversationId?: string; workspacePath?: string }>;
}
export interface DeliveryTarget { codexConversationId: string; workspacePath: string }
export interface ApplicationProjectRouteEvidence {
  source: 'application-navigation' | 'unknown';
  conversationId: string | null;
  projectId: string | null;
  workspacePath: string | null;
  listKind?: 'project' | 'recent' | 'unknown';
}
// Ordinary GPT belongs to its own application surface. Its fixed association
// with a Codex workspace is owned by the protected bridge registry, not by a
// fictitious shared native project ID. Only a trusted host may supply this read.
export interface OrdinaryConversationIdentityEvidence {
  source: 'application-host';
  kind: 'ordinary-chat' | 'work' | 'unknown';
  conversationId: string | null;
  name: string;
}
export type ProjectRouteEvidence = ApplicationProjectRouteEvidence | OrdinaryConversationIdentityEvidence;
export interface ExecutionEvidence {
  surface: 'codex-desktop' | 'chatgpt-web' | 'unknown';
  modeAttribute: 'codex-local' | 'work-cloud' | 'gpt' | null;
  badgeText?: string | null;
  conversationId: string | null;
  projectId: string | null;
  workspacePath: string | null;
  composerState: 'ready' | 'missing' | 'unknown';
  codexAppState?: { source: 'codex-app-state'; threadId: string; projectId: string; workspacePath: string } | null;
}

function canonicalWorkspace(path: string): string {
  if (typeof path !== 'string' || !path.trim()) return '';
  const value = path.trim();
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? win32.normalize(value).toLowerCase() : resolve(value);
}

export function assertLocalCodexEvidence(mapping: { project_id: string; app_project_id?: string | null; workspace_path: string }, target: DeliveryTarget, evidence: ExecutionEvidence): void {
  const badge = typeof evidence?.badgeText === 'string' ? evidence.badgeText.trim().toLocaleLowerCase() : '';
  if (evidence?.modeAttribute === 'work-cloud' || badge === 'work · 云端环境' || badge === 'work · cloud environment') {
    throw new BridgeError('PROVENANCE', 'Cloud Work execution is selected; local Codex delivery was blocked');
  }
  const localBadge = badge === 'codex · 本地工作区' || badge === 'codex · local workspace';
  if (!evidence || evidence.surface !== 'codex-desktop' || ![null, 'codex-local'].includes(evidence.modeAttribute) ||
      (badge !== '' && !localBadge) || evidence.composerState !== 'ready') {
    throw new BridgeError('PROVENANCE', 'Local Codex execution mode could not be positively verified');
  }
  const expectedWorkspace = canonicalWorkspace(mapping?.workspace_path);
  const targetWorkspace = canonicalWorkspace(target?.workspacePath);
  const state = evidence.codexAppState;
  if (!mapping?.project_id || !expectedWorkspace || !target?.codexConversationId || targetWorkspace !== expectedWorkspace ||
      evidence.conversationId !== target.codexConversationId || evidence.projectId !== (mapping.app_project_id ?? mapping.project_id) ||
      canonicalWorkspace(evidence.workspacePath ?? '') !== expectedWorkspace ||
      !state || state.source !== 'codex-app-state' || state.threadId !== target.codexConversationId ||
      state.projectId !== (mapping.app_project_id ?? mapping.project_id) || canonicalWorkspace(state.workspacePath) !== expectedWorkspace) {
    throw new BridgeError('PROVENANCE', 'Codex thread, project, workspace, and local app state do not agree');
  }
}

export function assertProjectRouteEvidence(mapping: { project_id: string; app_project_id?: string | null; workspace_path: string; chatgpt_conversation_id: string; chatgpt_conversation_name?: string; project_name?: string }, evidence: ProjectRouteEvidence): void {
  if (evidence?.source === 'application-host') {
    if (evidence.kind !== 'ordinary-chat' || evidence.conversationId !== mapping.chatgpt_conversation_id || !mapping.chatgpt_conversation_name || evidence.name !== mapping.chatgpt_conversation_name ||
        (mapping.project_name !== undefined && evidence.name !== mapping.project_name)) throw new BridgeError('PROVENANCE', 'Host-observed ordinary GPT identity or exact project title mismatched');
    return;
  }
  if (!evidence || evidence.source !== 'application-navigation' ||
      evidence.conversationId !== mapping.chatgpt_conversation_id || evidence.projectId !== (mapping.app_project_id ?? mapping.project_id)) {
    const detail = evidence?.listKind === 'recent' && evidence.projectId === null
      ? 'Project conversation is in Recent without verified application ownership'
      : 'Application conversation/project identity does not match the registered bridge mapping';
    throw new BridgeError('PROVENANCE', detail);
  }
  if (!evidence.workspacePath || canonicalWorkspace(evidence.workspacePath) !== canonicalWorkspace(mapping.workspace_path)) {
    throw new BridgeError('PROVENANCE', 'Application workspace conflicts with the registered project root');
  }
}
export const promptHash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BridgeError('TIMEOUT', 'Adapter exceeded its deadline; external outcome uncertain')); }, milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class PromptPipeline {
  private db: DatabaseSync; private authority: CallerAuthority; private adapter: ChatgptAdapter;
  private requested: { model: string; reasoningEffort: string }; private delivery: CodexDelivery;
  private timeoutMs: number;
  constructor(db: DatabaseSync, authority: CallerAuthority, adapter: ChatgptAdapter,
    requested: { model: string; reasoningEffort: string }, delivery: CodexDelivery, timeoutMs = 30000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new BridgeError('CONFIG', 'Invalid adapter timeout'); this.timeoutMs = timeoutMs;
    this.db = db; this.authority = authority; this.adapter = adapter; this.requested = requested; this.delivery = delivery;
  }
  private controller(context: CallerContext): void {
    const caller = this.authority.resolve(context);
    if (!caller || !caller.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller context required');
    if (this.adapter.source === 'mock-chatgpt' && !isDemoDatabase(this.db)) throw new BridgeError('PROVENANCE', 'Mock adapters require a freshly created isolated Demo database');
  }
  async generate(taskId: string, requirement: string, context: CallerContext): Promise<string> {
    this.controller(context);
    if (typeof requirement !== 'string' || !requirement.trim() || requirement.length > 65536) throw new BridgeError('INPUT', 'Invalid requirement');
    requireNoSecrets(requirement);
    const requestHash = promptHash(JSON.stringify({ requirement, ...this.requested }));
    const existing = this.db.prepare('SELECT * FROM prompt_generation_ops WHERE task_id=?').get(taskId);
    if (existing) {
      if (existing.request_hash !== requestHash) throw new BridgeError('CONFLICT', 'Requirement changed; create a new task and prompt version');
      if (existing.state === 'COMPLETE') return String(existing.prompt_id);
      throw new BridgeError('CONFLICT', 'Generation is in progress or requires external outcome reconciliation');
    }
    transaction(this.db, () => {
      if (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status !== 'QUEUED') throw new BridgeError('STATE', 'Prompt generation requires an existing QUEUED task');
      this.db.prepare("INSERT INTO prompt_generation_ops(task_id,request_hash,state,created_at) VALUES(?,?,'GENERATING',?)").run(taskId, requestHash, now());
    });
    let effectsStarted = false;
    try {
      const id = await this.generateOnce(taskId, requirement, context, () => { effectsStarted = true; });
      this.db.prepare("UPDATE prompt_generation_ops SET state='COMPLETE',prompt_id=? WHERE task_id=? AND state='GENERATING'").run(id, taskId);
      return id;
    } catch (error) {
      if (effectsStarted) this.db.prepare("UPDATE prompt_generation_ops SET state='UNCERTAIN',error_code=? WHERE task_id=? AND state='GENERATING'").run(error instanceof BridgeError ? error.code : 'IO', taskId);
      else this.db.prepare("DELETE FROM prompt_generation_ops WHERE task_id=? AND state='GENERATING'").run(taskId);
      throw error;
    }
  }
  async reconcileGeneration(taskId: string, requirement: string, context: CallerContext): Promise<string> {
    this.controller(context);
    const operation=this.db.prepare('SELECT state,request_hash FROM prompt_generation_ops WHERE task_id=?').get(taskId);
    if(operation?.state!=='UNCERTAIN' || operation.request_hash!==promptHash(JSON.stringify({requirement,...this.requested})))throw new BridgeError('CONFLICT','Only the original uncertain generation can be observed');
    const id=await this.generateOnce(taskId,requirement,context,()=>{},true);
    this.db.prepare("UPDATE prompt_generation_ops SET state='COMPLETE',prompt_id=?,error_code=NULL WHERE task_id=? AND state='UNCERTAIN'").run(id,taskId);
    return id;
  }
  private async generateOnce(taskId: string, requirement: string, context: CallerContext, onExternalStart: () => void, observeOnly=false): Promise<string> {
    this.controller(context);
    const task = this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
    if (!task || task.status !== 'QUEUED') throw new BridgeError('STATE', 'Prompt generation requires an existing QUEUED task');
    if (!requirement.trim() || requirement.length > 65536) throw new BridgeError('INPUT', 'Invalid requirement'); requireNoSecrets(requirement);
    const registry = new ConversationRegistry(this.db, this.authority);
    const mapping = !isDemoDatabase(this.db) ? registry.forTask(taskId) : null;
    if(mapping && this.adapter.conversationId!==mapping.chatgpt_conversation_id) throw new BridgeError('PROVENANCE','Adapter target does not match the registered GPT conversation');
    if(mapping && (this.adapter.conversationName!==mapping.project_name||mapping.chatgpt_conversation_name!==mapping.project_name)) throw new BridgeError('PROVENANCE','GPT conversation name must match the workspace project name');
    if(mapping) {
      if(!this.adapter.preflight) throw new BridgeError('PROVENANCE','ChatGPT adapter has no app-side project route preflight; refusing to send');
      const target={conversationId:mapping.chatgpt_conversation_id,projectId:mapping.app_project_id ?? mapping.project_id,workspacePath:mapping.workspace_path};
      const route=await bounded(signal=>this.adapter.preflight!(target,signal),this.timeoutMs);
      assertProjectRouteEvidence(mapping,route);
    }
    const capabilities = await bounded(() => this.adapter.capabilities(), this.timeoutMs);
    if (!capabilities.verified) throw new BridgeError('UNSUPPORTED', 'Trusted generation capability is unavailable');
    if(mapping) {
      const target={conversationId:mapping.chatgpt_conversation_id,projectId:mapping.app_project_id ?? mapping.project_id,workspacePath:mapping.workspace_path};
      const route=await bounded(signal=>this.adapter.preflight!(target,signal),this.timeoutMs);
      assertProjectRouteEvidence(mapping,route);
    }
    const request = `请把下列需求转成可直接交给 Codex 执行的工程 Prompt。只输出工程 Prompt 正文，使用纯文本，包含明确范围、实现要求、必要验证与交付结果。此 GPT 对话只分析和生成 Prompt，不执行工程任务。\n用户需求：\n${requirement}`;
    if(observeOnly && !this.adapter.observeGeneration)throw new BridgeError('UNSUPPORTED','Host cannot read the original generation without sending');
    if(!observeOnly)onExternalStart();
    const result = await bounded(signal => observeOnly ? this.adapter.observeGeneration!(request,signal) : this.adapter.generate(request, { ...this.requested, signal }), this.timeoutMs);
    if (!result.content.trim() || result.content.length > 65536 || !result.sourceMessageId) throw new BridgeError('PROVENANCE', 'Generation has no verifiable source message');
    requireNoSecrets(result.content); requireNoSecrets(result.sourceMessageId);
    if (result.sourceMessageId.length > 4096 || (mapping && result.sourceConversationId !== mapping.chatgpt_conversation_id)) throw new BridgeError('PROVENANCE', 'Generation belongs to another GPT conversation');
    if(mapping && result.sourceConversationName!==mapping.project_name) throw new BridgeError('PROVENANCE','Generation conversation name no longer matches the workspace project');
    // User policy: provenance authorizes delivery; model/effort are observations,
    // and unavailable values stay null rather than blocking this workflow.
    const verified = true;
    const id = randomUUID(), hash = promptHash(result.content);
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status !== 'QUEUED') throw new BridgeError('CONFLICT', 'Task changed during generation');
      const existing = this.db.prepare('SELECT id FROM prompts WHERE task_id=? AND prompt_hash=?').get(taskId, hash);
      if (existing) return String(existing.id);
      this.db.prepare(`INSERT INTO prompts(id,task_id,source,requested_model,actual_model,requested_reasoning,actual_reasoning,generated_at,prompt_hash,content,source_message_id,verified,delivery_status,source_conversation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, this.adapter.source, this.requested.model, result.actualModel, this.requested.reasoningEffort, result.actualReasoningEffort, now(), hash, result.content, result.sourceMessageId, verified ? 1 : 0, verified ? 'PENDING' : 'REVIEW_REQUIRED', result.sourceConversationId ?? null);
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), this.authority.resolve(context)!.principal, 'prompt_generated', `prompt=${id} hash=${hash} source=${this.adapter.source} completion=${JSON.stringify(result.completionEvidence ?? null)}`);
      return id;
    });
  }
  async deliver(id: string, context: CallerContext): Promise<{ executionId: string }> {
    this.controller(context);
    const prompt = this.db.prepare('SELECT * FROM prompts WHERE id=?').get(id);
    if (!prompt || prompt.verified !== 1 || !['chatgpt', 'mock-chatgpt'].includes(String(prompt.source))) throw new BridgeError('PROVENANCE', 'Trusted generation record required');
    if (prompt.source === 'mock-chatgpt' && !isDemoDatabase(this.db)) throw new BridgeError('PROVENANCE', 'Test provenance cannot authorize production');
    if (promptHash(String(prompt.content)) !== prompt.prompt_hash) throw new BridgeError('PROVENANCE', 'Prompt content was modified after generation');
    if (prompt.delivery_status === 'DELIVERED') return { executionId: String(prompt.codex_execution_id) };
    if (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(prompt.task_id)?.status !== 'QUEUED') throw new BridgeError('STATE', 'Delivery requires a QUEUED task');
    if (!['PENDING', 'FAILED'].includes(String(prompt.delivery_status))) throw new BridgeError('CONFLICT', 'Delivery is pending recovery or manual review');
    let destination: DeliveryTarget | null = null;
    let mapping: ReturnType<ConversationRegistry['forTask']> | null = null;
    if(!isDemoDatabase(this.db)) {
      if(!this.delivery.target) throw new BridgeError('PROVENANCE','Codex destination must be independently resolved before sending');
      if(!this.delivery.preflight) throw new BridgeError('PROVENANCE','Codex delivery adapter has no local execution preflight; refusing to send');
      const registry=new ConversationRegistry(this.db,this.authority);
      mapping=registry.forTask(String(prompt.task_id));
      destination=await bounded(signal=>this.delivery.target!(signal),this.timeoutMs);
      new ConversationRegistry(this.db,this.authority).assertExecution(String(prompt.task_id),destination.codexConversationId,destination.workspacePath);
      const initialEvidence=await bounded(signal=>this.delivery.preflight!(destination!,signal),this.timeoutMs);
      assertLocalCodexEvidence(mapping,destination,initialEvidence);
    }
    if(!isDemoDatabase(this.db)) {
      const registry=new ConversationRegistry(this.db,this.authority);
      const refreshed=await bounded(signal=>this.delivery.target!(signal),this.timeoutMs);
      registry.assertExecution(String(prompt.task_id),refreshed.codexConversationId,refreshed.workspacePath);
      if(refreshed.codexConversationId!==destination!.codexConversationId || canonicalWorkspace(refreshed.workspacePath)!==canonicalWorkspace(destination!.workspacePath))
        throw new BridgeError('PROVENANCE','Codex target changed after execution preflight');
      const finalEvidence=await bounded(signal=>this.delivery.preflight!(refreshed,signal),this.timeoutMs);
      assertLocalCodexEvidence(mapping!,refreshed,finalEvidence);
    }
    transaction(this.db, () => {
      const task = this.db.prepare("SELECT attempt FROM tasks WHERE id=? AND status='QUEUED'").get(prompt.task_id);
      if (!task) throw new BridgeError('CONFLICT', 'Task changed during delivery preflight');
      const dispatch = this.db.prepare('SELECT prompt_id FROM prompt_dispatches WHERE task_id=? AND attempt=?').get(prompt.task_id, Number(task.attempt) + 1);
      if (dispatch && dispatch.prompt_id !== id) throw new BridgeError('CONFLICT', 'Another prompt owns this task attempt');
      this.db.prepare('INSERT OR IGNORE INTO prompt_dispatches(task_id,attempt,prompt_id,created_at) VALUES(?,?,?,?)').run(prompt.task_id, Number(task.attempt) + 1, id, now());
      if (this.db.prepare("UPDATE prompts SET delivery_status='DELIVERING' WHERE id=? AND delivery_status=? AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=prompts.task_id AND status='QUEUED')").run(id, prompt.delivery_status).changes !== 1) throw new BridgeError('CONFLICT', 'Concurrent delivery refused');
    });
    try {
      // Transport must deduplicate by this stable key, including after uncertain failures.
      const receipt = await bounded(signal => this.delivery.deliver(String(prompt.content), id, signal, destination), this.timeoutMs);
      if (!isDemoDatabase(this.db)) new ConversationRegistry(this.db, this.authority).assertExecution(String(prompt.task_id), receipt.codexConversationId, receipt.workspacePath);
      if (typeof receipt.executionId !== 'string' || receipt.executionId.length > 4096) throw new BridgeError('EXECUTION', 'Invalid execution receipt'); requireNoSecrets(receipt.executionId);
      if (!receipt.executionId) throw new BridgeError('EXECUTION', 'Transport returned no execution receipt');
      transaction(this.db, () => {
        if (this.db.prepare("UPDATE prompts SET delivery_status='DELIVERED',codex_execution_id=?,codex_conversation_id=?,error_code=NULL WHERE id=? AND delivery_status='DELIVERING'").run(receipt.executionId, receipt.codexConversationId ?? null, id).changes !== 1) throw new BridgeError('CONFLICT', 'Delivery receipt conflict');
        this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), this.authority.resolve(context)!.principal, 'prompt_delivered', `prompt=${id}`);
      }); return receipt;
    } catch (error) {
      // Unknown external outcome is not safe to retry automatically.
      this.db.prepare("UPDATE prompts SET error_code='DELIVERY_UNCERTAIN' WHERE id=? AND delivery_status='DELIVERING'").run(id);
      throw error;
    }
  }
  recoverDelivery(id: string, context: CallerContext, confirmedNotDelivered: boolean): void {
    const caller=this.authority.resolve(context);
    if (!caller?.reviewer || caller.controller || caller.executor==='codex') throw new BridgeError('AUTH', 'Independent reviewer capability required for recovery');
    if (!confirmedNotDelivered) throw new BridgeError('CONFLICT', 'External outcome must be independently checked before retry');
    transaction(this.db, () => {
      if (this.db.prepare("UPDATE prompts SET delivery_status='FAILED' WHERE id=? AND delivery_status='DELIVERING'").run(id).changes !== 1) throw new BridgeError('CONFLICT', 'Prompt is not awaiting delivery recovery');
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), this.authority.resolve(context)!.principal, 'prompt_recovery', `prompt=${id}`);
    });
  }
}
