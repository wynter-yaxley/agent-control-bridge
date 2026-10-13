import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeConfig } from './config.ts';
import { BridgeError, EXIT_CODES, type ErrorCode } from './errors.ts';
import { controlledProcessEnv } from './silent-process.ts';
import { requireNoSecrets, redact } from './security.ts';
import type { NativeChatPage } from './native-messages.ts';
import type { ProjectHost, ProjectHostCapabilities } from './project-provisioner.ts';
import { NativeDesktopReadClient } from './native-readonly.ts';
import type { VisibleGptSnapshot } from './desktop-gpt-reader.ts';
import type { OrdinaryChatHost } from './ordinary-chat.ts';
import type { BackgroundExecutor } from './background-runner.ts';

export interface WindowsNativeTools {
  listProjects(signal: AbortSignal): Promise<{ projects: { projectId: string; projectKind: string; label: string; path: string; hostId: string }[] }>;
  listThreads(signal: AbortSignal): Promise<{ threads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[]; pinnedThreads: { id: string; kind: string; title: string }[] }>;
  readThread(id: string, signal: AbortSignal): Promise<NativeChatPage>;
  createCodexThread?(projectId: string, name: string, signal: AbortSignal): Promise<{ threadId: string }>;
}
export interface WindowsUiSnapshot { title: string; text: string; ordinaryComposer: boolean; pid: number }
interface UiResult { ok: boolean; code?: string; stage?: string; errorType?: string; line?: number; ordinaryModeObserved?: boolean; snapshot?: WindowsUiSnapshot; body?: string }
const pathKey = (value: string) => win32.normalize(value).toLowerCase();

export function createWindowsNativeReadTools(config: BridgeConfig, carrierThreadId: string, createCodexThread?: WindowsNativeTools['createCodexThread']): WindowsNativeTools {
  const client = (signal: AbortSignal) => new NativeDesktopReadClient({carrierThreadId,...config.nativeInterface,signal});
  return { listProjects: signal => client(signal).projectInventory(), listThreads: signal => client(signal).threadInventory(),
    readThread: (id,signal) => client(signal).readConversationPage(id), createCodexThread };
}

/** Fixed OS control operations. There is no public arbitrary UI/RPC tool. */
export class WindowsNativeUi {
  private readonly config: BridgeConfig;
  constructor(config: BridgeConfig) { this.config = config; }
  async call(operation: 'workspace-create' | 'gpt-create' | 'codex-create' | 'gpt-rename' | 'snapshot' | 'gpt-read' | 'chat-open' | 'chat-send' | 'chat-read-reply', fields: { name: string; path?: string; projectName?: string; prompt?: string; marker?: string; expectedTitle?: string; mode?: 'gpt' | 'codex' }, signal: AbortSignal): Promise<UiResult> {
    if (process.platform !== 'win32') throw new BridgeError('UNSUPPORTED', 'Native UI controls require Windows');
    requireNoSecrets(JSON.stringify(fields));
    const helper = fileURLToPath(new URL('./windows-native-worker.ps1', import.meta.url));
    const script = `& ([scriptblock]::Create([System.IO.File]::ReadAllText('${helper.replaceAll("'", "''")}')))`;
    const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, env: controlledProcessEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', diagnostics = '', failure: BridgeError | undefined;
      const abort = () => { failure = new BridgeError('TIMEOUT', 'Native UI operation interrupted; reconcile its original resources'); child.kill(); };
      const timer = setTimeout(abort, this.config.background.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => { output += String(chunk); if (output.length > 1048576) abort(); });
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(0,4096); if(String(chunk).startsWith('ACB_UI_STAGE='))process.stderr.write(String(chunk)); });
      child.once('error', () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new BridgeError('DEPENDENCY', 'Windows UI worker could not start')); });
      child.stdin.on('error', () => { failure = new BridgeError('IO', 'Windows UI worker input failed'); });
      child.once('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new BridgeError('EXECUTION', `Windows UI worker failed: ${redact(diagnostics)}`)); return; }
        try {
          const result = JSON.parse(output) as UiResult;
          if (!result.ok) throw new BridgeError(Object.hasOwn(EXIT_CODES,result.code ?? '') ? result.code as ErrorCode : 'EXECUTION', `Native UI operation failed at ${result.stage} (${result.errorType}, line ${result.line})`);
          if (result.snapshot) result.snapshot.text = redact(result.snapshot.text);
          if (result.body) result.body = redact(result.body);
          resolve(result);
        } catch (error) { reject(error instanceof BridgeError ? error : new BridgeError('IO', 'Windows UI worker returned an unreadable result')); }
      });
      if (signal.aborted) abort();
      else child.stdin.end(JSON.stringify({ operation, ...fields, timeoutMs: this.config.background.timeoutMs, pollMs: this.config.desktop.uiPollMs }));
    });
  }
}

