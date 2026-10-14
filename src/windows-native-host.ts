import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeConfig } from './config.ts';
import { BridgeError, EXIT_CODES, type ErrorCode } from './errors.ts';
import { controlledProcessEnv } from './silent-process.ts';
import { requireNoSecrets, redact } from './security.ts';
import type { NativeChatPage } from './native-messages.ts';
import type { ProjectHost, ProjectHostCapabilities } from './project-provisioner.ts';
import { NativeDesktopReadClient } from './native-readonly.ts';
import type { VisibleGptSnapshot,DesktopGptReader } from './desktop-gpt-reader.ts';
import type { OrdinaryChatHost } from './ordinary-chat.ts';
import type { BackgroundExecutor } from './background-runner.ts';

export interface WindowsNativeTools {
  listProjects(signal: AbortSignal): Promise<{ projects: { projectId: string; projectKind: string; label: string; path: string; hostId: string }[] }>;
  listThreads(signal: AbortSignal): Promise<{ threads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[]; pinnedThreads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[] }>;
  readThread(id: string, signal: AbortSignal): Promise<NativeChatPage>;
  // Formal creator returns a thread receipt; its API does not guarantee an
  // operationKey or initialization message that can recover a lost receipt.
  createCodexThread?(projectId: string, name: string, signal: AbortSignal): Promise<{ threadId: string; projectId?: string }>;
}
export interface WindowsUiSnapshot { title: string; text: string; ordinaryComposer: boolean; pid: number; conversationId: string | null }
interface UiResult { ok: boolean; code?: string; stage?: string; errorType?: string; line?: number; ordinaryModeObserved?: boolean; snapshot?: WindowsUiSnapshot; body?: string; conversationId?: string; completionVerified?: boolean; timings?: { initMs: number; actionMs: number } }
const pathKey = (value: string) => win32.normalize(value).toLowerCase();
const initializationPrompt = (key: string) => `这是 Agent Control Bridge 的会话身份初始化，不执行工程任务。请只回复：ACB_INIT_${key}。`;
// The worker sends this exact prompt only after observing a blank ordinary chat,
// so its native readback is a durable receipt that survives Bridge restarts.
const hasInitialization = (page: NativeChatPage, key: string) => page.turns.some(turn => turn.items.some(message => message.type === 'userMessage' &&
  message.content.some(part => part.type === 'text' && !part.truncated && part.text === initializationPrompt(key))));

export function createWindowsNativeReadTools(config: BridgeConfig, carrierThreadId: string, createCodexThread?: WindowsNativeTools['createCodexThread']): WindowsNativeTools {
  const client = (signal: AbortSignal) => new NativeDesktopReadClient({carrierThreadId,...config.nativeInterface,signal});
  return { listProjects: signal => client(signal).projectInventory(), listThreads: signal => client(signal).threadInventory(),
    readThread: (id,signal) => client(signal).readConversationPage(id), createCodexThread };
}

