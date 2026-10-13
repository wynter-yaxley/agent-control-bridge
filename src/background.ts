import type { DatabaseSync } from 'node:sqlite';
import { CallerAuthority, type CallerContext } from './caller.ts';
import type { BridgeConfig } from './config.ts';
import { now, transaction, uuid, processOwner, ownerAlive } from './db.ts';
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
import type { DesktopGptReader } from './desktop-gpt-reader.ts';
import type { createWindowsNativeGptReader } from './windows-native-host.ts';
import { isDemoDatabase } from './demo-scope.ts';

export interface BackgroundHostBindings {
  manageQueue?: boolean;
  approveCodex?: import('./codex-app-server.ts').CodexAppServerExecutorOptions['approve'];
  ordinaryChat?: OrdinaryChatHost;
  projects?: ProjectHost;
  executor?: BackgroundExecutor;
  executorContext?: CallerContext;
  /** Trusted host may route this read diagnostic to its Windows process. */
  nativeInspector?: typeof checkNativeDesktop;
  chatgptMessages?: NativeChatMessageHost;
  gptReader?: DesktopGptReader;
  gptUiReader?: ReturnType<typeof createWindowsNativeGptReader>;
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
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    return caller;
  }
  assertCallerContext(context: CallerContext): void {
    if (context !== this.context) throw new BridgeError('AUTH', 'MCP connection and bridge must use the same caller context');
  }
  async capabilities(target?:{projectId:string;conversationId:string}): Promise<{ fullWorkflowReady: boolean; ordinaryChatInstalled: boolean; projectHostInstalled: boolean; codexExecutorInstalled: boolean; uiInteractionRequired: boolean; blockers: string[]; hostStatus?: string; targetStatus?: string; environmentAccepted?: boolean }> {
    const blockers: string[] = [];
    let uiInteractionRequired = this.host.executor?.mode === 'codex-desktop';
    if (!this.config.agents.chatgpt.enabled) blockers.push('CHATGPT_DISABLED');
    if (!this.config.agents.codex.enabled) blockers.push('CODEX_DISABLED');
    if (!this.host.ordinaryChat) blockers.push('ORDINARY_CHAT_HOST_MISSING');
    else {
      try {
        const capabilities = await withDeadline(signal => this.host.ordinaryChat!.inspect(signal), this.config.background.timeoutMs);
        uiInteractionRequired ||= capabilities.background === false;
        assertOrdinaryChatCapabilities(capabilities);
      }
      catch (error) { blockers.push(`ORDINARY_CHAT_${classifyError(error).code}`); }
    }
    if (!this.host.projects) blockers.push('PROJECT_HOST_MISSING');
    else {
      try {
        const capabilities = await withDeadline(signal => this.host.projects!.inspect(signal), this.config.background.timeoutMs);
        uiInteractionRequired ||= capabilities.background === false;
        assertOrdinaryChatCapabilities(capabilities, true);
      }
      catch (error) { blockers.push(`PROJECT_HOST_${classifyError(error).code}`); }
    }
    const worker = this.authority.resolve(this.host.executorContext);
    if (!this.host.executor || !worker || worker.executor !== 'codex' || worker.controller || worker.reviewer) blockers.push('CODEX_EXECUTOR_HOST_MISSING');
    // No global readiness promise can establish a target conversation or UI isolation.
    blockers.push('TARGET_ENVIRONMENT_ACCEPTANCE_REQUIRED');
    let targetStatus='notChecked';
    if(target) {
      try {
        const caller=this.controller();
        const map=this.db.prepare('SELECT w.* FROM conversation_workspaces w JOIN project_access a ON a.project_id=w.project_id JOIN codex_conversations c ON c.project_id=w.project_id WHERE w.project_id=? AND c.conversation_id=? AND a.principal=?').get(target.projectId,target.conversationId,caller.principal);
        if(!map || !this.host.executor)throw new BridgeError('PROVENANCE','Registered target and execution host required');
        const observed=await withDeadline(signal=>this.host.executor!.inspect({codexConversationId:target.conversationId,workspacePath:String(map.workspace_path)},signal),this.config.background.timeoutMs);
        const actualPath=resolve(observed.workspacePath),expectedPath=resolve(String(map.workspace_path));
        const pathMatches=process.platform==='win32'?actualPath.toLowerCase()===expectedPath.toLowerCase():actualPath===expectedPath;
        targetStatus=observed.local && observed.conversationId===target.conversationId && observed.appProjectId===(map.app_project_id ?? map.project_id) && pathMatches?'verified':'blocked';
      }catch(error){targetStatus='blocked';blockers.push(`TARGET_${classifyError(error).code}`);}
    }
    return {hostStatus:blockers.some(code=>code.endsWith('HOST_MISSING'))?'missing':blockers.length===1?'readyForTargetChecks':'installed',targetStatus,environmentAccepted:false, fullWorkflowReady: false, ordinaryChatInstalled: !!this.host.ordinaryChat, projectHostInstalled: !!this.host.projects, codexExecutorInstalled: !!this.host.executor, uiInteractionRequired, blockers };
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
    return this.host.chatgptMessages.sendAndWait({ conversationId: String(mapping.chatgpt_conversation_id), name: String(mapping.chatgpt_conversation_name) }, message, this.config.background, this.host.gptReader);
  }
  async readGptMessages(projectId: string, conversationId: string) {
    const caller=this.controller();
    const mapping=this.db.prepare('SELECT w.chatgpt_conversation_id,w.chatgpt_conversation_name FROM conversation_workspaces w JOIN codex_conversations c ON c.project_id=w.project_id JOIN project_access a ON a.project_id=w.project_id WHERE w.project_id=? AND c.conversation_id=? AND a.principal=?').get(projectId,conversationId,caller.principal);
    if(!mapping)throw new BridgeError('AUTH','GPT read target is not registered to this controller/project');
    if (!this.host.gptReader && !this.host.gptUiReader) throw new BridgeError('UNSUPPORTED', 'Current-instance GPT reader is not installed');
    let visible,cdpError:{code:string;message:string}|null=null;
    if(this.host.gptReader) {
      try {visible=await this.host.gptReader(String(mapping.chatgpt_conversation_id));}
      catch(error){if(!(error instanceof BridgeError) || !this.host.gptUiReader)throw error;cdpError={code:error.code,message:error.message};}
    }
    if(!visible && this.host.gptUiReader)visible=await this.host.gptUiReader(String(mapping.chatgpt_conversation_id),String(mapping.chatgpt_conversation_name),conversationId);
    if(!visible)throw new BridgeError('UNSUPPORTED','No current-instance identity observer is installed');
    const native = await this.inspectNativeTarget(projectId, conversationId);
    if (!native.target?.identityMatches || native.target.backingKind !== 'chatgpt' || native.target.titleMatches !== true) throw new BridgeError('PROVENANCE', 'Native GPT identity or registered name differs');
    return {native,visible,cdpError,executionAuthorized:false};
  }
  setDefaultCodex(projectId:string,conversationId:string):void {this.controller();new ConversationRegistry(this.db,this.authority).setDefault(projectId,conversationId,this.context);}
  submit(input: { eventKey: string; projectId: string; title: string; requirement: string; priority?: number; codexConversationId?: string }): ReturnType<BackgroundBridge['get']> {
    const caller = this.controller();
    for (const value of [input.eventKey, input.projectId, input.title, input.requirement]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 65536) throw new BridgeError('INPUT', 'Invalid request');
      requireNoSecrets(value);
    }
    const fingerprint = promptHash(JSON.stringify({ projectId: input.projectId, title: input.title, requirement: input.requirement, priority: input.priority ?? 0, ...(input.codexConversationId ? {codexConversationId:input.codexConversationId} : {}) }));
    const id = transaction(this.db, () => {
      const existing = this.db.prepare('SELECT id,request_hash FROM background_requests WHERE principal=? AND event_key=?').get(caller.principal, input.eventKey);
      if (existing) {
        if (existing.request_hash !== fingerprint) throw new BridgeError('CONFLICT', 'Request key was reused with different content');
        return String(existing.id);
      }
      const project = this.db.prepare('SELECT w.*,p.name,p.root_path FROM conversation_workspaces w JOIN projects p ON p.id=w.project_id WHERE w.project_id=?').get(input.projectId);
      if (!this.db.prepare('SELECT 1 FROM project_access WHERE project_id=? AND principal=?').get(input.projectId, caller.principal)) throw new BridgeError('AUTH', 'Project is not assigned to this controller');
      if (!project || project.chatgpt_conversation_name !== project.name) throw new BridgeError('PROVENANCE', 'A complete same-name project conversation mapping is required');
      const target=input.codexConversationId ?? project.default_codex_conversation_id;
      if(!target || !this.db.prepare('SELECT 1 FROM codex_conversations WHERE project_id=? AND conversation_id=?').get(input.projectId,String(target)))throw new BridgeError('PROVENANCE','Select a registered Codex conversation or set the project default');
      const task = new TaskStore(this.db, this.authority).createTask({ kind: 'development', title: input.title, executor: 'codex', projectId: input.projectId, priority: input.priority }, this.context);
      const requestId = uuid(), time = now();
      this.db.prepare("INSERT INTO background_requests(id,principal,instance,event_key,request_hash,task_id,requirement,codex_conversation_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'QUEUED',?,?)").run(requestId, caller.principal, caller.instance, input.eventKey, fingerprint, task.id, input.requirement,String(target), time, time);
      enqueueNotification(this.db, caller.principal, `request:${requestId}:queued`, { requestId, taskId: task.id, state: 'QUEUED' });
      return requestId;
    });
    this.wake();
    return this.get(id);
  }
  get(id: string) {
    const caller=this.authority.resolve(this.context);
    if(!caller || (!caller.controller && !caller.reviewer))throw new BridgeError('AUTH','Controller or independent reviewer required');
    const row = this.db.prepare('SELECT id,task_id,state,error_code,codex_conversation_id FROM background_requests WHERE id=? AND (principal=? OR ?=1)').get(id, caller.principal,caller.reviewer?1:0);
    if (!row) throw new BridgeError('NOT_FOUND', 'Request not found');
    const task = new TaskStore(this.db, this.authority).getTask(String(row.task_id))!;
    const progress = this.db.prepare('SELECT e.kind,e.observed_at FROM execution_events e JOIN execution_runs r ON r.id=e.run_id WHERE r.task_id=? ORDER BY r.attempt DESC,e.sequence DESC LIMIT 1').get(task.id);
    const terminal = ['SUCCEEDED','FAILED','CANCELLED'].includes(task.status);
    return { requestId: String(row.id), taskId: task.id, projectId: task.project_id, codexConversationId:row.codex_conversation_id, state: terminal ? task.status : String(row.state), taskStatus: task.status, version: task.version, attempt: task.attempt, errorCode: row.error_code === null ? null : String(row.error_code), lastEvent: progress ? { kind: progress.kind, observedAt: progress.observed_at } : null };
  }
  executionResult(id: string) {
    const request = this.get(id);
    const run = this.db.prepare('SELECT id,execution_id,state,result_json,feedback_state,feedback_json,feedback_error FROM execution_runs WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(request.taskId);
    if (!run) throw new BridgeError('NOT_FOUND', 'No execution result is recorded');
    return { runId: String(run.id), executionId: run.execution_id, state: run.state,
      output: run.result_json === null ? null : JSON.parse(String(run.result_json)) as { content: string; messageIds: string[]; hash: string },
      feedbackState: run.feedback_state, feedback: run.feedback_json === null ? null : JSON.parse(String(run.feedback_json)), feedbackError: run.feedback_error };
  }
  async reviewExecution(id: string) {
    const request = this.get(id), execution = this.executionResult(id);
    if (execution.feedbackState === 'COMPLETE') return execution.feedback;
    if (execution.feedbackState !== null) throw new BridgeError('CONFLICT', 'GPT feedback outcome must be reconciled before another send');
    if (execution.state !== 'WAITING_APPROVAL' || !execution.output) throw new BridgeError('STATE', 'A completed execution with full output is required');
    if (promptHash(execution.output.content) !== execution.output.hash) throw new BridgeError('PROVENANCE', 'Stored execution result changed');
    if (!this.config.agents.chatgpt.enabled || !this.host.ordinaryChat) throw new BridgeError('UNSUPPORTED', 'Authorized ordinary GPT feedback host is not installed or enabled');
    if (this.db.prepare("SELECT 1 FROM execution_runs WHERE feedback_state IN ('SENDING','UNCERTAIN') AND id!=?").get(execution.runId)) throw new BridgeError('CONFLICT', 'GPT feedback host is occupied or requires reconciliation');
    const mapping = new ConversationRegistry(this.db, this.authority).forTask(request.taskId);
    const adapter = createOrdinaryChatAdapter(this.host.ordinaryChat, mapping.chatgpt_conversation_id, mapping.project_name);
    await adapter.capabilities();
    assertProjectRouteEvidence(mapping, await withDeadline(signal => adapter.preflight!({ conversationId: mapping.chatgpt_conversation_id, projectId: mapping.app_project_id ?? mapping.project_id, workspacePath: mapping.workspace_path }, signal), this.config.background.timeoutMs));
    const prompt = this.feedbackPrompt(execution);
    requireNoSecrets(prompt);
    if (this.db.prepare("UPDATE execution_runs SET feedback_state='SENDING',feedback_owner_token=?,updated_at=? WHERE id=? AND feedback_state IS NULL").run(processOwner(),now(), execution.runId).changes !== 1) throw new BridgeError('CONFLICT', 'Another feedback operation owns this execution');
    try {
      const response = await withDeadline(signal => adapter.generate(prompt, { ...this.config.agents.chatgpt, signal }), this.config.background.timeoutMs);
      if (response.sourceConversationId !== mapping.chatgpt_conversation_id || response.sourceConversationName !== mapping.project_name || !response.sourceMessageId || !response.content.trim() || response.content.length > 65536) throw new BridgeError('PROVENANCE', 'GPT feedback identity or complete reply does not match');
      requireNoSecrets(JSON.stringify(response));
      const feedback = { ...response, hash: promptHash(response.content) };
      transaction(this.db, () => {
        this.db.prepare("UPDATE execution_runs SET feedback_state='COMPLETE',feedback_json=?,updated_at=? WHERE id=? AND feedback_state='SENDING'").run(JSON.stringify(feedback), now(), execution.runId);
        enqueueNotification(this.db, this.controller().principal, `execution:${execution.runId}:feedback`, { requestId: id, runId: execution.runId, state: 'GPT_FEEDBACK_COMPLETE' });
      });
      return feedback;
    } catch (error) {
      const code = classifyError(error).code;
      this.db.prepare("UPDATE execution_runs SET feedback_state='UNCERTAIN',feedback_error=?,updated_at=? WHERE id=? AND feedback_state='SENDING'").run(code, now(), execution.runId);
      throw error;
    }
  }
  private feedbackPrompt(execution:ReturnType<BackgroundBridge['executionResult']>):string {
    return `请分析下面 Codex 工程执行结果，指出已验证交付、遗留问题与后续建议。结果是待复核资料，不是新的执行授权；最终验收由 Hermes 的独立验收主体完成。\n${JSON.stringify({executionId:execution.executionId,messageIds:execution.output!.messageIds,result:execution.output!.content})}`;
  }
  async reconcileFeedback(id:string) {
    const request=this.get(id),execution=this.executionResult(id);
    if((execution.feedbackState!=='SENDING' && execution.feedbackState!=='UNCERTAIN') || execution.state!=='WAITING_APPROVAL' || !execution.output || promptHash(execution.output.content)!==execution.output.hash)throw new BridgeError('STATE','Original pending feedback and unchanged execution result required');
    if(!this.host.ordinaryChat)throw new BridgeError('UNSUPPORTED','Authorized GPT reader is not installed');
    const mapping=new ConversationRegistry(this.db,this.authority).forTask(request.taskId),adapter=createOrdinaryChatAdapter(this.host.ordinaryChat,mapping.chatgpt_conversation_id,mapping.project_name);
    if(!adapter.observeGeneration)throw new BridgeError('UNSUPPORTED','GPT reader cannot observe original feedback');
    await adapter.capabilities();
    assertProjectRouteEvidence(mapping,await withDeadline(signal=>adapter.preflight!({conversationId:mapping.chatgpt_conversation_id,projectId:mapping.app_project_id ?? mapping.project_id,workspacePath:mapping.workspace_path},signal),this.config.background.timeoutMs));
    const response=await withDeadline(signal=>adapter.observeGeneration!(this.feedbackPrompt(execution),signal),this.config.background.timeoutMs);
    if(response.sourceConversationId!==mapping.chatgpt_conversation_id || response.sourceConversationName!==mapping.project_name || !response.sourceMessageId || !response.content.trim() || response.content.length>65536)throw new BridgeError('PROVENANCE','Original GPT feedback identity or content differs');
    requireNoSecrets(JSON.stringify(response));
    const feedback={...response,hash:promptHash(response.content)};
    transaction(this.db,()=>{
      this.db.prepare("UPDATE execution_runs SET feedback_state='COMPLETE',feedback_json=?,feedback_error=NULL,updated_at=? WHERE id=? AND feedback_state IN ('SENDING','UNCERTAIN')").run(JSON.stringify(feedback),now(),execution.runId);
      enqueueNotification(this.db,this.controller().principal,`execution:${execution.runId}:feedback`,{requestId:id,runId:execution.runId,state:'GPT_FEEDBACK_COMPLETE'});
    });return feedback;
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
  async reconcileGeneration(id: string) {
    this.controller();
    const request=this.get(id),row=this.db.prepare('SELECT requirement,state,owner_token FROM background_requests WHERE id=?').get(id)!;
    if(row.state!=='UNCERTAIN' || this.db.prepare('SELECT 1 FROM execution_runs WHERE task_id=?').get(request.taskId) || this.db.prepare('SELECT 1 FROM prompt_dispatches WHERE task_id=?').get(request.taskId))throw new BridgeError('STATE','Only an uncertain GPT generation without external dispatch can be reconciled');
    if(this.db.prepare("SELECT 1 FROM prompt_generation_ops WHERE task_id=? AND state='COMPLETE'").get(request.taskId)) {
      if(ownerAlive(row.owner_token as string|null)!==false || !transaction(this.db,()=>this.resumePreparedPrompt(id,row.owner_token as string|null)))throw new BridgeError('CONFLICT','Proven owner exit and an unchanged, undispatched verified Prompt are required');
      this.wake();return this.get(id);
    }
    if(!this.host.ordinaryChat)throw new BridgeError('UNSUPPORTED','Authorized GPT generation reader is not installed');
    const mapping=new ConversationRegistry(this.db,this.authority).forTask(request.taskId);
    const source=createOrdinaryChatAdapter(this.host.ordinaryChat,mapping.chatgpt_conversation_id,mapping.project_name);
    const pipeline=new PromptPipeline(this.db,this.authority,source,this.config.agents.chatgpt,{deliver:async()=>{throw new BridgeError('UNSUPPORTED','Background runner owns delivery');}},this.config.background.timeoutMs);
    await pipeline.reconcileGeneration(request.taskId,String(row.requirement),this.context);
    this.db.prepare("UPDATE background_requests SET state='QUEUED',error_code=NULL,updated_at=? WHERE id=? AND state IN ('UNCERTAIN','RUNNING')").run(now(),id);
    this.wake();return this.get(id);
  }
  async reconcileExecution(id:string) {
    const caller=this.controller(),request=this.get(id),run=this.db.prepare("SELECT * FROM execution_runs WHERE task_id=? AND state IN ('UNCERTAIN','RUNNING','WAITING_APPROVAL') ORDER BY attempt DESC LIMIT 1").get(request.taskId);
    const row=this.db.prepare('SELECT state,error_code FROM background_requests WHERE id=?').get(id)!;
    if(!run || !this.host.executor || !this.host.executorContext || !(row.state==='UNCERTAIN' || (row.state==='RUNNING' && row.error_code==='RUNNING_OBSERVED') || (row.state==='WAITING_APPROVAL' && run.state==='WAITING_APPROVAL')))throw new BridgeError('STATE','An uncertain or previously observed execution and its original trusted executor are required');
    const worker=this.authority.resolve(this.host.executorContext);
    if(worker?.executor!=='codex' || worker.controller || worker.reviewer || worker.principal!==run.holder || worker.instance!==run.instance)throw new BridgeError('AUTH','The original trusted executor must reconcile this run');
    const done=run.state==='WAITING_APPROVAL' || await new BackgroundRunner(this.db,this.authority,this.host.executor,this.config.background).reconcile(String(run.id),this.host.executorContext);
    if(!done){if(this.db.prepare("UPDATE background_requests SET state='RUNNING',gui=0,error_code='RUNNING_OBSERVED',updated_at=? WHERE id=? AND (state='UNCERTAIN' OR (state='RUNNING' AND error_code='RUNNING_OBSERVED'))").run(now(),id).changes!==1)throw new BridgeError('CONFLICT','Request changed during original execution observation');return this.get(id);}
    transaction(this.db,()=>{
      const task=new TaskStore(this.db,this.authority).getTask(request.taskId)!;
      if(task.attempt!==run.attempt || task.execution_prompt_id!==run.prompt_id || task.status!=='WAITING_APPROVAL')throw new BridgeError('CONFLICT','Original completed execution attempt changed');
      if(this.db.prepare('SELECT state FROM background_requests WHERE id=?').get(id)!.state==='WAITING_APPROVAL')return;
      if(this.db.prepare("UPDATE background_requests SET state='WAITING_APPROVAL',gui=0,error_code=NULL,updated_at=? WHERE id=? AND (state='UNCERTAIN' OR (state='RUNNING' AND error_code='RUNNING_OBSERVED'))").run(now(),id).changes!==1)throw new BridgeError('CONFLICT','Request changed during original execution completion');
      enqueueNotification(this.db,caller.principal,`request:${id}:waiting`,{requestId:id,taskId:request.taskId,state:'WAITING_APPROVAL'});
    });
    const result=this.executionResult(id);
    if(result.output && result.feedbackState===null)await this.reviewExecution(id);
    return this.get(id);
  }
  /** Called in a transaction only after the original process is proven dead. */
  private resumePreparedPrompt(id:string,originalOwner:string|null):boolean {
    const prompt=this.db.prepare(`SELECT p.* FROM prompts p JOIN prompt_generation_ops g ON g.task_id=p.task_id AND g.prompt_id=p.id JOIN tasks t ON t.id=p.task_id
      JOIN background_requests r ON r.task_id=p.task_id WHERE r.id=? AND g.state='COMPLETE' AND p.delivery_status='PENDING' AND p.verified=1 AND t.status='QUEUED'
      AND NOT EXISTS(SELECT 1 FROM execution_runs e WHERE e.task_id=p.task_id) AND NOT EXISTS(SELECT 1 FROM prompt_dispatches d WHERE d.task_id=p.task_id)`).get(id);
    if(!prompt || (prompt.source!=='chatgpt' && !isDemoDatabase(this.db)) || !prompt.source_message_id || promptHash(String(prompt.content))!==prompt.prompt_hash)return false;
    const mapping=new ConversationRegistry(this.db,this.authority).forTask(String(prompt.task_id));
    if(prompt.source_conversation_id!==mapping.chatgpt_conversation_id)return false;
    if(this.db.prepare("UPDATE background_requests SET state='QUEUED',gui=0,error_code=NULL,updated_at=? WHERE id=? AND owner_token IS ? AND state IN ('GENERATING','RUNNING','UNCERTAIN')").run(now(),id,originalOwner).changes!==1)return false;
    enqueueNotification(this.db,this.controller().principal,`request:${id}:prompt-ready`,{requestId:id,taskId:prompt.task_id,promptId:prompt.id,state:'QUEUED'});
    return true;
  }
  start(): void {
    this.controller();
    if (!this.stopped) return;
    this.recoverInterrupted();
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.config.background.intervalMs);
    this.wake();
  }
  private recoverInterrupted(): void {
    const caller=this.controller(),owners=new Map<string | null,boolean | null>();
    const alive=(token: unknown)=>{const key=token as string | null;if(!owners.has(key))owners.set(key,ownerAlive(key));return owners.get(key);};
    transaction(this.db,()=>{
      for(const row of this.db.prepare("SELECT id,task_id,owner_token FROM background_requests WHERE principal=? AND state IN ('GENERATING','RUNNING')").all(caller.principal)) {
        if(alive(row.owner_token)!==true) {
          if(alive(row.owner_token)===false && this.resumePreparedPrompt(String(row.id),row.owner_token as string|null))continue;
          this.db.prepare("UPDATE background_requests SET state='UNCERTAIN',gui=0,error_code=?,updated_at=? WHERE id=?").run(alive(row.owner_token)===false?'HOST_EXITED':'HOST_STATUS_UNKNOWN',now(),row.id);
          this.db.prepare("UPDATE prompt_generation_ops SET state='UNCERTAIN',error_code='HOST_EXITED' WHERE task_id=? AND state='GENERATING'").run(row.task_id);
          this.db.prepare("UPDATE execution_runs SET state='UNCERTAIN',error_code='HOST_EXITED',updated_at=? WHERE task_id=? AND state='RUNNING'").run(now(),row.task_id);
        }
        enqueueNotification(this.db,caller.principal,`request:${row.id}:restart`,{requestId:row.id,taskId:row.task_id,state:alive(row.owner_token)===false?'UNCERTAIN':'HOST_STATUS_UNKNOWN',action:'Observe the original operation; never resend'});
      }
      for(const row of this.db.prepare("SELECT e.id,e.feedback_owner_token,r.id request_id FROM execution_runs e JOIN background_requests r ON r.task_id=e.task_id WHERE r.principal=? AND e.feedback_state='SENDING'").all(caller.principal)) {
        if(alive(row.feedback_owner_token)!==true)this.db.prepare("UPDATE execution_runs SET feedback_state='UNCERTAIN',feedback_error='HOST_EXITED' WHERE id=?").run(row.id);
        enqueueNotification(this.db,caller.principal,`execution:${row.id}:feedback-restart`,{requestId:row.request_id,runId:row.id,state:'GPT_FEEDBACK_UNKNOWN',action:'Read original feedback; never resend'});
      }
      for(const row of this.db.prepare("SELECT id,owner_token FROM project_operations WHERE principal=? AND state='PROVISIONING'").all(caller.principal)) {
        if(alive(row.owner_token)!==true)this.db.prepare("UPDATE project_operations SET state='UNCERTAIN',error_code='HOST_EXITED',updated_at=? WHERE id=?").run(now(),row.id);
        enqueueNotification(this.db,caller.principal,`project:${row.id}:restart`,{operationId:row.id,state:'HOST_STATUS_UNKNOWN',action:'Reconcile original resources and phase'});
      }
    });
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
      if(this.host.executor?.durable && this.host.executor.observeExecution && this.host.executorContext) {
        const pending=this.db.prepare("SELECT r.id FROM background_requests r JOIN execution_runs e ON e.task_id=r.task_id WHERE r.principal=? AND (e.state='UNCERTAIN' OR e.error_code='RUNNING_OBSERVED' OR (e.state='WAITING_APPROVAL' AND r.state='UNCERTAIN')) ORDER BY e.created_at LIMIT 1").get(caller.principal);
        if(pending) {
          try{await this.reconcileExecution(String(pending.id));}
          catch(error){const code=classifyError(error).code;enqueueNotification(this.db,caller.principal,`request:${pending.id}:observe:${code}`,{requestId:pending.id,state:'UNCERTAIN',errorCode:code,action:'Original execution readback unavailable; no rerun'});}
        }
      }
      const row = transaction(this.db, () => {
        if(this.db.prepare("SELECT 1 FROM execution_runs WHERE state='RUNNING'").get())return null;
        const next=this.db.prepare(`SELECT r.* FROM background_requests r JOIN tasks t ON t.id=r.task_id WHERE r.principal=? AND r.state='QUEUED' AND t.status='QUEUED'
          AND NOT EXISTS(SELECT 1 FROM background_requests other JOIN tasks ot ON ot.id=other.task_id WHERE other.id!=r.id AND ot.project_id=t.project_id AND other.state IN ('GENERATING','RUNNING','UNCERTAIN'))
          ORDER BY t.priority DESC,r.created_at,r.id`).all(caller.principal).find(row=>{
            const ready=this.db.prepare("SELECT 1 FROM prompts WHERE task_id=? AND verified=1 AND delivery_status='PENDING'").get(row.task_id);
            return ready || !(this.db.prepare("SELECT 1 FROM project_operations WHERE state='PROVISIONING'").get() || this.db.prepare("SELECT 1 FROM background_requests WHERE gui=1 AND state IN ('GENERATING','RUNNING')").get() || this.db.prepare("SELECT 1 FROM execution_runs WHERE feedback_state='SENDING'").get());
          });
        if(!next)return null;
        const ready=!!this.db.prepare("SELECT 1 FROM prompts WHERE task_id=? AND verified=1 AND delivery_status='PENDING'").get(next.task_id);
        if(this.db.prepare("UPDATE background_requests SET state='GENERATING',gui=?,owner_token=?,updated_at=? WHERE id=? AND state='QUEUED'").run(ready?0:1,processOwner(),now(),next.id).changes!==1)return null;
        return next;
      });
      if (!row) return false;
      id = String(row.id);
      if(!this.config.agents.codex.enabled || !this.host.executor || !this.host.executorContext)throw new BridgeError('UNSUPPORTED','Authorized Codex host must be installed and enabled');
      const registry=new ConversationRegistry(this.db,this.authority),mapping=registry.forTask(String(row.task_id));
      let promptId=this.db.prepare("SELECT id FROM prompts WHERE task_id=? AND verified=1 AND delivery_status='PENDING'").get(row.task_id)?.id as string | undefined;
      if(!promptId) {
        if(!this.config.agents.chatgpt.enabled || !this.host.ordinaryChat)throw new BridgeError('UNSUPPORTED','GUI GPT generation is unavailable; prepared backend tasks remain independent');
        assertOrdinaryChatCapabilities(await withDeadline(signal=>this.host.ordinaryChat!.inspect(signal),this.config.background.timeoutMs));
        const source=createOrdinaryChatAdapter(this.host.ordinaryChat,mapping.chatgpt_conversation_id,mapping.project_name);
        const route=await withDeadline(signal=>source.preflight!({conversationId:mapping.chatgpt_conversation_id,projectId:mapping.app_project_id ?? mapping.project_id,workspacePath:mapping.workspace_path},signal),this.config.background.timeoutMs);
        assertProjectRouteEvidence(mapping,route);
        const pipeline=new PromptPipeline(this.db,this.authority,source,this.config.agents.chatgpt,{deliver:async()=>{throw new BridgeError('UNSUPPORTED','Background runner owns execution');}},this.config.background.timeoutMs);
        promptId=await pipeline.generate(String(row.task_id),String(row.requirement),this.context);
      }
      this.db.prepare("UPDATE background_requests SET state='RUNNING',gui=?,updated_at=? WHERE id=? AND state='GENERATING'").run(this.host.executor.mode==='codex-desktop'?1:0,now(),id);
      const conversationId=row.codex_conversation_id ?? this.db.prepare('SELECT default_codex_conversation_id FROM conversation_workspaces WHERE project_id=?').get(mapping.project_id)?.default_codex_conversation_id;
      if(!conversationId)throw new BridgeError('PROVENANCE','No explicit default Codex conversation is configured');
      const target={conversation_id:conversationId};
      const runner = new BackgroundRunner(this.db, this.authority, this.host.executor, this.config.background);
      const runId = await runner.run(promptId!, { codexConversationId: String(target.conversation_id), workspacePath: mapping.workspace_path }, this.host.executorContext);
      transaction(this.db, () => {
        this.db.prepare("UPDATE background_requests SET state='WAITING_APPROVAL',updated_at=? WHERE id=? AND state='RUNNING'").run(now(), id!);
        enqueueNotification(this.db, caller.principal, `request:${id}:waiting`, { requestId: id, taskId: row.task_id, state: 'WAITING_APPROVAL' });
      });
      if (this.db.prepare('SELECT result_json FROM execution_runs WHERE id=?').get(runId)!.result_json !== null) await this.reviewExecution(id);
      return true;
    } catch (error) {
      if (!id) throw error;
      const row = this.db.prepare('SELECT task_id FROM background_requests WHERE id=?').get(id)!;
      const uncertain = !!this.db.prepare("SELECT 1 FROM prompt_generation_ops WHERE task_id=? AND state='UNCERTAIN'").get(row.task_id) || !!this.db.prepare("SELECT 1 FROM execution_runs WHERE task_id=? AND state='UNCERTAIN'").get(row.task_id);
      const waiting = this.db.prepare('SELECT status FROM tasks WHERE id=?').get(row.task_id)?.status === 'WAITING_APPROVAL';
      const state = waiting ? 'WAITING_APPROVAL' : uncertain ? 'UNCERTAIN' : 'BLOCKED', code = classifyError(error).code;
      transaction(this.db, () => {
        this.db.prepare('UPDATE background_requests SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, code, now(), id!);
        enqueueNotification(this.db, caller.principal, `request:${id}:${state}:${code}`, { requestId: id, taskId: row.task_id, state, errorCode: code, action: uncertain ? 'Reconcile the original operation before retry' : 'Resolve the reported host capability or provenance blocker' });
      });
      return true;
    } finally { this.busy = false; }
  }
}