export function createWindowsNativeGptReader(config: BridgeConfig, callingThreadId?: string): (conversationId: string, name: string, carrierThreadId: string) => Promise<VisibleGptSnapshot> {
  const ui=new WindowsNativeUi(config);
  return async(conversationId,name,carrierThreadId)=>{
    const signal=new AbortController().signal;
    // The desktop tool caller is transport context, not the project's executor.
    // It grants no role or target access; BackgroundBridge scopes both separately.
    const page=await new NativeDesktopReadClient({carrierThreadId:callingThreadId ?? carrierThreadId,...config.nativeInterface,signal}).readConversationPage(conversationId);
    if(page.thread.kind!=='chatgpt' || page.thread.title!==name)throw new BridgeError('PROVENANCE','Native GPT identity or title differs');
    const turn=page.turns[0],user=turn?.items.find(item=>item.type==='userMessage'),replies=turn?.items.filter(item=>item.type==='agentMessage') ?? [];
    const prompt=user?.content.find(part=>part.type==='text' && !part.truncated)?.text;
    if(!prompt || replies.length!==1)throw new BridgeError('UNSUPPORTED','UI reply correlation requires one native assistant message and a complete user prompt');
    const result=await ui.call('gpt-read',{name,prompt},signal),text=result.body!;
    return {source:'windows-uia',conversationId,browserTitle:name,kind:'unknown',completionVerified:false,actualModel:null,actualReasoningEffort:null,
      responseInProgress:page.thread.status.type!=='idle',messages:[{role:'assistant',text,sourceMessageId:replies[0].id,hash:createHash('sha256').update(text,'utf8').digest('hex')}]};
  };
}

/** The authorization callback belongs to trusted embedding code. Config and MCP
 * inputs cannot approve an initialization or install native tool callbacks. */