/** Fixed OS control operations. There is no public arbitrary UI/RPC tool. */
const uiWorkers = new Set<WindowsNativeUi>();
export const closeWindowsNativeUiWorkers = () => { for (const worker of uiWorkers) worker.close(); };
export class WindowsNativeUi {
  private readonly config: BridgeConfig;
  private child?: ReturnType<typeof spawn>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(config: BridgeConfig) { this.config = config; }
  close(): void { this.child?.kill(); this.child=undefined; uiWorkers.delete(this); }
  call(operation: 'workspace-create' | 'gpt-create' | 'gpt-rename' | 'snapshot' | 'identity' | 'gpt-read' | 'chat-open' | 'chat-send' | 'chat-read-reply', fields: { name: string; conversationId?: string; path?: string; projectName?: string; prompt?: string; marker?: string; expectedTitle?: string; mode?: 'gpt' | 'codex' }, signal: AbortSignal): Promise<UiResult> {
    const pending=this.queue.then(()=>this.request(operation,fields,signal));
    // A failed operation is returned to its caller; subsequent requests are not replayed.
    this.queue=pending.then(()=>undefined,()=>undefined);
    return pending;
  }
  private async request(operation: string, fields: Record<string,unknown>, signal: AbortSignal): Promise<UiResult> {
    if (process.platform !== 'win32') throw new BridgeError('UNSUPPORTED', 'Native UI controls require Windows');
    if (signal.aborted) throw new BridgeError('TIMEOUT','Native UI request cancelled before dispatch');
    requireNoSecrets(JSON.stringify(fields));
    if (!this.child) {
      const helper=fileURLToPath(new URL('./windows-native-worker.ps1',import.meta.url));
      const script="& ([scriptblock]::Create([System.IO.File]::ReadAllText('"+helper.replaceAll("'","''")+"')))";
      const executable=win32.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      this.child=spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,env:controlledProcessEnv(),stdio:['pipe','pipe','pipe']});
      this.child.stdout!.setEncoding('utf8');
      const started=this.child;
      started.once('close',()=>{if(this.child===started){this.child=undefined;uiWorkers.delete(this);}});
      started.stderr!.on('data',chunk=>{if(String(chunk).startsWith('ACB_UI_STAGE='))process.stderr.write(String(chunk));});
      uiWorkers.add(this);
    }
    const child=this.child;
    return new Promise((resolve,reject)=>{
      let output='';
      const finish=(error?: BridgeError,result?: UiResult)=>{
        clearTimeout(timer);signal.removeEventListener('abort',abort);
        child.stdout!.removeListener('data',read);child.removeListener('error',failed);child.removeListener('close',closed);child.stdin!.removeListener('error',inputFailed);
        if(error){this.close();reject(error);}else resolve(result!);
      };
      const abort=()=>finish(new BridgeError('TIMEOUT','Native UI operation interrupted; reconcile without resending'));
      const failed=()=>finish(new BridgeError('DEPENDENCY','Windows UI worker could not start'));
      const closed=()=>finish(new BridgeError('IO','Windows UI worker exited; reconcile without resending'));
      const inputFailed=()=>finish(new BridgeError('IO','Windows UI worker input failed'));
      const read=(chunk: Buffer)=>{
        output+=String(chunk);
        if(output.length>1048576){finish(new BridgeError('PROVENANCE','Native UI response exceeds its bound'));return;}
        if(!output.includes('\n'))return;
        try {
          const result=JSON.parse(output) as UiResult;
          if(!result.ok)throw new BridgeError(Object.hasOwn(EXIT_CODES,result.code ?? '')?result.code as ErrorCode:'EXECUTION',`Native UI operation failed at ${result.stage} (${result.errorType}, line ${result.line})`);
          if(result.snapshot)result.snapshot.text=redact(result.snapshot.text);
          if(result.body)result.body=redact(result.body);
          finish(undefined,result);
        }catch(error){finish(error instanceof BridgeError?error:new BridgeError('IO','Windows UI worker returned an unreadable result'));}
      };
      const timer=setTimeout(abort,this.config.background.timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      child.stdout!.on('data',read);child.once('error',failed);child.once('close',closed);child.stdin!.on('error',inputFailed);
      child.stdin!.write(JSON.stringify({operation,...fields,timeoutMs:this.config.background.timeoutMs,pollMs:this.config.desktop.uiPollMs})+'\n');
    });
  }
}

export function createWindowsNativeGptReader(config: BridgeConfig, callingThreadId?: string, ui=new WindowsNativeUi(config)): (conversationId: string, name: string, carrierThreadId: string) => Promise<VisibleGptSnapshot> {
  return async(conversationId,name,carrierThreadId)=>{
    const signal=new AbortController().signal;
    // The desktop tool caller is transport context, not the project's executor.
    // It grants no role or target access; BackgroundBridge scopes both separately.
    let snapshot;
    const unavailable=(reason: string): VisibleGptSnapshot=>({source:'windows-uia',conversationId:null,identityStatus:'unavailable',browserTitle:'',kind:'unknown',completionVerified:false,actualModel:null,actualReasoningEffort:null,responseInProgress:true,messages:[],reason});
    // The reason keeps the failed worker stage (desktop, process, window, document).
    try{snapshot=(await ui.call('identity',{name:''},signal)).snapshot!;}
    catch(error){if(!(error instanceof BridgeError))throw error;return unavailable(`${error.code}: ${error.message}`);}
    if(!snapshot.title.trim())return unavailable('PROVENANCE: UIA Document.Current.Name is empty');
    return {source:'windows-uia',conversationId:null,identityStatus:'titleOnly',browserTitle:snapshot.title,kind:'unknown',completionVerified:false,
      actualModel:null,actualReasoningEffort:null,responseInProgress:true,messages:[]};
  };
}

