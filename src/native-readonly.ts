import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, win32 } from 'node:path';
import { controlledProcessEnv } from './silent-process.ts';
import { BridgeError } from './errors.ts';
import type { NativeChatPage } from './native-messages.ts';

type JsonObject = Record<string, unknown>;
const workerStages = ['input', 'load-native', 'pipe-discovery', 'host-verification', 'connect', 'frame-write', 'frame-read', 'response-shape', 'output'] as const;
export class NativeInterfaceError extends BridgeError {
  readonly stage: string;
  constructor(code: 'TIMEOUT' | 'OWNER' | 'IO', stage: unknown) {
    super(code, 'Native read-only worker refused the request');
    this.stage = workerStages.includes(stage as typeof workerStages[number]) ? String(stage) : 'unknown';
  }
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('IO', 'Invalid native interface response');
  return value as JsonObject;
}
function identifier(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new BridgeError('INPUT', 'A real desktop conversation identifier is required');
  return value;
}
export interface NativeReadOptions {
  carrierThreadId: string;
  timeoutMs: number;
  maxFrameBytes: number;
  maxCandidates: number;
  signal?: AbortSignal;
  /** Trusted embedding/testing only. Never accepted from an MCP request. */
  spawnFn?: typeof spawn;
  worker?: NativeReadWorker;
}
export interface NativePeerEvidence { sameUserSignedHost: true; appVersion: string; foregroundUnchanged: boolean }
export interface NativeToolSummary { name: string; namespace: string; inputSchema: JsonObject }
export interface NativeProjectExpectation { appProjectId: string; workspacePath: string; name: string }
export interface NativeProjectSummary {
  identityMatches: true;
  workspaceSurface: 'native-desktop';
  localHostMatches: true;
  pathMatches: true;
  nameMatches: true;
  /** Inventory of an existing project cannot establish creation or thread membership. */
  creationVerified: false;
  codexMembershipVerified: false;
}
export interface NativeConversationSummary {
  identityMatches: boolean;
  backingKind: 'codex' | 'chatgpt' | 'unknown';
  titleMatches: boolean | null;
  threadFields: string[];
  turnFields: string[];
  itemFields: string[];
  turnCount: number;
  /** Backing kind alone cannot distinguish ordinary ChatGPT from Work. */
  ordinaryChatVerified: false;
  actualGenerationParametersVerified: false;
  projectMappingVerified: false;
}