export function createWindowsNativeProjectHost(options: { config: BridgeConfig; native: WindowsNativeTools; authorizeInitialization: (name: string, path: string, signal: AbortSignal) => Promise<boolean>; ui?: WindowsNativeUi }): ProjectHost {
  const { config, native } = options, ui = options.ui ?? new WindowsNativeUi(config);
  const ordinaryIds = new Set<string>();
  const capabilities: ProjectHostCapabilities = { source: 'application-host', workspaceSurface: 'native-desktop', ordinaryChat: true, background: false,
    exactConversation: true, completeMessages: false, actualGenerationParameters: false, createOrdinaryChat: true, createWorkspace: true, models: [], reasoningEfforts: [] };
  const poll = async <T>(read: () => Promise<T | undefined>, signal: AbortSignal): Promise<T> => {
    const deadline = Date.now() + config.nativeInterface.timeoutMs;
    do { const value = await read(); if (value !== undefined) return value; if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'Native creation readback is pending; do not create replacements'); await delay(config.desktop.uiPollMs, undefined, { signal }); } while (!signal.aborted);
    throw new BridgeError('TIMEOUT', 'Native creation readback was cancelled');
  };
  return {
    inspect: async () => capabilities,
    async createWorkspace(name, path, signal) {
      if (!await options.authorizeInitialization(name,path,signal)) throw new BridgeError('AUTH', 'One-time human authorization for this native UI initialization is required');
      await ui.call('workspace-create', {name,path},signal);
      const project = await poll(async () => (await native.listProjects(signal)).projects.find(item => item.projectKind === 'local' && item.hostId === 'local' && item.label === name && pathKey(item.path) === pathKey(path)),signal);
      return { appProjectId: project.projectId, workspacePath: project.path };
    },
    async createOrdinaryChat(_appProjectId, name, signal) {
      const marker = `ACB_INIT_${randomUUID()}`;
      const prompt = `这是 Agent Control Bridge 的会话身份初始化，不执行工程任务。请只回复：${marker}。`;
      const before = await native.listThreads(signal), baseline = new Set([...before.threads,...before.pinnedThreads].map(item => item.id));
      const observed = await ui.call('gpt-create',{name,prompt,marker},signal);
      if (observed.ordinaryModeObserved !== true) throw new BridgeError('PROVENANCE', 'Ordinary chat mode was not observed');
      const id = await poll(async () => {
        const inventory = await native.listThreads(signal);
        for (const item of [...inventory.threads,...inventory.pinnedThreads]) {
          if (baseline.has(item.id) || item.kind !== 'chatgpt' || item.title !== name) continue;
          const page = await native.readThread(item.id,signal);
          if (page.thread.title === name && page.turns.some(turn => turn.items.some(message => message.type === 'userMessage' && message.content.some(part => part.type === 'text' && part.text === prompt && !part.truncated)))) return item.id;
        }
        return undefined;
      },signal);
      ordinaryIds.add(id); return {conversationId:id};
    },
    async createCodexConversation(appProjectId,_path,signal) {
      const project=(await native.listProjects(signal)).projects.find(item=>item.projectId===appProjectId)!;
      const name=`${project.label} Codex`;
      if(native.createCodexThread) {
        const created=await native.createCodexThread(appProjectId,name,signal);
        return {conversationId:created.threadId};
      }
      const baseline=new Set((await native.listThreads(signal)).threads.map(item=>item.id));
      const marker=`ACB_CODEX_INIT_${randomUUID()}`,prompt=`这是 Agent Control Bridge 的隔离会话登记，不执行工程任务。禁止调用工具或修改文件，请只回复：${marker}。`;
      await ui.call('codex-create',{name,projectName:project.label,prompt,marker},signal);
      const thread=await poll(async()=>(await native.listThreads(signal)).threads.find(item=>!baseline.has(item.id) && item.kind==='codex' && item.title===name && item.projectId===appProjectId && item.cwd && pathKey(item.cwd)===pathKey(_path)),signal);
      return {conversationId:thread.id};
    },
    async verifyBundle(resources,signal) {
      const snapshot = ordinaryIds.has(resources.chatgptConversationId) ? undefined : (await ui.call('snapshot',{name:resources.name},signal)).snapshot!;
      const projects=await native.listProjects(signal), threads=await native.listThreads(signal), chat=await native.readThread(resources.chatgptConversationId,signal);
      const project=projects.projects.find(item=>item.projectId===resources.appProjectId), codex=threads.threads.find(item=>item.id===resources.codexConversationId);
      if (!project || project.projectKind!=='local' || project.hostId!=='local' || project.label!==resources.name || pathKey(project.path)!==pathKey(resources.workspacePath) ||
          !codex || codex.kind!=='codex' || codex.projectId!==resources.appProjectId || !codex.cwd || pathKey(codex.cwd)!==pathKey(resources.workspacePath) || chat.thread.id!==resources.chatgptConversationId || chat.thread.kind!=='chatgpt' || chat.thread.title!==resources.name) throw new BridgeError('PROVENANCE','Native bundle identity, directory, name or Codex membership differs');
      if (snapshot) {
        const prompt=chat.turns.flatMap(turn=>turn.items).filter(item=>item.type==='userMessage').flatMap(item=>item.content).find(part=>part.type==='text' && part.text && !part.truncated)?.text;
        if (!snapshot.ordinaryComposer || !prompt || !snapshot.text.includes(prompt)) throw new BridgeError('PROVENANCE','Current ordinary GPT view cannot be correlated with this native conversation');
      }
      return {...resources,source:'application-host',kind:'ordinary-chat',workspaceSurface:'native-desktop',codexNativeProjectId:codex.projectId};
    },
  };
}

/** UIA operates the existing desktop surface. The embedding host must authorize
 * every read/navigation/send; a config flag never grants this capability. */
