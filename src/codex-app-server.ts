import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, resolve, win32 } from 'node:path';
import { BridgeError } from './errors.ts';
import { controlledProcessEnv } from './silent-process.ts';
import { requireNoSecrets } from './security.ts';
import type { DeliveryTarget } from './prompts.ts';
import type { BackgroundExecutor } from './background-runner.ts';

const ID = /^[a-zA-Z0-9_-]{1,200}$/;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new BridgeError('PROVENANCE', 'App-server returned an invalid identity');
  return value;
}
function pathKey(value: string): string {
  if (!isAbsolute(value) && !win32.isAbsolute(value)) throw new BridgeError('PROVENANCE', 'App-server workspace must be absolute');
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? win32.normalize(value).toLowerCase() : resolve(value);
}
function assertResumeSandbox(result: Row, workspace: string): void {
  const sandbox = row(result.sandbox), base = pathKey(workspace);
  const separator = /^[a-zA-Z]:[\\/]|^\\\\/.test(workspace) ? '\\' : '/';
  const prefix = base.endsWith(separator) ? base : base + separator;
  const roots = sandbox?.writableRoots;
  if (result.approvalPolicy !== 'untrusted' || sandbox?.type !== 'workspaceWrite' || sandbox.networkAccess !== false || !Array.isArray(roots) ||
      !roots.some(value => typeof value === 'string' && pathKey(value) === base) ||
      roots.some(value => typeof value !== 'string' || (pathKey(value) !== base && !pathKey(value).startsWith(prefix)))) {
    throw new BridgeError('PROVENANCE', 'App-server returned a broader sandbox or approval policy');
  }
}
export interface CodexThreadSummary {
  conversationId: string; appProjectId: string | null; workspacePath: string;
  status: 'notLoaded' | 'idle' | 'active' | 'systemError'; local: boolean;
}
interface ClientOptions { executable: string; timeoutMs: number; spawnFn?: typeof nodeSpawn; disabledServerName?: string }
interface ReadClientOptions extends ClientOptions { metadataOnly?: boolean }
interface Pending { resolve: (value: Row) => void; reject: (error: BridgeError) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }
class AppServerRpcError extends BridgeError {
  readonly rpcCode: number | null;
  constructor(error: unknown) {
    super('EXECUTION', 'App-server rejected the request; private diagnostics omitted');
    const code = row(error)?.code;
    this.rpcCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
  }
}

/** An owned stdio process, separate from the desktop. Target-bound approvals
 * require the protected host callback; authentication requests are not handled. */
