import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeConfig } from './config.ts';
import { BridgeError, classifyError, EXIT_CODES, type ErrorCode } from './errors.ts';
import { controlledProcessEnv } from './silent-process.ts';
import { requireNoSecrets, redact } from './security.ts';
import type { NativeChatPage } from './native-messages.ts';
import type { InitializationEffect, InitializationScope, ProjectHost, ProjectHostCapabilities } from './project-provisioner.ts';
import { NativeDesktopReadClient } from './native-readonly.ts';
import type { VisibleGptSnapshot,DesktopGptReader } from './desktop-gpt-reader.ts';
import type { OrdinaryChatHost } from './ordinary-chat.ts';
import type { BackgroundExecutor } from './background-runner.ts';

export interface WindowsNativeTools {
  listProjects(signal: AbortSignal): Promise<{ projects: { projectId: string; projectKind: string; label: string; path: string; hostId: string }[] }>;
  listThreads(signal: AbortSignal): Promise<{ threads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[]; pinnedThreads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[] }>;
  readThread(id: string, signal: AbortSignal): Promise<NativeChatPage>;
  /** Formal native create_thread for one local project. The fixed initial prompt
   * is the durable receipt; the returned thread ID may be absent if the reply is lost. */
  createCodexThread?(input: { projectId: string; title: string; prompt: string }, signal: AbortSignal): Promise<{ threadId?: string }>;
}
export interface WindowsUiSnapshot { title: string; text: string; ordinaryComposer: boolean; pid: number; conversationId: string | null }
/** Read-only state of the native "add project" entry; constants only. */
export interface WorkspaceEntry { state: 'ready' | 'missing' | 'ambiguous' | 'offscreen' | 'disabled' | 'not-invokable'; count: number; offscreen?: boolean; enabled?: boolean; invoke?: boolean; scrollItem?: boolean; emptyBounds?: boolean; arranged?: boolean; ancestors?: string[] }
interface UiResult { ok: boolean; code?: string; stage?: string; target?: string; errorType?: string; line?: number; ordinaryModeObserved?: boolean; snapshot?: WindowsUiSnapshot; body?: string; conversationId?: string; completionVerified?: boolean; entry?: WorkspaceEntry; effectsStarted?: boolean; timings?: { initMs: number; actionMs: number } }
const pathKey = (value: string) => win32.normalize(value).toLowerCase();
const UI_REPORT_GRACE_MS = 5000;
const initializationPrompt = (key: string) => `这是 Agent Control Bridge 的会话身份初始化，不执行工程任务。请只回复：ACB_INIT_${key}。`;
/** Must stay identical to the pattern the native pipe worker accepts for create_thread. */
export const codexInitializationPrompt = (key: string, index: number) => `这是 Agent Control Bridge 的 Codex 会话身份初始化，不执行工程任务，不读取或修改任何文件。请只回复：ACB_CODEX_INIT_${key}_${index}。`;
const hasPrompt = (page: NativeChatPage, prompt: string) => page.turns.some(turn => turn.items.some(message => message.type === 'userMessage' &&
  message.content.some(part => part.type === 'text' && !part.truncated && (part.text === prompt || (page.thread.kind === 'codex' && part.text === `${prompt}\n`)))));
// The worker sends this exact prompt only after observing a blank ordinary chat,
// so its native readback is a durable receipt that survives Bridge restarts.
const hasInitialization = (page: NativeChatPage, key: string) => hasPrompt(page, initializationPrompt(key));
const operationKeyPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function createWindowsNativeReadTools(config: BridgeConfig, carrierThreadId: string, createCodexThread?: WindowsNativeTools['createCodexThread']): WindowsNativeTools {
  const client = (signal: AbortSignal) => new NativeDesktopReadClient({carrierThreadId,...config.nativeInterface,signal});
  return { listProjects: signal => client(signal).projectInventory(), listThreads: signal => client(signal).threadInventory(),
    readThread: (id,signal) => client(signal).readConversationPage(id), createCodexThread };
}

type NativeInventory = Awaited<ReturnType<WindowsNativeTools['listThreads']>>;
/** list_threads returns only a bounded recent window. A recorded ID outside it
 * is read exactly, and its fields count only if that read names the same thread. */
export async function findNativeThread(native: WindowsNativeTools, id: string, signal: AbortSignal, inventory?: NativeInventory): Promise<NativeInventory['threads'][number] | undefined> {
  const listed = inventory ?? await native.listThreads(signal), row = [...listed.threads, ...listed.pinnedThreads].find(item => item.id === id);
  if (row) return row;
  const thread = (await native.readThread(id, signal)).thread;
  return thread.id === id ? { id: thread.id, kind: thread.kind, title: thread.title, projectId: thread.projectId ?? null, cwd: thread.cwd } : undefined;
}