export function createWindowsNativeConversationHost(options: {
  config: BridgeConfig;
  native: WindowsNativeTools;
  authorizeUiOperation: (target: { conversationId: string; name: string }, action: 'read' | 'send', signal: AbortSignal) => Promise<boolean>;
  ui?: WindowsNativeUi;
}): { ordinaryChat: OrdinaryChatHost; executor: BackgroundExecutor } {
  const { config, native } = options, ui = options.ui ?? new WindowsNativeUi(config);
  const ordinaryIds=new Set<string>();
  const authorize = async (page: NativeChatPage, action: 'read' | 'send', signal: AbortSignal) => {
    if (!await options.authorizeUiOperation({conversationId:page.thread.id,name:page.thread.title},action,signal)) throw new BridgeError('AUTH','Trusted authorization for this desktop operation is required');
  };
  const waitForTurn = async (id: string, before: NativeChatPage, prompt: string, signal: AbortSignal, onEvent?: (event: Record<string,unknown>)=>void) => {
    const baseline = new Set(before.turns.map(turn=>turn.id));
    const deadline = Date.now()+config.background.timeoutMs;
    let observed = false;
    do {
      const page = await native.readThread(id,signal);
      if (page.thread.id!==before.thread.id || page.thread.kind!==before.thread.kind || page.thread.title!==before.thread.title) throw new BridgeError('PROVENANCE','Desktop conversation changed during execution');
      const turn = page.turns.find(turn=>!baseline.has(turn.id) && turn.items.some(item=>item.type==='userMessage' && item.content.some(part=>part.type==='text' && !part.truncated && (part.text===prompt || (page.thread.kind==='codex' && part.text===`${prompt}\n`)))));
      if (turn) {
        if (!observed) { observed=true; onEvent?.({type:'turn.started'}); }
        if (turn.error || ['failed','interrupted'].includes(turn.status)) throw new BridgeError('EXECUTION','Native desktop turn failed or was interrupted');
        const replies=turn.items.filter(item=>item.type==='agentMessage').filter(item=>item.phase!=='commentary');
        if (page.thread.status.type==='idle' && turn.status==='completed' && replies.length) {onEvent?.({type:'turn.completed'});return {page,turn,replies};}
      }
      await delay(config.desktop.uiPollMs,undefined,{signal});
    } while (Date.now()<deadline && !signal.aborted);
    throw new BridgeError('TIMEOUT','Desktop turn completion is pending; reconcile this turn without resending');
  };
  const ordinaryChat: OrdinaryChatHost = {
    async inspect() {return {source:'application-host',ordinaryChat:true,background:false,exactConversation:true,completeMessages:true,actualGenerationParameters:false,
      createOrdinaryChat:false,createWorkspace:false,models:[],reasoningEfforts:[]};},
    async inspectConversation(id,signal) {
      const page=await native.readThread(id,signal);
      if(page.thread.id!==id || page.thread.kind!=='chatgpt')throw new BridgeError('PROVENANCE','Native conversation is not ChatGPT');
      if(!ordinaryIds.has(id)) {
        await authorize(page,'read',signal);
        const snapshot=(await ui.call('chat-open',{name:page.thread.title},signal)).snapshot!;
        if(!snapshot.ordinaryComposer)throw new BridgeError('PROVENANCE','Target is not an ordinary GPT conversation');
        ordinaryIds.add(id);
      }
      return {source:'application-host',kind:'ordinary-chat',conversationId:id,name:page.thread.title};
    },
    async generate(id,prompt,{signal}) {
      const before=await native.readThread(id,signal);
      if(before.thread.id!==id || before.thread.kind!=='chatgpt')throw new BridgeError('PROVENANCE','Native generation target differs');
      if(before.thread.status.type!=='idle')throw new BridgeError('CONFLICT','GPT conversation is busy');
      await authorize(before,'send',signal);
      const result=await ui.call('chat-send',{name:before.thread.title,prompt,mode:'gpt'},signal);
      const {replies}=await waitForTurn(id,before,prompt,signal);
      if(replies.length!==1)throw new BridgeError('PROVENANCE','GPT reply body requires one exact native assistant message');
      return {content:result.body!,sourceConversationId:id,sourceConversationName:before.thread.title,sourceMessageId:replies[0].id,
        actualModel:null,actualReasoningEffort:null,complete:true,evidenceSource:'application-host'};
    },
    async observeGeneration(id,prompt,signal) {
      const before=await native.readThread(id,signal);
      if(before.thread.id!==id || before.thread.kind!=='chatgpt' || !before.turns[0]?.items.some(item=>item.type==='userMessage' && item.content.some(part=>part.type==='text' && !part.truncated && part.text===prompt)))throw new BridgeError('PROVENANCE','The original GPT request is not the latest native turn');
      await authorize(before,'read',signal);
      const result=await ui.call('chat-read-reply',{name:before.thread.title,prompt},signal);
      const page=await native.readThread(id,signal),turn=page.turns[0],replies=turn.items.filter(item=>item.type==='agentMessage');
      if(page.thread.title!==before.thread.title || page.thread.status.type!=='idle' || turn.id!==before.turns[0].id || turn.status!=='completed' || replies.length!==1)throw new BridgeError('PROVENANCE','Original GPT completion or exact message changed');
      return {content:result.body!,sourceConversationId:id,sourceConversationName:page.thread.title,sourceMessageId:replies[0].id,
        actualModel:null,actualReasoningEffort:null,complete:true,evidenceSource:'application-host'};
    },
  };
  const executor: BackgroundExecutor = {
    mode:'codex-desktop',
    async inspect(target,signal) {
      const inventory=await native.listThreads(signal),thread=inventory.threads.find(item=>item.id===target.codexConversationId);
      const project=(await native.listProjects(signal)).projects.find(item=>item.projectId===thread?.projectId);
      if(!thread || thread.kind!=='codex' || !thread.cwd || !project || project.projectKind!=='local' || project.hostId!=='local' || pathKey(thread.cwd)!==pathKey(target.workspacePath) || pathKey(project.path)!==pathKey(target.workspacePath)) throw new BridgeError('PROVENANCE','Native Codex project and workspace do not match');
      return {source:'codex-app-state',conversationId:thread.id,appProjectId:project.projectId,workspacePath:project.path,local:true};
    },
    async execute(content,_key,target,signal,onEvent) {
      await executor.inspect(target,signal);
      const before=await native.readThread(target.codexConversationId,signal);
      if(before.thread.kind!=='codex' || !['idle','notLoaded'].includes(before.thread.status.type))throw new BridgeError('CONFLICT','Native Codex conversation is busy or differs');
      await authorize(before,'send',signal);
      await ui.call('chat-send',{name:before.thread.title,prompt:content,mode:'codex'},signal);
      const {turn,replies}=await waitForTurn(target.codexConversationId,before,content,signal,onEvent);
      if(replies.some(reply=>reply.truncated || !reply.text.trim() || reply.text.includes('::chatgpt-content-reference{')))throw new BridgeError('PROVENANCE','Native Codex result body is incomplete');
      return {executionId:turn.id,codexConversationId:target.codexConversationId,workspacePath:target.workspacePath,
        output:{content:replies.map(reply=>reply.text).join('\n\n'),messageIds:replies.map(reply=>reply.id)}};
    },
    async observeExecution(content,target,startedAfter,signal) {
      await executor.inspect(target,signal);
      const page=await native.readThread(target.codexConversationId,signal),turn=page.turns[0];
      if(page.thread.kind!=='codex' || page.thread.status.type!=='idle' || turn.status!=='completed' || turn.error || !turn.startedAt || turn.startedAt<Math.floor(Date.parse(startedAfter)/1000) || !turn.items.some(item=>item.type==='userMessage' && item.content.some(part=>part.type==='text' && !part.truncated && (part.text===content || part.text===`${content}\n`))))throw new BridgeError('PROVENANCE','No exact completed native execution for this run');
      const replies=turn.items.filter(item=>item.type==='agentMessage').filter(item=>item.phase==='final_answer');
      if(!replies.length || replies.some(reply=>reply.truncated || !reply.text.trim()))throw new BridgeError('PROVENANCE','Original native execution has no full final reply');
      return {executionId:turn.id,codexConversationId:target.codexConversationId,workspacePath:target.workspacePath,output:{content:replies.map(reply=>reply.text).join('\n\n'),messageIds:replies.map(reply=>reply.id)}};
    },
  };
  return {ordinaryChat,executor};
}