export class NativeReadWorker {
  private child?: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly spawnFn: typeof spawn;
  constructor(spawnFn: typeof spawn = spawn) { this.spawnFn = spawnFn; }
  close(): void {
    const child = this.child; this.child = undefined;
    if (child?.exitCode === null) child.kill();
  }
  request(input: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<JsonObject> {
    const deadline = Date.now() + timeoutMs;
    const pending = this.queue.then(() => this.run(input, deadline - Date.now(), signal));
    // Release the queue after failure; the caller retains its original rejection.
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private run(input: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<JsonObject> {
    if (timeoutMs < 1 || signal?.aborted) return Promise.reject(new BridgeError('TIMEOUT', 'Native diagnostic cancelled'));
    if (process.platform !== 'win32' && this.spawnFn === spawn) return Promise.reject(new BridgeError('UNSUPPORTED', 'The native desktop pipe host must run on Windows'));
    if (!this.child) {
      const helper = fileURLToPath(new URL('./native-pipe-worker.ps1', import.meta.url));
      const bootstrap = "& ([scriptblock]::Create([System.IO.File]::ReadAllText('" + helper.replaceAll("'", "''") + "')))";
      const executable = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      this.child = this.spawnFn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')],
        { env: controlledProcessEnv(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const child = this.child;
      child.once('close', () => { if (this.child === child) this.child = undefined; });
    }
    const child = this.child;
    return new Promise((resolve, reject) => {
      let settled = false, bytes = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: BridgeError, value?: JsonObject) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        child.stdout!.removeListener('data', output); child.stderr!.removeListener('data', diagnostics);
        child.removeListener('error', failed); child.removeListener('close', closed); child.stdin!.removeListener('error', inputFailed);
        if (error) { this.close(); reject(error); } else resolve(value!);
      };
      const decode = () => {
        try { finish(undefined, object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))); }
        catch { finish(new BridgeError('IO', 'Native worker response is invalid')); }
      };
      const count = (data: Buffer) => {
        bytes += data.length;
        if (bytes > Number(input.maxFrameBytes) + 8192) finish(new BridgeError('IO', 'Native diagnostic output exceeded its budget'));
      };
      const output = (data: Buffer) => { count(data); if (settled) return; chunks.push(data); if (data.includes(10)) decode(); };
      const diagnostics = (data: Buffer) => count(data);
      const abort = () => finish(new BridgeError('TIMEOUT', 'Native diagnostic cancelled'));
      const failed = () => finish(new BridgeError('DEPENDENCY', 'Native read-only worker could not start'));
      const inputFailed = () => finish(new BridgeError('IO', 'Native worker input failed'));
      // EOF is also accepted for existing one-shot trusted transports.
      const closed = (code: number) => {
        if (code === 0 && chunks.length) decode();
        else finish(new BridgeError('IO', 'Native worker failed; private diagnostics omitted'));
      };
      const timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', failed); child.once('close', closed); child.stdin!.on('error', inputFailed);
      child.stdout!.on('data', output); child.stderr!.on('data', diagnostics);
      child.stdin!.write(JSON.stringify({ ...input, timeoutMs }) + '\n');
    });
  }
}
const sharedWorker = new NativeReadWorker();
export const closeNativeReadWorker = () => sharedWorker.close();

/** Read-only transport. No write method, browser, credentials, or capability installation. */
export class NativeDesktopReadClient {
  private readonly options: NativeReadOptions;
  private readonly deadline: number;
  private peerPid: number | undefined;
  private peerStartedAt: string | undefined;
  private busy = false;
  private requests = 0;
  private readonly worker: NativeReadWorker;
  peer: NativePeerEvidence | undefined;
  constructor(options: NativeReadOptions) {
    identifier(options.carrierThreadId);
    for (const [value, min, max] of [[options.timeoutMs, 1, 60000], [options.maxFrameBytes, 4096, 4194304], [options.maxCandidates, 1, 32]]) {
      if (!Number.isInteger(value) || value < min || value > max) throw new BridgeError('CONFIG', 'Invalid native diagnostic budget');
    }
    this.options = { ...options };
    this.worker = options.worker ?? (options.spawnFn ? new NativeReadWorker(options.spawnFn) : sharedWorker);
    this.deadline = Date.now() + options.timeoutMs;
  }
  private async request(method: 'tools/list' | 'tools/call', tool?: 'list_threads' | 'read_thread' | 'list_projects', args?: JsonObject): Promise<JsonObject> {
    if (this.busy) throw new BridgeError('CONFLICT', 'Only one native diagnostic request may run at a time');
    if (++this.requests > 4) throw new BridgeError('STATE', 'Native diagnostic request budget exhausted');
    const remaining = this.deadline - Date.now();
    if (remaining < 1 || this.options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Native diagnostic deadline exceeded');
    const id = randomUUID();
    const request = { jsonrpc: '2.0', id, method, params: method === 'tools/list' ? { threadStartKind: 'all' } : {
      arguments: args, callId: `acb-readonly-${randomUUID()}`, namespace: 'codex_app',
      threadId: this.options.carrierThreadId, tool, turnId: `acb-readonly-${randomUUID()}`,
      // Protocol origin for this existing Codex carrier, not business-role authorization.
      callerSource: 'codex',
    } };
    this.busy = true;
    try {
      const envelope = await this.worker.request({ requestJson: JSON.stringify(request), timeoutMs: remaining, maxFrameBytes: this.options.maxFrameBytes,
        maxCandidates: this.options.maxCandidates, expectedProcessId: this.peerPid ?? null, expectedProcessStartedAt: this.peerStartedAt ?? null }, remaining, this.options.signal);
      if (envelope.ok !== true) throw new NativeInterfaceError(envelope.code === 'TIMEOUT' ? 'TIMEOUT' : envelope.code === 'OWNER' ? 'OWNER' : 'IO', envelope.stage);
      const peer = object(envelope.peer);
      if (peer.sameUserSignedHost !== true || !Number.isSafeInteger(peer.processId) || Number(peer.processId) < 1 || typeof peer.appVersion !== 'string' || !/^\d+(?:\.\d+){1,4}$/.test(peer.appVersion) ||
          typeof peer.foregroundUnchanged !== 'boolean' || typeof peer.processStartedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(peer.processStartedAt) ||
          this.peerPid !== undefined && (this.peerPid !== peer.processId || this.peerStartedAt !== peer.processStartedAt)) throw new BridgeError('OWNER', 'Native desktop host changed or is unverified');
      this.peerPid = Number(peer.processId);
      this.peerStartedAt = peer.processStartedAt;
      this.peer = { sameUserSignedHost: true, appVersion: peer.appVersion, foregroundUnchanged: (this.peer?.foregroundUnchanged ?? true) && peer.foregroundUnchanged };
      const response = object(envelope.response);
      if (response.jsonrpc !== '2.0' || response.id !== id) throw new BridgeError('IO', 'Native response identity mismatch');
      if (response.error !== undefined) {
        const error = object(response.error);
        // Never report raw host messages or assume that -32602 is an auth/risk refusal.
        throw new BridgeError(error.code === -32602 ? 'IPC_CONFIG' : 'IO', 'Native request was rejected; private diagnostics omitted');
      }
      const result = object(response.result);
      if (method === 'tools/list') return result;
      if (result.success !== true || !Array.isArray(result.contentItems)) throw new BridgeError('IO', 'Native tool did not report success');
      const text = result.contentItems.filter(item => object(item).type === 'inputText');
      if (text.length !== 1 || typeof object(text[0]).text !== 'string') throw new BridgeError('IO', 'Native tool response has an unexpected shape');
      try { return object(JSON.parse(object(text[0]).text as string)); }
      catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('IO', 'Native tool response JSON is invalid'); }
    } finally { this.busy = false; }
  }
  async catalog(): Promise<NativeToolSummary[]> {
    const result = await this.request('tools/list');
    if (!Array.isArray(result.tools) || result.tools.length > 1000) throw new BridgeError('IO', 'Invalid native tool catalog');
    // Catalog metadata is read-only. Retain newly advertised tool schemas for
    // compatibility checks; request() still permits only the two fixed reads.
    const tools = result.tools.map(object).filter(tool => tool.namespace === 'codex_app');
    if (tools.some(tool => typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]{0,100}$/.test(tool.name))) throw new BridgeError('IO', 'Invalid native tool name');
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new BridgeError('IO', 'Ambiguous native tool catalog');
    return tools.map(tool => ({ name: String(tool.name), namespace: 'codex_app', inputSchema: object(tool.inputSchema) }));
  }
  async listSummary(): Promise<{ currentCarrierVisible: boolean; chatgptBackingVisible: boolean }> {
    const result = await this.request('tools/call', 'list_threads', { limit: 1 });
    if (!Array.isArray(result.pinnedThreads) || !Array.isArray(result.threads)) throw new BridgeError('IO', 'Invalid native thread inventory');
    const rows = [...result.pinnedThreads, ...result.threads].map(object);
    return { currentCarrierVisible: rows.some(row => row.id === this.options.carrierThreadId), chatgptBackingVisible: rows.some(row => row.kind === 'chatgpt') };
  }
  async projectInventory(): Promise<{ projects: { projectId: string; projectKind: string; label: string; path: string; hostId: string }[] }> {
    return await this.request('tools/call', 'list_projects', {}) as unknown as Awaited<ReturnType<NativeDesktopReadClient['projectInventory']>>;
  }
  async threadInventory(): Promise<{ threads: { id: string; kind: string; title: string; projectId?: string | null; cwd?: string }[]; pinnedThreads: { id: string; kind: string; title: string }[] }> {
    return await this.request('tools/call', 'list_threads', { limit: 30 }) as unknown as Awaited<ReturnType<NativeDesktopReadClient['threadInventory']>>;
  }
  async readConversationPage(conversationId: string): Promise<NativeChatPage> {
    identifier(conversationId);
    const page = await this.request('tools/call', 'read_thread', { threadId: conversationId, turnLimit: 1, includeOutputs: true, maxOutputCharsPerItem: 20000 }) as unknown as NativeChatPage;
    if (page.thread.id !== conversationId) throw new BridgeError('PROVENANCE', 'Native conversation page identity differs');
    return page;
  }
  async projectSummary(expected: NativeProjectExpectation): Promise<NativeProjectSummary> {
    identifier(expected.appProjectId);
    if (typeof expected.name !== 'string' || !expected.name.trim() || typeof expected.workspacePath !== 'string' || !win32.isAbsolute(expected.workspacePath)) throw new BridgeError('INPUT', 'An exact native project name and absolute Windows path are required');
    const result = await this.request('tools/call', 'list_projects', {});
    if (result.schemaVersion !== 2 || !Array.isArray(result.projects) || result.projects.length > 1000) throw new BridgeError('IO', 'Unrecognized native project inventory');
    const projects = result.projects.map(object);
    if (projects.some(project => typeof project.projectId !== 'string') || new Set(projects.map(project => project.projectId)).size !== projects.length) throw new BridgeError('IO', 'Ambiguous native project identities');
    const project = projects.find(project => project.projectId === expected.appProjectId);
    if (!project) throw new BridgeError('NOT_FOUND', 'Expected native project was not listed');
    const pathKey = (path: string) => win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase();
    if (project.projectKind !== 'local' || project.hostId !== 'local' || project.label !== expected.name || typeof project.path !== 'string' || !win32.isAbsolute(project.path) || pathKey(project.path) !== pathKey(expected.workspacePath) ||
        projects.some(other => other !== project && other.projectKind === 'local' && other.hostId === 'local' && typeof other.path === 'string' && pathKey(other.path) === pathKey(expected.workspacePath))) throw new BridgeError('PROVENANCE', 'Native project identity, host, name or directory differs');
    return { identityMatches: true, workspaceSurface: 'native-desktop', localHostMatches: true, pathMatches: true, nameMatches: true, creationVerified: false, codexMembershipVerified: false };
  }
  async readSummary(conversationId: string, expectedTitle?: string): Promise<NativeConversationSummary> {
    identifier(conversationId);
    const result = await this.request('tools/call', 'read_thread', { threadId: conversationId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 });
    const thread = object(result.thread);
    if (thread.id !== conversationId) throw new BridgeError('PROVENANCE', 'Native read returned a different conversation');
    if (!Array.isArray(result.turns) || result.turns.length > 1) throw new BridgeError('IO', 'Native read returned an invalid turn window');
    const turns = result.turns.map(object), items = turns.flatMap(turn => Array.isArray(turn.items) ? turn.items.map(object) : []);
    const fields = (rows: JsonObject[], allowed: string[]) => allowed.filter(key => rows.some(row => Object.hasOwn(row, key)));
    return { identityMatches: true, backingKind: thread.kind === 'codex' || thread.kind === 'chatgpt' ? thread.kind : 'unknown',
      titleMatches: expectedTitle === undefined ? null : thread.title === expectedTitle,
      threadFields: fields([thread], ['id', 'kind', 'title', 'status', 'cwd', 'projectId', 'model', 'reasoningEffort', 'mode']),
      turnFields: fields(turns, ['id', 'status', 'error', 'items', 'model', 'reasoningEffort']),
      itemFields: fields(items, ['id', 'type', 'phase', 'text', 'content', 'model', 'reasoningEffort']), turnCount: turns.length,
      ordinaryChatVerified: false, actualGenerationParametersVerified: false, projectMappingVerified: false };
  }
}

export async function checkNativeDesktop(options: NativeReadOptions & { conversationId?: string; expectedTitle?: string }) {
  const client = new NativeDesktopReadClient(options);
  const tools = await client.catalog();
  if (!tools.some(tool => tool.name === 'read_thread') || !tools.some(tool => tool.name === 'list_threads')) throw new BridgeError('UNSUPPORTED', 'Required native read tools are unavailable');
  const carrier = await client.readSummary(options.carrierThreadId);
  if (carrier.backingKind !== 'codex') throw new BridgeError('PROVENANCE', 'The existing native carrier must be a Codex task');
  const inventory = await client.listSummary();
  const target = options.conversationId ? await client.readSummary(options.conversationId, options.expectedTitle) : null;
  return { ok: true, readOnly: true, peer: client.peer, catalogTools: tools.map(tool => tool.name), carrier, inventory, target,
    messagesSent: false, realModelInvoked: false, credentialsRead: false, executionAuthorized: false, fullWorkflowReady: false };
}