/** The authorization callback belongs to trusted embedding code. Config and MCP
 * inputs cannot approve an initialization or install native tool callbacks. */
export function createWindowsNativeProjectHost(options: { config: BridgeConfig; native: WindowsNativeTools; authorizeInitialization: (name: string, path: string, signal: AbortSignal) => Promise<boolean>; ui?: WindowsNativeUi }): ProjectHost {
  const { config, native } = options, ui = options.ui ?? new WindowsNativeUi(config);
  const capabilities: ProjectHostCapabilities = { createCodexConversation:!!native.createCodexThread,source: 'application-host', workspaceSurface: 'native-desktop', ordinaryChat: true, background: false,
    exactConversation: true, completeMessages: false, actualGenerationParameters: false, createOrdinaryChat: true, createWorkspace: true, models: [], reasoningEfforts: [] };
  const poll = async <T>(read: () => Promise<T | undefined>, signal: AbortSignal): Promise<T> => {
    const deadline = Date.now() + config.nativeInterface.timeoutMs;
    do { const value = await read(); if (value !== undefined) return value; if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'Native creation readback is pending; do not create replacements'); await delay(config.desktop.uiPollMs, undefined, { signal }); } while (!signal.aborted);
    throw new BridgeError('TIMEOUT', 'Native creation readback was cancelled');
  };
  return {
    inspect: async () => capabilities,
    async authorizeInitialization(name,path,signal){if(!await options.authorizeInitialization(name,path,signal))throw new BridgeError('AUTH','Project-scoped initialization approval is required');},
    async createWorkspace(name, path, signal) {
      if (!await options.authorizeInitialization(name,path,signal)) throw new BridgeError('AUTH', 'One-time human authorization for this native UI initialization is required');
      await ui.call('workspace-create', {name,path},signal);
      const project = await poll(async () => (await native.listProjects(signal)).projects.find(item => item.projectKind === 'local' && item.hostId === 'local' && item.label === name && pathKey(item.path) === pathKey(path)),signal);
      return { appProjectId: project.projectId, workspacePath: project.path };
    },
    async createOrdinaryChat(_appProjectId, name, signal, operationKey) {
      // Without a recorded operation key the receipt could never be verified after a restart.
      if(!operationKey)throw new BridgeError('PROVENANCE','A recorded initialization operation key is required');
      const project=(await native.listProjects(signal)).projects.find(item=>item.projectId===_appProjectId && item.label===name);
      if(!project || !await options.authorizeInitialization(name,project.path,signal))throw new BridgeError('AUTH','This new GPT initialization requires target-bound host approval');
      const key = operationKey, marker = `ACB_INIT_${key}`, prompt = initializationPrompt(key);
      const before = await native.listThreads(signal), baseline = new Set([...before.threads,...before.pinnedThreads].map(item => item.id));
      const observed = await ui.call('gpt-create',{name,prompt,marker},signal);
      if (observed.ordinaryModeObserved !== true) throw new BridgeError('PROVENANCE', 'Ordinary chat mode or pre-send UI identity was not observed');
      const id = await poll(async () => {
        const inventory = await native.listThreads(signal);
        for (const item of [...inventory.threads,...inventory.pinnedThreads]) {
          if (baseline.has(item.id) || (observed.conversationId && item.id!==observed.conversationId) || item.kind !== 'chatgpt' || item.title !== name) continue;
          const page = await native.readThread(item.id,signal);
          if (page.thread.title === name && hasInitialization(page,key)) return item.id;
        }
        return undefined;
      },signal);
      return {conversationId:id};
    },
    async createCodexConversation(appProjectId,_path,signal) {
      const project=(await native.listProjects(signal)).projects.find(item=>item.projectId===appProjectId)!;
      const name=`${project.label} Codex`;
      if(native.createCodexThread) {
        const created=await native.createCodexThread(appProjectId,name,signal);
        if(created.projectId!==undefined && created.projectId!==appProjectId)throw new BridgeError('PROVENANCE','Formal Codex receipt belongs to a different native project');
        return {conversationId:created.threadId};
      }
      throw new BridgeError('UNSUPPORTED','A formal native Codex creation callback is required; GPT URI cannot prove Work identity');
    },
    async observePartial(resources,phase,signal) {
      if(phase==='workspace') {
        const matches=(await native.listProjects(signal)).projects.filter(item=>item.projectKind==='local' && item.hostId==='local' && item.label===resources.name && pathKey(item.path)===pathKey(resources.workspacePath!));
        if(matches.length!==1)throw new BridgeError('PROVENANCE','Original native workspace receipt is unavailable or ambiguous');
        return {...resources,appProjectId:matches[0].projectId};
      }
      if(phase==='codex') {
        if(!resources.codexConversationId)throw new BridgeError('UNSUPPORTED','Formal Codex creation has no durable operation-to-thread receipt; do not infer an ID from titles or resend');
        const inventory=await native.listThreads(signal),thread=[...inventory.threads,...inventory.pinnedThreads].find(item=>item.id===resources.codexConversationId);
        if(!thread || thread.kind!=='codex' || thread.projectId!==resources.appProjectId || !thread.cwd || pathKey(thread.cwd)!==pathKey(resources.workspacePath!))throw new BridgeError('PROVENANCE','Recorded Codex receipt has different native membership');
        return resources;
      }
      if(!resources.initializationKey)throw new BridgeError('PROVENANCE','Original initialization identity was not recorded');
      const candidates=[];
      const inventory=await native.listThreads(signal);
      for(const item of [...inventory.threads,...inventory.pinnedThreads]) {
        if(item.kind!=='chatgpt')continue;
        if(hasInitialization(await native.readThread(item.id,signal),resources.initializationKey))candidates.push(item.id);
      }
      if(candidates.length!==1)throw new BridgeError('PROVENANCE','Original initialization receipt is unavailable or ambiguous; do not repeat');
      return {...resources,chatgptConversationId:candidates[0]};
    },
    // Resource identity is re-read from the native host and the recorded
    // initialization receipt; it does not require the GPT page to be open now.
    async verifyBundle(resources,signal) {
      if(!resources.initializationKey)throw new BridgeError('PROVENANCE','Original initialization identity was not recorded');
      const projects=await native.listProjects(signal), threads=await native.listThreads(signal), chat=await native.readThread(resources.chatgptConversationId,signal);
      const project=projects.projects.find(item=>item.projectId===resources.appProjectId), codex=threads.threads.find(item=>item.id===resources.codexConversationId);
      if (!project || project.projectKind!=='local' || project.hostId!=='local' || project.label!==resources.name || pathKey(project.path)!==pathKey(resources.workspacePath) ||
          !codex || codex.kind!=='codex' || codex.projectId!==resources.appProjectId || !codex.cwd || pathKey(codex.cwd)!==pathKey(resources.workspacePath) || chat.thread.id!==resources.chatgptConversationId || chat.thread.kind!=='chatgpt' || chat.thread.title!==resources.name) throw new BridgeError('PROVENANCE','Native bundle identity, directory, name or Codex membership differs');
      if (!hasInitialization(chat,resources.initializationKey)) throw new BridgeError('PROVENANCE','GPT conversation lacks this operation\'s original initialization receipt');
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
  gptReader?: DesktopGptReader;
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
  const finalGptReply = async (id: string, prompt: string, completed: NativeChatPage, signal: AbortSignal) => {
    const turn=completed.turns[0],replies=turn?.items.filter(item=>item.type==='agentMessage') ?? [];
    if (completed.thread.id!==id || completed.thread.status.type!=='idle' || turn?.status!=='completed' || turn.error || replies.length!==1 ||
        !turn.items.some(item=>item.type==='userMessage' && item.content.some(part=>part.type==='text' && !part.truncated && part.text===prompt)))
      throw new BridgeError('PROVENANCE','No exact completed latest GPT turn; reconcile without resending');
    // Native GPT completion can be synthetic. Read the body only after this
    // boundary and require independent, message-scoped UI completion evidence.
    let result: UiResult;
    if(options.gptReader) {
      const visible=await options.gptReader(id);
      const user=turn.items.find(item=>item.type==='userMessage')!,reply=visible.messages.find(item=>item.role==='assistant' && item.sourceMessageId===replies[0].id);
      if(visible.identityStatus!=='identityVerified' || visible.conversationId!==id || visible.responseInProgress || !visible.completionVerified || !reply?.complete ||
         !visible.messages.some(item=>item.role==='user' && item.sourceMessageId===user.id && item.text===prompt))throw new BridgeError('PROVENANCE','CDP final body lacks exact user/assistant identity or explicit completion');
      result={ok:true,conversationId:id,completionVerified:true,body:reply.text};
    } else result=await ui.call('chat-read-reply',{name:completed.thread.title,conversationId:id,prompt,mode:'gpt'},signal);
    if(result.conversationId!==id || result.completionVerified!==true || !result.body?.trim())throw new BridgeError('PROVENANCE','Final GPT UI identity or completion is unverified');
    const after=await native.readThread(id,signal),latest=after.turns[0],messages=latest?.items.filter(item=>item.type==='agentMessage') ?? [];
    if(after.thread.id!==id || after.thread.kind!=='chatgpt' || after.thread.title!==completed.thread.title || after.thread.status.type!=='idle' ||
        latest?.id!==turn.id || latest.status!=='completed' || latest.error || messages.length!==1 || messages[0].id!==replies[0].id)
      throw new BridgeError('PROVENANCE','GPT turn changed while reading the final body');
    return {content:result.body,sourceConversationId:id,sourceConversationName:after.thread.title,sourceMessageId:messages[0].id,
      actualModel:null,actualReasoningEffort:null,complete:true,evidenceSource:'application-host' as const,
      completionEvidence:{source:options.gptReader?'visible-dom' as const:'windows-uia' as const,turnId:turn.id,userMessageId:turn.items.find(item=>item.type==='userMessage')!.id,
        assistantMessageId:messages[0].id,observedAt:new Date().toISOString(),nativeCompleted:true as const,uiIdle:true as const,...(options.gptReader?{}:{replyActions:true as const})}};
  };
  const ordinaryChat: OrdinaryChatHost = {
    async inspect() {return {source:'application-host',ordinaryChat:true,background:false,exactConversation:true,completeMessages:true,actualGenerationParameters:false,
      createOrdinaryChat:false,createWorkspace:false,models:[],reasoningEfforts:[]};},
    async inspectConversation(id,signal) {
      const page=await native.readThread(id,signal);
      if(page.thread.id!==id || page.thread.kind!=='chatgpt')throw new BridgeError('PROVENANCE','Native conversation is not ChatGPT');
      if(!ordinaryIds.has(id)) {
        await authorize(page,'read',signal);
        const snapshot=(await ui.call('chat-open',{name:page.thread.title,conversationId:id},signal)).snapshot!;
        if(snapshot.conversationId!==id || !snapshot.ordinaryComposer)throw new BridgeError('PROVENANCE','Target is not the exact ordinary GPT conversation');
        ordinaryIds.add(id);
      }
      return {source:'application-host',kind:'ordinary-chat',conversationId:id,name:page.thread.title};
    },
    async generate(id,prompt,{signal}) {
      const before=await native.readThread(id,signal);
      if(before.thread.id!==id || before.thread.kind!=='chatgpt')throw new BridgeError('PROVENANCE','Native generation target differs');
      if(before.thread.status.type!=='idle')throw new BridgeError('CONFLICT','GPT conversation is busy');
      await authorize(before,'send',signal);
      await ui.call('chat-send',{name:before.thread.title,conversationId:id,prompt,mode:'gpt'},signal);
      const {page}=await waitForTurn(id,before,prompt,signal);
      return finalGptReply(id,prompt,page,signal);
    },
    async observeGeneration(id,prompt,signal) {
      const before=await native.readThread(id,signal);
      if(before.thread.id!==id || before.thread.kind!=='chatgpt' || !before.turns[0]?.items.some(item=>item.type==='userMessage' && item.content.some(part=>part.type==='text' && !part.truncated && part.text===prompt)))throw new BridgeError('PROVENANCE','The original GPT request is not the latest native turn');
      await authorize(before,'read',signal);
      return finalGptReply(id,prompt,before,signal);
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
    async execute() {throw new BridgeError('UNSUPPORTED','UIA Work submission lacks native target identity; install the App Server executor');},
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