/** Fixed OS control operations. There is no public arbitrary UI/RPC tool. */
const uiWorkers = new Set<WindowsNativeUi>();
export const closeWindowsNativeUiWorkers = () => { for (const worker of uiWorkers) worker.close(); };
export class WindowsNativeUi {
  private readonly config: BridgeConfig;
  private child?: ReturnType<typeof spawn>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStage = '';
  constructor(config: BridgeConfig) { this.config = config; }
  close(): void { this.child?.kill(); this.child=undefined; uiWorkers.delete(this); }
  call(operation: 'workspace-create' | 'workspace-entry' | 'gpt-create' | 'gpt-rename' | 'snapshot' | 'identity' | 'gpt-read' | 'chat-open' | 'chat-send' | 'chat-read-reply' | 'uia-diagnose', fields: { name: string; conversationId?: string; path?: string; projectName?: string; prompt?: string; marker?: string; expectedTitle?: string; mode?: 'gpt' | 'codex'; arrange?: boolean }, signal: AbortSignal): Promise<UiResult> {
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
      // Forward only the worker's own stage/diagnostic lines; remember the last stage.
      started.stderr!.setEncoding('utf8');
      let partial='';
      started.stderr!.on('data',(chunk:string)=>{
        const lines=(partial+chunk).split(/\r?\n/);partial=lines.pop()!.slice(-65536);
        for(const line of lines){if(!line.startsWith('ACB_UI_'))continue;if(line.startsWith('ACB_UI_STAGE='))this.lastStage=line.slice(13,160);process.stderr.write(line+'\n');}
      });
      uiWorkers.add(this);
    }
    const child=this.child;
    this.lastStage='';
    return new Promise((resolve,reject)=>{
      let output='';
      const finish=(error?: BridgeError,result?: UiResult)=>{
        clearTimeout(timer);signal.removeEventListener('abort',abort);
        child.stdout!.removeListener('data',read);child.removeListener('error',failed);child.removeListener('close',closed);child.stdin!.removeListener('error',inputFailed);
        if(error){this.close();reject(error);}else resolve(result!);
      };
      const abort=()=>finish(new BridgeError('TIMEOUT',`Native UI operation interrupted${this.lastStage?` at ${this.lastStage}`:''}; reconcile without resending`));
      const failed=()=>finish(new BridgeError('DEPENDENCY','Windows UI worker could not start'));
      const closed=()=>finish(new BridgeError('IO','Windows UI worker exited; reconcile without resending'));
      const inputFailed=()=>finish(new BridgeError('IO','Windows UI worker input failed'));
      const read=(chunk: Buffer)=>{
        output+=String(chunk);
        if(output.length>1048576){finish(new BridgeError('PROVENANCE','Native UI response exceeds its bound'));return;}
        if(!output.includes('\n'))return;
        try {
          const result=JSON.parse(output) as UiResult;
          if(!result.ok)throw new BridgeError(Object.hasOwn(EXIT_CODES,result.code ?? '')?result.code as ErrorCode:'EXECUTION',`Native UI operation failed at ${result.stage}${result.target?` waiting for ${result.target}`:''} (${result.errorType}, line ${result.line})${result.entry?` entry=${JSON.stringify(result.entry).slice(0,240)}`:''}${result.effectsStarted===false?'; no native effect was started':''}`);
          if(result.snapshot)result.snapshot.text=redact(result.snapshot.text);
          if(result.body)result.body=redact(result.body);
          finish(undefined,result);
        }catch(error){finish(error instanceof BridgeError?error:new BridgeError('IO','Windows UI worker returned an unreadable result'));}
      };
      // The worker reports its own stage within a smaller budget; this outer
      // bound only covers a worker that stops answering.
      const timer=setTimeout(abort,this.config.background.timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      child.stdout!.on('data',read);child.once('error',failed);child.once('close',closed);child.stdin!.on('error',inputFailed);
      // A smaller worker budget lets it report its own stage before outer deadlines fire.
      child.stdin!.write(JSON.stringify({operation,...fields,timeoutMs:Math.max(1000,this.config.background.timeoutMs-UI_REPORT_GRACE_MS),pollMs:this.config.desktop.uiPollMs})+'\n');
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
export type InitializationRequest = InitializationScope & { effect?: InitializationEffect };
export function createWindowsNativeProjectHost(options: { config: BridgeConfig; native: WindowsNativeTools; authorizeInitialization: (name: string, path: string, signal: AbortSignal, request?: InitializationRequest) => Promise<boolean>; ui?: WindowsNativeUi }): ProjectHost {
  const { config, native } = options, ui = options.ui ?? new WindowsNativeUi(config);
  // Every native effect is approved for its own operation attempt and effect kind.
  const grant = async (name: string, path: string, signal: AbortSignal, scope: InitializationScope | undefined, effect: InitializationEffect) => {
    if (!scope || !scope.effects.includes(effect) || !await options.authorizeInitialization(name, path, signal, { ...scope, effect })) throw new BridgeError('AUTH', `Approval for this operation attempt's ${effect} initialization is required`);
  };
  const capabilities: ProjectHostCapabilities = { createCodexConversation:!!native.createCodexThread,source: 'application-host', workspaceSurface: 'native-desktop', ordinaryChat: true, background: false,
    exactConversation: true, completeMessages: false, actualGenerationParameters: false, createOrdinaryChat: true, createWorkspace: true, models: [], reasoningEfforts: [] };
  /** The unique recent Codex member of this workspace whose own turn carries the exact prompt. */
  const findCodexReceipt = async (appProjectId: string, workspacePath: string, prompt: string, signal: AbortSignal): Promise<string | undefined> => {
    const inventory = await native.listThreads(signal), found: string[] = [];
    for (const item of [...inventory.threads, ...inventory.pinnedThreads]) {
      if (item.kind !== 'codex' || item.projectId !== appProjectId || !item.cwd || pathKey(item.cwd) !== pathKey(workspacePath) || found.includes(item.id)) continue;
      const page = await native.readThread(item.id, signal);
      if (page.thread.id === item.id && page.thread.kind === 'codex' && hasPrompt(page, prompt)) found.push(item.id);
    }
    if (found.length > 1) throw new BridgeError('PROVENANCE', 'Several Codex conversations carry the same initialization receipt; do not guess');
    return found[0];
  };
  const poll = async <T>(read: () => Promise<T | undefined>, signal: AbortSignal): Promise<T> => {
    const deadline = Date.now() + config.nativeInterface.timeoutMs;
    do { const value = await read(); if (value !== undefined) return value; if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'Native creation readback is pending; do not create replacements'); await delay(config.desktop.uiPollMs, undefined, { signal }); } while (!signal.aborted);
    throw new BridgeError('TIMEOUT', 'Native creation readback was cancelled');
  };
  return {
    inspect: async () => capabilities,
    async authorizeInitialization(name,path,signal,scope){if(!scope?.effects.length || !await options.authorizeInitialization(name,path,signal,scope))throw new BridgeError('AUTH','Project-scoped initialization approval is required');},
    async probeWorkspaceEntry(signal) {
      const entry = (await ui.call('workspace-entry', { name: '', arrange: true }, signal)).entry;
      // A hidden entry is never invoked; the operator shows the sidebar project list first.
      if (entry?.state !== 'ready') throw new BridgeError('STATE', `Native workspace entry is ${entry?.state ?? 'unreported'} (${JSON.stringify(entry ?? {}).slice(0, 240)}); show the sidebar project list in its normal view and retry. Nothing was started`);
    },
    async createWorkspace(name, path, signal, scope) {
      await grant(name, path, signal, scope, 'native-workspace');
      // A path already registered natively is never registered again.
      if ((await native.listProjects(signal)).projects.some(item => pathKey(item.path) === pathKey(path))) throw new BridgeError('CONFLICT', 'This directory is already a native workspace; reconcile instead of creating');
      await ui.call('workspace-create', {name,path},signal);
      const project = await poll(async () => {
        const matches = (await native.listProjects(signal)).projects.filter(item => pathKey(item.path) === pathKey(path));
        if (matches.length > 1) throw new BridgeError('PROVENANCE', 'Several native workspaces share this directory; do not guess');
        if (matches[0] && (matches[0].projectKind !== 'local' || matches[0].hostId !== 'local' || matches[0].label !== name)) throw new BridgeError('PROVENANCE', 'The native workspace for this directory has a different name or host');
        return matches[0];
      },signal);
      return { appProjectId: project.projectId, workspacePath: project.path };
    },
    async verifyCodexMember(input, signal) {
      const project = (await native.listProjects(signal)).projects.find(item => item.projectId === input.appProjectId);
      if (!project || project.projectKind !== 'local' || project.hostId !== 'local' || pathKey(project.path) !== pathKey(input.workspacePath) || (input.name !== undefined && project.label !== input.name)) throw new BridgeError('PROVENANCE', 'Recorded native workspace is missing, renamed or has moved');
      const thread = await findNativeThread(native, input.conversationId, signal);
      if (!thread || thread.kind !== 'codex' || thread.projectId !== input.appProjectId || !thread.cwd || pathKey(thread.cwd) !== pathKey(input.workspacePath)) throw new BridgeError('PROVENANCE', 'Conversation is not a Codex member of this native workspace and directory');
    },
    async nativeWorkspaces(path, signal) {
      return (await native.listProjects(signal)).projects.filter(item => pathKey(item.path) === pathKey(path)).map(item => ({ projectId: item.projectId, label: item.label }));
    },
    async createOrdinaryChat(_appProjectId, name, signal, operationKey, scope) {
      // Without a recorded operation key the receipt could never be verified after a restart.
      if(!operationKey)throw new BridgeError('PROVENANCE','A recorded initialization operation key is required');
      const project=(await native.listProjects(signal)).projects.find(item=>item.projectId===_appProjectId && item.label===name);
      if(!project)throw new BridgeError('AUTH','This new GPT initialization requires target-bound host approval');
      await grant(name,project.path,signal,scope,'ordinary-gpt');
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
    async createCodexConversation(appProjectId,workspacePath,signal,operationKey,index=0,scope) {
      if(!native.createCodexThread)throw new BridgeError('UNSUPPORTED','A formal native Codex creation callback is required; GPT URI cannot prove Work identity');
      if(!operationKey || !operationKeyPattern.test(operationKey) || !Number.isInteger(index) || index<0 || index>99)throw new BridgeError('PROVENANCE','A recorded initialization operation key is required');
      const project=(await native.listProjects(signal)).projects.find(item=>item.projectId===appProjectId);
      if(!project || project.projectKind!=='local' || project.hostId!=='local' || pathKey(project.path)!==pathKey(workspacePath))throw new BridgeError('PROVENANCE','Recorded native workspace is missing or has moved');
      await grant(project.label,project.path,signal,scope,'codex-thread');
      const title=index?`${project.label} Codex ${index+1}`:`${project.label} Codex`,prompt=codexInitializationPrompt(operationKey,index);
      const inventory=await native.listThreads(signal),known=new Set([...inventory.threads,...inventory.pinnedThreads].map(item=>item.id));
      if(await findCodexReceipt(appProjectId,workspacePath,prompt,signal))throw new BridgeError('CONFLICT','This Codex creation already has a receipt; reconcile instead of creating');
      let threadId:string | undefined,lost:unknown;
      try {threadId=(await native.createCodexThread({projectId:appProjectId,title,prompt},signal)).threadId;}
      catch(error) {
        // Refusals before the call (schema, input, rejected parameters) cannot have created a
        // thread and are reported as UNSUPPORTED; anything else may have, so read the receipt.
        if(error instanceof BridgeError && ['UNSUPPORTED','IPC_CONFIG','INPUT'].includes(error.code))throw new BridgeError('UNSUPPORTED',`Formal Codex creation was refused before any native effect (${error.code})`);
        lost=error;
      }
      // A receipt naming a thread that existed before this call is not a new conversation.
      if(threadId!==undefined && known.has(threadId))throw new BridgeError('PROVENANCE','Formal Codex receipt does not name a new thread');
      // The thread counts only once its own initialization prompt is read back natively.
      const id=await poll(async()=>{
        if(threadId===undefined)return findCodexReceipt(appProjectId,workspacePath,prompt,signal);
        const page=await native.readThread(threadId,signal);
        if(page.thread.id!==threadId || page.thread.kind!=='codex' || (page.thread.projectId!==undefined && page.thread.projectId!==appProjectId) || (page.thread.cwd!==undefined && pathKey(page.thread.cwd)!==pathKey(workspacePath)))throw new BridgeError('PROVENANCE','Formal Codex receipt names a thread of another kind, project or directory');
        return hasPrompt(page,prompt)?threadId:undefined;
      },signal).catch(error=>{
        if(lost===undefined)throw error;
        const failure=classifyError(lost);
        throw new BridgeError(failure.code,`${failure.message}; no initialization receipt was read back, reconcile without resending`);
      });
      return {conversationId:id};
    },
    async observeCodexCreation(input,signal) {
      if(!operationKeyPattern.test(input.operationKey))throw new BridgeError('PROVENANCE','Original initialization identity was not recorded');
      return findCodexReceipt(input.appProjectId,input.workspacePath,codexInitializationPrompt(input.operationKey,input.index),signal);
    },
    async observePartial(resources,phase,signal) {
      if(phase==='workspace') {
        const matches=(await native.listProjects(signal)).projects.filter(item=>item.projectKind==='local' && item.hostId==='local' && item.label===resources.name && pathKey(item.path)===pathKey(resources.workspacePath!));
        if(matches.length!==1)throw new BridgeError('PROVENANCE','Original native workspace receipt is unavailable or ambiguous');
        return {...resources,appProjectId:matches[0].projectId};
      }
      if(phase==='codex' || phase==='codex.extra') {
        if(phase==='codex' && resources.codexConversationId) {
          const thread=await findNativeThread(native,resources.codexConversationId,signal);
          if(!thread || thread.kind!=='codex' || thread.projectId!==resources.appProjectId || !thread.cwd || pathKey(thread.cwd)!==pathKey(resources.workspacePath!))throw new BridgeError('PROVENANCE','Recorded Codex receipt has different native membership');
          return resources;
        }
        // Only this operation's own initialization prompt identifies the lost thread; never a title.
        const extras=resources.extraCodexConversationIds ?? [],index=phase==='codex'?0:1+extras.length;
        if(!resources.initializationKey || !operationKeyPattern.test(resources.initializationKey))throw new BridgeError('UNSUPPORTED','Formal Codex creation has no recorded initialization receipt; do not infer an ID from titles or resend');
        const id=await findCodexReceipt(resources.appProjectId!,resources.workspacePath!,codexInitializationPrompt(resources.initializationKey,index),signal);
        if(!id)throw new BridgeError('PROVENANCE','The original Codex creation has no readable initialization receipt; do not resend');
        return phase==='codex'?{...resources,codexConversationId:id}:{...resources,extraCodexConversationIds:[...extras,id]};
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
    // Migrated projects have no ACB_INIT receipt. The native project comes from
    // the recorded Codex threads' membership, then must match path and name; a
    // name alone never selects a project.
    async verifyExisting(input,signal) {
      const projects=(await native.listProjects(signal)).projects,inventory=await native.listThreads(signal),members=[];
      for(const id of input.codexConversationIds)members.push(await findNativeThread(native,id,signal,inventory));
      const appProjectId=members[0]?.projectId;
      if(!appProjectId || members.some(item=>!item || item.kind!=='codex' || item.projectId!==appProjectId || !item.cwd || pathKey(item.cwd)!==pathKey(input.workspacePath)))throw new BridgeError('PROVENANCE','Recorded Codex conversations do not share this native workspace');
      const project=projects.find(item=>item.projectId===appProjectId);
      if(!project || project.projectKind!=='local' || project.hostId!=='local' || project.label!==input.name || pathKey(project.path)!==pathKey(input.workspacePath))throw new BridgeError('PROVENANCE','Native workspace name or directory differs from the legacy mapping');
      const chat=await native.readThread(input.chatgptConversationId,signal);
      if(chat.thread.id!==input.chatgptConversationId || chat.thread.kind!=='chatgpt' || chat.thread.title!==input.name)throw new BridgeError('PROVENANCE','Recorded GPT conversation is missing or not the same-name ordinary chat');
      return {appProjectId};
    },
    // Resource identity is re-read from the native host and the recorded
    // initialization receipt; it does not require the GPT page to be open now.
    async verifyBundle(resources,signal) {
      if(!resources.initializationKey)throw new BridgeError('PROVENANCE','Original initialization identity was not recorded');
      const projects=await native.listProjects(signal), threads=await native.listThreads(signal), chat=await native.readThread(resources.chatgptConversationId,signal);
      const project=projects.projects.find(item=>item.projectId===resources.appProjectId), codex=await findNativeThread(native,resources.codexConversationId,signal,threads);
      // Every additional Codex conversation must be a distinct member of the same workspace.
      const extras=resources.extraCodexConversationIds ?? [],members=[];
      for(const id of extras)members.push(await findNativeThread(native,id,signal,threads));
      if(new Set([resources.codexConversationId,...extras]).size!==extras.length+1 || members.some(item=>!item || item.kind!=='codex' || item.projectId!==resources.appProjectId || !item.cwd || pathKey(item.cwd)!==pathKey(resources.workspacePath)))
        throw new BridgeError('PROVENANCE','Additional Codex conversations are missing, duplicated or belong elsewhere');
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
      const thread=await findNativeThread(native,target.codexConversationId,signal);
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