class AppServerConnection {
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private failure?: BridgeError;
  private exited = false;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  notification?: (method: string, params: Row) => void;
  serverRequest?: (method:string,params:Row) => Promise<Row | undefined>;
  disconnected?: (error: BridgeError) => void;
  constructor(options: ReadClientOptions) {
    if (typeof options.executable !== 'string' || !options.executable.trim() || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600000) throw new BridgeError('CONFIG', 'Invalid app-server transport configuration');
    if (options.disabledServerName !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(options.disabledServerName)) throw new BridgeError('CONFIG', 'Invalid bridge MCP server name');
    this.timeoutMs = options.timeoutMs;
    try {
      this.child = (options.spawnFn ?? nodeSpawn)(options.executable, [
        // Metadata reads do not need plugin/app initialization.
        ...(options.metadataOnly ? ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps'] : []),
        ...(options.disabledServerName ? ['-c', `mcp_servers.${options.disabledServerName}.enabled=false`] : []),
        'app-server', '--listen', 'stdio://',
      ], {
        shell: false, windowsHide: true,
        env: controlledProcessEnv(), stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { throw new BridgeError('DEPENDENCY', 'Codex app-server could not start'); }
    this.child.once('error', () => this.fail(new BridgeError('DEPENDENCY', 'Codex app-server could not start')));
    this.child.once('exit', () => { this.exited = true; });
    this.child.once('close', () => { this.exited = true; this.fail(new BridgeError('EXECUTION', 'App-server disconnected; external outcome requires reconciliation')); });
    this.child.stdin?.on('error', () => this.fail(new BridgeError('IO', 'App-server input failed; external outcome requires reconciliation')));
    this.child.stderr?.on('data', () => { /* Drain private diagnostics without retaining them. */ });
    this.child.stdout?.on('data', (data: Buffer) => this.receive(data));
  }
  private fail(error: BridgeError): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(error); }
    this.pending.clear(); this.buffer = '';
    this.disconnected?.(error);
    try { this.child.stdin?.end(); } catch { /* Owned transport may already be closed. */ }
    try { if (!this.exited && this.child.exitCode == null && this.child.signalCode == null) this.child.kill(); } catch { /* Never terminate any existing application. */ }
    // Close only our transport handles; helper-inherited output handles must not
    // keep the diagnostic parent alive after its owned process has terminated.
    this.child.stdout?.destroy?.(); this.child.stderr?.destroy?.();
  }
  close(): void { this.fail(new BridgeError('IO', 'Owned app-server connection closed')); }
  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.child.stdin) throw new BridgeError('DEPENDENCY', 'App-server stdin is unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private receive(data: Buffer): void {
    if (this.failure) return;
    this.buffer += this.decoder.write(data);
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > 1024 * 1024) this.fail(new BridgeError('EXECUTION', 'App-server frame exceeded its finite bound'));
        return;
      }
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) { this.fail(new BridgeError('EXECUTION', 'App-server frame exceeded its finite bound')); return; }
      let message: Row | null;
      try { message = row(JSON.parse(line)); } catch { message = null; }
      if (!message) { this.fail(new BridgeError('EXECUTION', 'Invalid app-server frame')); return; }
      try {
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            // Only the installed target-bound host may answer execution approvals.
            if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new BridgeError('EXECUTION', 'Invalid server request identity');
            if(this.serverRequest) {
              const id=message.id;
              void this.serverRequest(message.method,row(message.params) ?? {}).then(result=>this.write(result?{id,result}:{id,error:{code:-32601,message:'Approval or authentication host is unavailable'}})).catch(error=>this.fail(error instanceof BridgeError?error:new BridgeError('AUTH','Host approval failed')));
            } else {this.write({ id: message.id, error: { code: -32601, message: 'Interactive server requests are not installed' } });this.fail(new BridgeError('AUTH', 'App-server requires an interactive host'));}
          } else this.notification?.(message.method, row(message.params) ?? {});
        } else {
          if (typeof message.id !== 'number' || !this.pending.has(message.id)) throw new BridgeError('EXECUTION', 'Unexpected app-server response identity');
          const item = this.pending.get(message.id)!; this.pending.delete(message.id);
          clearTimeout(item.timer); item.cleanup();
          const result = row(message.result);
          if (message.error || !result) item.reject(new AppServerRpcError(message.error));
          else item.resolve(result);
        }
      } catch (error) { this.fail(error instanceof BridgeError ? error : new BridgeError('IO', 'App-server event processing failed')); return; }
      if (this.failure) return;
    }
  }
  // This is intentionally private to this module, not an arbitrary RPC MCP tool.
  request(method: 'initialize' | 'model/list' | 'project/create' | 'project/read' | 'project/list' | 'thread/start' | 'thread/name/set' | 'thread/read' | 'thread/list' | 'thread/resume' | 'turn/start' | 'turn/interrupt', params: Row, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<Row> {
    if (signal?.aborted) return Promise.reject(new BridgeError('TIMEOUT', 'App-server request aborted before dispatch'));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolvePromise, rejectPromise) => {
      const id = ++this.sequence;
      const abort = () => this.fail(new BridgeError('TIMEOUT', 'App-server request aborted; external outcome requires reconciliation'));
      const timer = setTimeout(() => this.fail(new BridgeError('TIMEOUT', 'App-server request deadline exceeded; external outcome requires reconciliation')), timeoutMs);
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.write({ id, method, params }); } catch (error) { this.fail(error instanceof BridgeError ? error : new BridgeError('IO', 'App-server dispatch failed')); }
    });
  }
  async initialize(signal?: AbortSignal, experimentalApi = false): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'agent_control_bridge', title: 'Agent Control Bridge', version: '0.2.0' }, ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}) }, signal);
    this.write({ method: 'initialized', params: {} });
  }
}
function summary(result: Row, expectedId: string): CodexThreadSummary {
  const thread = row(result.thread), status = row(thread?.status)?.type;
  if (!thread || identifier(thread.id) !== expectedId || typeof thread.cwd !== 'string' || !['notLoaded', 'idle', 'active', 'systemError'].includes(String(status))) throw new BridgeError('PROVENANCE', 'App-server thread readback is incomplete or mismatched');
  pathKey(thread.cwd);
  const appProjectId = thread.projectId == null ? null : identifier(thread.projectId);
  return { conversationId: expectedId, appProjectId, workspacePath: thread.cwd, status: status as CodexThreadSummary['status'], local: ['cli', 'vscode', 'exec', 'appServer'].includes(String(thread.source)) };
}
export async function inspectCodexThread(options: ClientOptions & { conversationId: string; signal?: AbortSignal }): Promise<CodexThreadSummary> {
  const id = identifier(options.conversationId);
  if (options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Inspection aborted before process launch');
  const connection = new AppServerConnection({ ...options, metadataOnly: true });
  try {
    // Canonical projectId is an experimental response field in this protocol.
    await connection.initialize(options.signal, true);
    return summary(await connection.request('thread/read', { threadId: id, includeTurns: false }, options.signal), id);
  } finally { connection.close(); }
}

interface TurnEvent { method: string; threadId: string; turnId: string | null; status?: string; failed?: boolean; reroutedTo?: string }
function eventSummary(method: string, params: Row, target: string): TurnEvent | null {
  if (params.threadId !== target || !/^[a-zA-Z][a-zA-Z0-9/]{1,100}$/.test(method)) return null;
  const turn = row(params.turn), id = method === 'turn/completed' ? turn?.id : params.turnId ?? turn?.id;
  if (method === 'turn/completed' && params.turnId !== undefined && params.turnId !== id) return null;
  return { method, threadId: target, turnId: typeof id === 'string' && ID.test(id) ? id : null,
    ...(method === 'turn/completed' ? { status: String(turn?.status), failed: turn?.error != null } : {}),
    ...(method === 'model/rerouted' ? { reroutedTo: typeof params.toModel === 'string' ? params.toModel : '' } : {}) };
}
async function executeTurn(connection: AppServerConnection, options: { target: DeliveryTarget; model: string; reasoningEffort: string; content: string; key: string; durable?: boolean; timeoutMs: number; interruptTimeoutMs: number; signal: AbortSignal; onEvent?: (event: Row) => void; approve?: CodexAppServerExecutorOptions['approve'] }): Promise<string> {
  let turnId: string | null = null, finished = false, stopping = false;
  let pendingStop: BridgeError | undefined;
  const early: TurnEvent[] = [];
  let resolveTurn!: (id: string) => void, rejectTurn!: (error: BridgeError) => void;
  const outcome = new Promise<string>((resolvePromise, rejectPromise) => { resolveTurn = resolvePromise; rejectTurn = rejectPromise; });
  // A notification may arrive before turn/start responds. Attach a rejection
  // observer immediately, and buffer only bounded, content-free event summaries.
  void outcome.catch(() => {});
  const finish = (error?: BridgeError) => {
    if (finished) return; finished = true;
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    if (error) rejectTurn(error); else resolveTurn(turnId!);
  };
  const stop = async (error: BridgeError) => {
    if (finished || stopping) return; stopping = true;
    pendingStop = error;
    if (turnId) {
      try { await connection.request('turn/interrupt', { threadId: options.target.codexConversationId, turnId }, undefined, options.interruptTimeoutMs); }
      catch { /* No interrupt acknowledgement is treated as success. */ }
    }
    finish(error);
  };
  const abort = () => { void stop(new BridgeError('TIMEOUT', 'Turn aborted; external outcome requires reconciliation')); };
  const timer = options.durable ? undefined : setTimeout(() => { void stop(new BridgeError('TIMEOUT', 'Turn deadline exceeded; external outcome requires reconciliation')); }, options.timeoutMs);
  connection.disconnected = error => finish(error);
  connection.serverRequest = async(method,params) => {
    if(!options.approve || !['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method) || params.threadId!==options.target.codexConversationId || !turnId || params.turnId!==turnId) {
      void stop(new BridgeError('AUTH','This approval/authentication request has no trusted target-bound host'));
      return undefined;
    }
    const decision=await options.approve({method,params,target:options.target,dispatchId:options.key},options.signal);
    if(options.signal.aborted || !['accept','decline'].includes(decision))throw new BridgeError('AUTH','Host approval is unavailable or expired');
    return {decision};
  };
  const consume = (event: TurnEvent) => {
    if (finished || stopping || event.turnId !== turnId) return;
    try { options.onEvent?.({ type: event.method.replaceAll('/', '.').toLowerCase(), threadId: event.threadId, turnId }); }
    catch { void stop(new BridgeError('IO', 'Event persistence failed; external outcome requires reconciliation')); return; }
    if (event.method === 'model/rerouted' && event.reroutedTo !== options.model) { void stop(new BridgeError('PROVENANCE', 'Codex model rerouted; requested model cannot be assumed')); return; }
    if (event.method === 'turn/completed') {
      if (event.status !== 'completed' || event.failed) finish(new BridgeError('EXECUTION', 'Codex turn failed or was interrupted; no completed delivery'));
      else finish();
    }
  };
  connection.notification = (method, params) => {
    const event = eventSummary(method, params, options.target.codexConversationId);
    if (!event) return;
    if (turnId) consume(event);
    else {
      if (early.length >= 128) { finish(new BridgeError('EXECUTION', 'Too many events preceded the turn receipt')); return; }
      early.push(event);
    }
  };
  try {
    const result = await connection.request('turn/start', {
      threadId: options.target.codexConversationId, input: [{ type: 'text', text: options.content }],
      clientUserMessageId: options.key, model: options.model, effort: options.reasoningEffort,
      approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [options.target.workspacePath], networkAccess: false },
    }, options.signal);
    const turn = row(result.turn);
    turnId = identifier(turn?.id);
    try{options.onEvent?.({type:'turn.started',threadId:options.target.codexConversationId,turnId});}
    catch{const error=new BridgeError('IO','Turn receipt persistence failed; external outcome requires reconciliation');await stop(error);throw error;}
    if (pendingStop) {
      // A refusal/deadline can precede the start acknowledgement. Once the
      // actual turn ID arrives, interrupt that turn once; never invent an ID.
      try { await connection.request('turn/interrupt', { threadId: options.target.codexConversationId, turnId }, undefined, options.interruptTimeoutMs); } catch { /* Unknown remains fenced. */ }
    }
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    for (const event of early) consume(event);
    // Some transports can return an already terminal turn without a notification.
    if (turn?.status !== 'inProgress') consume({ method: 'turn/completed', threadId: options.target.codexConversationId, turnId, status: String(turn?.status), failed: turn?.error != null });
    return await outcome;
  } catch (error) {
    finish(error instanceof BridgeError ? error : new BridgeError('IO', 'Turn receipt could not be verified'));
    throw error;
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    connection.notification = undefined; connection.disconnected = undefined; connection.serverRequest = undefined;
  }
}

export interface CodexAppServerExecutorOptions extends ClientOptions {
  model: string; reasoningEffort: string; interruptTimeoutMs: number; selfMcpServerName: string; durableExecution?: boolean;
  inspect: BackgroundExecutor['inspect'];
  // App-server readback alone cannot prove that another desktop/CLI process
  // isn't already executing this thread. The trusted host owns this exclusion.
  assertExclusive: (target: DeliveryTarget, signal: AbortSignal) => Promise<void>;
  approve?: (request:{method:string;params:Row;target:DeliveryTarget;dispatchId:string},signal:AbortSignal)=>Promise<'accept'|'decline'>;
}
export function createCodexAppServerExecutor(options: CodexAppServerExecutorOptions): BackgroundExecutor {
  if (!/^gpt-[a-zA-Z0-9.-]{1,100}$/.test(options.model) || !EFFORTS.includes(options.reasoningEffort) || !Number.isInteger(options.interruptTimeoutMs) || options.interruptTimeoutMs < 1 || options.interruptTimeoutMs > 30000 || typeof options.selfMcpServerName !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.selfMcpServerName) || typeof options.inspect !== 'function' || typeof options.assertExclusive !== 'function') throw new BridgeError('CONFIG', 'App-server executor requires explicit model, effort, own MCP name and trusted target/exclusion adapters');
  const check = (actual: CodexThreadSummary, expected: Awaited<ReturnType<BackgroundExecutor['inspect']>>, target: DeliveryTarget) => {
    identifier(expected.appProjectId);
    // Older desktop assignments can live outside app-server's canonical project
    // field. Null is never evidence of ownership: the independent trusted
    // desktop inspector must still supply ownership. A conflicting non-null
    // canonical assignment is always rejected.
    if (!expected.local || expected.source !== 'codex-app-state' || expected.conversationId !== target.codexConversationId || !actual.local || (actual.appProjectId !== null && actual.appProjectId !== expected.appProjectId) || pathKey(actual.workspacePath) !== pathKey(target.workspacePath) || pathKey(actual.workspacePath) !== pathKey(expected.workspacePath)) throw new BridgeError('PROVENANCE', 'Native project, Codex thread and workspace readback do not match');
  };
  return {
    mode: 'codex-app-server',
    durable: options.durableExecution!==false,
    async inspect(target, signal) {
      const expected = await options.inspect(target, signal);
      check(await inspectCodexThread({ ...options, conversationId: target.codexConversationId, signal }), expected, target);
      return expected;
    },
    async execute(content, key, target, signal, onEvent) {
      if (signal.aborted) throw new BridgeError('TIMEOUT', 'Execution aborted before launch');
      if (typeof content !== 'string' || !content.trim() || content.length > 65536 || typeof key !== 'string' || !ID.test(key)) throw new BridgeError('INPUT', 'Invalid app-server prompt or dispatch identity');
      requireNoSecrets(content); identifier(target.codexConversationId); pathKey(target.workspacePath);
      const expected = await options.inspect(target, signal);
      await options.assertExclusive(target, signal);
      if (signal.aborted) throw new BridgeError('TIMEOUT', 'Execution aborted before launch');
      const connection = new AppServerConnection({ ...options, disabledServerName: options.selfMcpServerName });
      try {
        await connection.initialize(signal, true);
        const before = summary(await connection.request('thread/read', { threadId: target.codexConversationId, includeTurns: false }, signal), target.codexConversationId);
        check(before, expected, target);
        if (before.status === 'active' || before.status === 'systemError') throw new BridgeError('CONFLICT', 'Native thread is active or unavailable');
        const resumed = await connection.request('thread/resume', { threadId: target.codexConversationId, model: options.model, config: { model_reasoning_effort: options.reasoningEffort, sandbox_workspace_write: { network_access: false, writable_roots: [target.workspacePath] } }, approvalPolicy: 'untrusted', sandbox: 'workspace-write' }, signal);
        check(summary(resumed, target.codexConversationId), expected, target);
        if (resumed.model !== options.model || resumed.reasoningEffort !== options.reasoningEffort || typeof resumed.cwd !== 'string' || pathKey(resumed.cwd) !== pathKey(target.workspacePath)) throw new BridgeError('PROVENANCE', 'App-server selected configuration does not match the explicit request');
        assertResumeSandbox(resumed, target.workspacePath);
        await options.assertExclusive(target, signal);
        const executionId = await executeTurn(connection, { ...options, durable:options.durableExecution!==false, target, content, key, signal, onEvent });
        const completed = row((await connection.request('thread/read', { threadId: target.codexConversationId, includeTurns: true }, signal)).thread);
        const turn = Array.isArray(completed?.turns) ? completed.turns.map(row).find(turn => turn?.id === executionId) : undefined;
        if (completed?.id !== target.codexConversationId || turn?.status !== 'completed' || turn.error != null || !Array.isArray(turn.items)) throw new BridgeError('PROVENANCE', 'Completed Codex turn could not be read back');
        const replies = turn.items.map(row).filter(item => item?.type === 'agentMessage' && item.phase !== 'commentary');
        if (replies.length === 0 || replies.some(item => typeof item?.id !== 'string' || typeof item.text !== 'string' || !item.text.trim())) throw new BridgeError('PROVENANCE', 'Completed Codex reply has no full text or message identity');
        const output = { content: replies.map(item => String(item!.text)).join('\n\n'), messageIds: replies.map(item => String(item!.id)) };
        return { executionId, codexConversationId: target.codexConversationId, workspacePath: target.workspacePath, output };
      } finally { connection.close(); }
    },
    async observeExecution(content,target,_startedAfter,signal,original) {
      const expected=await options.inspect(target,signal);
      const connection=new AppServerConnection({...options,metadataOnly:true});
      try {
        await connection.initialize(signal);
        const value=await connection.request('thread/read',{threadId:target.codexConversationId,includeTurns:true},signal);
        const observed=summary(value,target.codexConversationId);
        check(observed,expected,target);
        const thread=row(value.thread),turns=Array.isArray(thread?.turns)?thread.turns.map(row):[];
        const turn=original?.executionId ? turns.find(t=>t?.id===original.executionId) : turns.find(t=>Array.isArray(t?.items) && t.items.map(row).some(item=>item?.type==='userMessage' && item.id===original?.dispatchId && Array.isArray(item.content) && item.content.some(part=>row(part)?.text===content)));
        if(!turn)throw new BridgeError('PROVENANCE','No exact original execution receipt; do not rerun');
        const executionId=identifier(turn.id);
        if(turn.status==='inProgress') {
          if(observed.status!=='active')throw new BridgeError('EXECUTION','Original turn has no live running evidence; preserve the uncertain outcome');
          return {executionId,codexConversationId:target.codexConversationId,workspacePath:target.workspacePath,running:true};
        }
        if(turn.status!=='completed' || turn.error!=null || !Array.isArray(turn.items))throw new BridgeError('EXECUTION','Original execution has no successful terminal receipt');
        const replies=turn.items.map(row).filter(item=>item?.type==='agentMessage' && item.phase!=='commentary');
        if(!replies.length || replies.some(item=>typeof item?.text!=='string' || !item.text.trim() || typeof item.id!=='string'))throw new BridgeError('PROVENANCE','Original execution has no complete final text');
        return {executionId,codexConversationId:target.codexConversationId,workspacePath:target.workspacePath,output:{content:replies.map(item=>String(item!.text)).join('\n\n'),messageIds:replies.map(item=>String(item!.id))}};
      }finally{connection.close();}

    },
  };
}
