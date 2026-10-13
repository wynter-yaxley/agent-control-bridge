import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { now, transaction, uuid, processOwner, ownerAlive } from './db.ts';
import { BridgeError } from './errors.ts';
import { withDeadline } from './deadline.ts';
import { ConversationRegistry } from './topology.ts';
import { promptHash, type DeliveryTarget } from './prompts.ts';
import { TaskStore } from './tasks.ts';
import { isDemoDatabase } from './demo-scope.ts';
import { requireNoSecrets } from './security.ts';

export interface BackgroundExecutor {
  readonly durable?: boolean;
  readonly mode: 'codex-exec' | 'codex-app-server' | 'codex-desktop' | 'mock';
  inspect(target: DeliveryTarget, signal: AbortSignal): Promise<{ source: 'codex-app-state'; conversationId: string; appProjectId: string; workspacePath: string; local: boolean }>;
  execute(content: string, key: string, target: DeliveryTarget, signal: AbortSignal, onEvent?: (event: Record<string, unknown>) => void): Promise<{ executionId: string; codexConversationId: string; workspacePath: string; running?: boolean; output?: { content: string; messageIds: string[] } }>;
  observeExecution?(content: string, target: DeliveryTarget, startedAfter: string, signal: AbortSignal, original?: {executionId?: string; dispatchId: string}): ReturnType<BackgroundExecutor['execute']>;
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
      if(this.executor.mode==='codex-desktop' && this.db.prepare("SELECT 1 FROM project_operations WHERE state='PROVISIONING'").get())throw new BridgeError('CONFLICT','The GUI is occupied');
      if(this.db.prepare("SELECT 1 FROM execution_runs WHERE state='RUNNING' OR (state='UNCERTAIN' AND project_id=?)").get(mapping.project_id))throw new BridgeError('CONFLICT','Backend capacity or the target workspace is occupied');
      const claimed = store.claim(taskId, context, this.options.leaseSeconds, current.version, promptId);
      if (!claimed.ok) throw new BridgeError(claimed.code as import('./errors.ts').ErrorCode, claimed.error);
      if (this.db.prepare('SELECT 1 FROM prompt_dispatches WHERE task_id=? AND attempt=?').get(taskId, claimed.task.attempt)) throw new BridgeError('CONFLICT', 'This attempt already owns an external dispatch');
      this.db.prepare('INSERT INTO prompt_dispatches(task_id,attempt,prompt_id,created_at) VALUES(?,?,?,?)').run(taskId, claimed.task.attempt, promptId, now());
      this.db.prepare("INSERT INTO execution_runs(id,task_id,attempt,prompt_id,project_id,holder,instance,conversation_id,workspace_path,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'RUNNING',?,?)").run(runId, taskId, claimed.task.attempt, promptId, mapping.project_id, caller.principal, caller.instance, target.codexConversationId, target.workspacePath, now(), now());
      if (this.db.prepare("UPDATE prompts SET delivery_status='DELIVERING' WHERE id=? AND delivery_status='PENDING'").run(promptId).changes !== 1) throw new BridgeError('CONFLICT', 'Prompt dispatch changed during claim');
      return claimed.task.attempt;
    });
    const renew=()=>{
      const task=store.getTask(taskId)!;
      const result=store.renew(taskId,context,this.options.leaseSeconds,task.version);
      if(!result.ok)throw new BridgeError(result.code as import('./errors.ts').ErrorCode,result.error);
    };
    const controller=new AbortController();
    let renewalError: unknown;
    const heartbeat=setInterval(()=>{try{renew();}catch(error){renewalError=error;controller.abort();}},Math.max(100,this.options.leaseSeconds*1000/3));
    this.db.prepare('UPDATE execution_runs SET owner_token=? WHERE id=?').run(processOwner(),runId);
    try {
      let sequence = 0;
      const onEvent = (event: Record<string, unknown>) => {
        const current = store.getTask(taskId);
        if (!current || current.status !== 'RUNNING' || current.attempt !== attempt || current.claimed_by !== caller.principal || current.claimed_instance !== caller.instance || !current.claim_expires_at || current.claim_expires_at <= now()) throw new BridgeError('CONFLICT', 'Execution event belongs to an expired attempt');
        const kind = typeof event.type === 'string' && /^[a-z_.]{1,100}$/.test(event.type) ? event.type : 'unknown';
        if(event.type==='turn.started' && typeof event.turnId==='string')this.db.prepare('UPDATE execution_runs SET execution_id=? WHERE id=?').run(event.turnId,runId);
        this.db.prepare('INSERT INTO execution_events(run_id,sequence,kind,observed_at) VALUES(?,?,?,?)').run(runId, ++sequence, kind, now());
      };
      const receipt = this.executor.durable ? await this.executor.execute(String(prompt.content),runId,target,controller.signal,onEvent) : await withDeadline(signal => this.executor.execute(String(prompt.content),runId,target,signal,onEvent),this.options.timeoutMs);
      if(renewalError)throw renewalError;
      this.finishRun(runId,context,receipt);
      return runId;
    } catch (error) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE execution_runs SET state='UNCERTAIN',error_code=?,updated_at=? WHERE id=? AND state='RUNNING'").run(error instanceof BridgeError ? error.code : 'IO', now(), runId);
        this.db.prepare("UPDATE prompts SET error_code='EXECUTION_UNCERTAIN' WHERE id=? AND delivery_status='DELIVERING'").run(promptId);
      });
      throw error;
    } finally {clearInterval(heartbeat);}
  }
  async reconcile(runId:string,context:CallerContext):Promise<boolean> {
    const caller=this.authority.resolve(context),run=this.db.prepare('SELECT * FROM execution_runs WHERE id=?').get(runId);
    if(!run || !['UNCERTAIN','RUNNING'].includes(String(run.state)) || caller?.executor!=='codex' || caller.controller || caller.reviewer || run.holder!==caller.principal || run.instance!==caller.instance)throw new BridgeError('AUTH','The original trusted executor must reconcile this uncertain run');
    if(run.owner_token!==processOwner() && ownerAlive(run.owner_token as string | null)===true)throw new BridgeError('CONFLICT','The original executor process is still alive');
    if(!this.executor.observeExecution)throw new BridgeError('UNSUPPORTED','Executor cannot observe completion without sending');
    const prompt=this.db.prepare('SELECT content,prompt_hash,verified FROM prompts WHERE id=?').get(run.prompt_id)!;
    if(prompt.verified!==1 || promptHash(String(prompt.content))!==prompt.prompt_hash)throw new BridgeError('PROVENANCE','Original execution prompt changed');
    const receipt=await withDeadline(signal=>this.executor.observeExecution!(String(prompt.content),{codexConversationId:String(run.conversation_id),workspacePath:String(run.workspace_path)},String(run.created_at),signal,{executionId:run.execution_id==null?undefined:String(run.execution_id),dispatchId:runId}),this.options.timeoutMs);
    new ConversationRegistry(this.db,this.authority).assertExecution(String(run.task_id),receipt.codexConversationId,receipt.workspacePath);
    if(run.execution_id!=null && receipt.executionId!==run.execution_id)throw new BridgeError('PROVENANCE','Original execution ID changed');
    if(receipt.running){this.db.prepare("UPDATE execution_runs SET state='RUNNING',execution_id=?,error_code='RUNNING_OBSERVED',updated_at=? WHERE id=?").run(receipt.executionId,now(),runId);return false;}
    this.finishRun(runId,context,receipt);return true;
  }
  private finishRun(runId:string,context:CallerContext,receipt:Awaited<ReturnType<BackgroundExecutor['execute']>>):void {
    const run=this.db.prepare('SELECT * FROM execution_runs WHERE id=?').get(runId)!;
    new ConversationRegistry(this.db,this.authority).assertExecution(String(run.task_id),receipt.codexConversationId,receipt.workspacePath);
    if((run.execution_id!=null && receipt.executionId!==run.execution_id) || receipt.codexConversationId!==run.conversation_id || !receipt.executionId.trim() || receipt.executionId.length>4096)throw new BridgeError('PROVENANCE','Codex execution receipt has a different identity');
    requireNoSecrets(receipt.executionId);
    if(!receipt.output && !isDemoDatabase(this.db))throw new BridgeError('PROVENANCE','A complete original result and message IDs are required before delivery');
    if(receipt.output){if(!receipt.output.content.trim() || receipt.output.content.length>65536 || !receipt.output.messageIds.length)throw new BridgeError('PROVENANCE','Completed execution output is incomplete');requireNoSecrets(JSON.stringify(receipt.output));}
    transaction(this.db,()=>{
      const store=new TaskStore(this.db,this.authority),current=store.getTask(String(run.task_id));
      if(!current || current.attempt!==run.attempt || current.execution_prompt_id!==run.prompt_id)throw new BridgeError('CONFLICT','Execution attempt changed');
      if(current.claimed_by!==run.holder || current.claimed_instance!==run.instance)throw new BridgeError('CONFLICT','Original execution holder changed');
      if(run.state==='UNCERTAIN' || run.error_code==='RUNNING_OBSERVED') {
        this.db.prepare("UPDATE tasks SET claim_expires_at=?,version=version+1 WHERE id=? AND version=? AND status='RUNNING'").run(new Date(Date.now()+this.options.leaseSeconds*1000).toISOString(),current.id,current.version);
      }
      const finished=store.executorFinished(current.id,context,'Background execution completed; independent acceptance required',store.getTask(current.id)!.version);
      if(!finished.ok)throw new BridgeError(finished.code as import('./errors.ts').ErrorCode,finished.error);
      this.db.prepare("UPDATE prompts SET delivery_status='DELIVERED',codex_execution_id=?,codex_conversation_id=?,error_code=NULL WHERE id=? AND delivery_status='DELIVERING'").run(receipt.executionId,receipt.codexConversationId,run.prompt_id);
      this.db.prepare("UPDATE execution_runs SET state='WAITING_APPROVAL',execution_id=?,result_json=?,error_code=NULL,updated_at=? WHERE id=? AND state IN ('RUNNING','UNCERTAIN')").run(receipt.executionId,receipt.output?JSON.stringify({...receipt.output,hash:promptHash(receipt.output.content)}):null,now(),runId);
    });
  }
}
