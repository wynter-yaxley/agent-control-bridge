import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { transaction, now } from './db.ts';
import { BridgeError } from './errors.ts';
import { requireNoSecrets } from './security.ts';
import { ConversationRegistry } from './topology.ts';
import { isDemoDatabase } from './demo-scope.ts';
export interface Generation {
  content: string; sourceConversationId?: string; sourceConversationName?: string; sourceMessageId: string; actualModel: string | null; actualReasoningEffort: string | null;
}
// Adapter objects are installed by trusted host code, never deserialized from CLI/Agent JSON.
export interface ChatgptAdapter {
  readonly source: 'chatgpt' | 'mock-chatgpt';
  readonly conversationId?: string;
  readonly conversationName?: string;
  capabilities(): Promise<{ models: string[]; reasoningEfforts: string[]; verified: boolean }>;
  generate(requirement: string, options: { model: string; reasoningEffort: string; signal: AbortSignal }): Promise<Generation>;
}
export interface CodexDelivery {
  target?(signal: AbortSignal): Promise<{codexConversationId:string; workspacePath:string}>;
  deliver(content: string, key: string, signal: AbortSignal): Promise<{ executionId: string; codexConversationId?: string; workspacePath?: string }>;
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
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new BridgeError('CONFIG', 'Invalid adapter timeout'); this.timeoutMs = timeoutMs;
    this.db = db; this.authority = authority; this.adapter = adapter; this.requested = requested; this.delivery = delivery;
  }
  private controller(context: CallerContext): void {
    const caller = this.authority.resolve(context);
    if (!caller || caller.executor !== 'hermes' || !caller.reviewer) throw new BridgeError('AUTH', 'Trusted Hermes controller context required');
    if (this.adapter.source === 'mock-chatgpt' && !isDemoDatabase(this.db)) throw new BridgeError('PROVENANCE', 'Mock adapters require a freshly created isolated Demo database');
  }
  async generate(taskId: string, requirement: string, context: CallerContext): Promise<string> {
    this.controller(context);
    const task = this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
    if (!task || task.status !== 'QUEUED') throw new BridgeError('STATE', 'Prompt generation requires an existing QUEUED task');
    if (!requirement.trim() || requirement.length > 65536) throw new BridgeError('INPUT', 'Invalid requirement'); requireNoSecrets(requirement);
    const registry = new ConversationRegistry(this.db, this.authority);
    const mapping = !isDemoDatabase(this.db) ? registry.forTask(taskId) : null;
    if(mapping && this.adapter.conversationId!==mapping.chatgpt_conversation_id) throw new BridgeError('PROVENANCE','Adapter target does not match the registered GPT conversation');
    if(mapping && (this.adapter.conversationName!==mapping.project_name||mapping.chatgpt_conversation_name!==mapping.project_name)) throw new BridgeError('PROVENANCE','GPT conversation name must match the workspace project name');
    const capabilities = await bounded(() => this.adapter.capabilities(), this.timeoutMs);
    if (!capabilities.verified || !capabilities.models.includes(this.requested.model) || !capabilities.reasoningEfforts.includes(this.requested.reasoningEffort)) throw new BridgeError('UNSUPPORTED', 'Requested model/reasoning cannot be verified by the adapter');
    const result = await bounded(signal => this.adapter.generate(requirement, { ...this.requested, signal }), this.timeoutMs);
    if (!result.content.trim() || result.content.length > 65536 || !result.sourceMessageId) throw new BridgeError('PROVENANCE', 'Generation has no verifiable source message');
    requireNoSecrets(result.content); requireNoSecrets(result.sourceMessageId);
    if (result.sourceMessageId.length > 4096 || (mapping && result.sourceConversationId !== mapping.chatgpt_conversation_id)) throw new BridgeError('PROVENANCE', 'Generation belongs to another GPT conversation');
    if(mapping && result.sourceConversationName!==mapping.project_name) throw new BridgeError('PROVENANCE','Generation conversation name no longer matches the workspace project');
    const mock = this.adapter.source === 'mock-chatgpt';
    const verified = mock || (result.actualModel === this.requested.model && result.actualReasoningEffort === this.requested.reasoningEffort);
    const id = randomUUID(), hash = promptHash(result.content);
    return transaction(this.db, () => {
      if (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status !== 'QUEUED') throw new BridgeError('CONFLICT', 'Task changed during generation');
      const existing = this.db.prepare('SELECT id FROM prompts WHERE task_id=? AND prompt_hash=?').get(taskId, hash);
      if (existing) return String(existing.id);
      this.db.prepare(`INSERT INTO prompts(id,task_id,source,requested_model,actual_model,requested_reasoning,actual_reasoning,generated_at,prompt_hash,content,source_message_id,verified,delivery_status,source_conversation_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, this.adapter.source, this.requested.model, result.actualModel, this.requested.reasoningEffort, result.actualReasoningEffort, now(), hash, result.content, result.sourceMessageId, verified ? 1 : 0, verified ? 'PENDING' : 'REVIEW_REQUIRED', result.sourceConversationId ?? null);
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), this.authority.resolve(context)!.principal, 'prompt_generated', `prompt=${id} hash=${hash} source=${this.adapter.source}`);
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
    if(!isDemoDatabase(this.db)) {
      if(!this.delivery.target) throw new BridgeError('PROVENANCE','Codex destination must be independently resolved before sending');
      const destination=await bounded(signal=>this.delivery.target!(signal),this.timeoutMs);
      new ConversationRegistry(this.db,this.authority).assertExecution(String(prompt.task_id),destination.codexConversationId,destination.workspacePath);
    }
    if (this.db.prepare("UPDATE prompts SET delivery_status='DELIVERING' WHERE id=? AND delivery_status=? AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=prompts.task_id AND status='QUEUED')").run(id, prompt.delivery_status).changes !== 1) throw new BridgeError('CONFLICT', 'Concurrent delivery refused');
    try {
      // Transport must deduplicate by this stable key, including after uncertain failures.
      const receipt = await bounded(signal => this.delivery.deliver(String(prompt.content), id, signal), this.timeoutMs);
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
    this.controller(context);
    if (!confirmedNotDelivered) throw new BridgeError('CONFLICT', 'External outcome must be independently checked before retry');
    transaction(this.db, () => {
      if (this.db.prepare("UPDATE prompts SET delivery_status='FAILED' WHERE id=? AND delivery_status='DELIVERING'").run(id).changes !== 1) throw new BridgeError('CONFLICT', 'Prompt is not awaiting delivery recovery');
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), this.authority.resolve(context)!.principal, 'prompt_recovery', `prompt=${id}`);
    });
  }
}
