import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BridgeError, controlledProcessEnv } from './errors.ts';

/** Native IPC against the signed, same-user desktop host (the ChatGPT/Codex desktop app).
 * Its app tools (`tools/call`, namespace codex_app) are served on `codex-app-tools-<uuid>`;
 * hosts before v26.1021 served them on `codex-browser-use-<uuid>`, which now only answers
 * browser automation and ping. Both use 4-byte length-prefixed JSON-RPC frames. */
type JsonObject = Record<string, unknown>;
export interface NativeChatPage {
  thread: { id: string; kind: string; title: string; status: { type: string } };
  turns: { id: string; status: string; error: unknown; items: (
    { type: 'userMessage'; id: string; content: { type: string; text?: string; truncated?: boolean }[] } |
    { type: 'agentMessage'; id: string; text: string; truncated?: boolean; phase?: string }
  )[] }[];
  /** Newest-first paging of the host (absent on hosts that return one turn only). */
  page?: { nextCursor: string | null; hasMore: boolean };
}
export interface NativePeer { processId: number; processStartedAt: string; appVersion: string | null; pipe: string | null }
/** Host text is untrusted: one line, bounded, for error messages only. */
const brief = (value: unknown, max: number) => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
export interface NativeOptions { carrierThreadId: string; timeoutMs: number; maxFrameBytes: number; maxCandidates: number; worker?: NativeReadWorker }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('IO', 'Invalid native interface response');
  return value as JsonObject;
}
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function identifier(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BridgeError('INPUT', 'A real desktop conversation identifier is required');
  return value;
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
  /** Replaces the worker once the requests already queued have finished. */
  reset(): void { this.queue = this.queue.then(() => this.close()); }
  request(input: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<JsonObject> {
    const deadline = Date.now() + timeoutMs;
    const pending = this.queue.then(() => this.run(input, deadline - Date.now(), signal));
    // Release the queue after failure; the caller retains its original rejection.
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private run(input: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<JsonObject> {
    if (timeoutMs < 1 || signal?.aborted) return Promise.reject(new BridgeError('TIMEOUT', 'Native request cancelled'));
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
        if (bytes > Number(input.maxFrameBytes) + 8192) finish(new BridgeError('IO', 'Native output exceeded its budget'));
      };
      const output = (data: Buffer) => { count(data); if (settled) return; chunks.push(data); if (data.includes(10)) decode(); };
      const diagnostics = (data: Buffer) => count(data);
      const abort = () => finish(new BridgeError('TIMEOUT', 'Native request cancelled'));
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
type ReadTool = 'list_threads' | 'read_thread' | 'list_projects';
type WriteTool = 'set_thread_title';
const WRITES: WriteTool[] = ['set_thread_title'];
export interface NativeThread { id: string; kind: string; title: string; projectId: string | null; cwd: string | null }
export interface NativeProject { projectId: string; projectKind: string; label: string; path: string; hostId: string }
export interface NativeInventory { threads: NativeThread[]; unavailableSources: string[] }
const sharedWorker = new NativeReadWorker();
export const closeNativeWorker = () => sharedWorker.close();

/** One verified peer per client: a changed host process is refused, never retried. */
export class NativeClient {
  private readonly options: NativeOptions;
  private readonly worker: NativeReadWorker;
  private verified: NativePeer | undefined;
  constructor(options: NativeOptions) {
    identifier(options.carrierThreadId);
    this.options = options; this.worker = options.worker ?? sharedWorker;
  }
  /** The verified desktop host of the last call, for diagnostics. */
  get peer(): NativePeer | undefined { return this.verified; }
  private async call(tool: ReadTool | WriteTool, args: JsonObject): Promise<JsonObject> {
    const write = WRITES.includes(tool as WriteTool), id = randomUUID(), prefix = write ? 'acb-write-' : 'acb-readonly-';
    const request = { jsonrpc: '2.0', id, method: 'tools/call', params: { arguments: args, callId: `${prefix}${randomUUID()}`, namespace: 'codex_app',
      threadId: this.options.carrierThreadId, tool, turnId: `${prefix}${randomUUID()}`, callerSource: 'codex' } };
    const envelope = await this.worker.request({ requestJson: JSON.stringify(request), timeoutMs: this.options.timeoutMs, maxFrameBytes: this.options.maxFrameBytes,
      maxCandidates: this.options.maxCandidates, expectedProcessId: this.verified?.processId ?? null, expectedProcessStartedAt: this.verified?.processStartedAt ?? null }, this.options.timeoutMs);
    if (envelope.ok !== true) {
      // The worker keeps the pipe it verified; after the desktop app restarts or updates,
      // that pipe is gone. A fresh worker discovers and verifies the host again next time.
      this.worker.reset();
      throw new BridgeError(envelope.code === 'TIMEOUT' ? 'TIMEOUT' : envelope.code === 'OWNER' ? 'OWNER' : 'IO', `Native worker refused the request at ${brief(envelope.stage, 40)}`, { stage: brief(envelope.stage, 40) });
    }
    const peer = object(envelope.peer);
    if (peer.sameUserSignedHost !== true || !Number.isSafeInteger(peer.processId) || Number(peer.processId) < 1 || typeof peer.processStartedAt !== 'string' ||
        (this.verified && (this.verified.processId !== peer.processId || this.verified.processStartedAt !== peer.processStartedAt))) throw new BridgeError('OWNER', 'Native desktop host changed or is unverified');
    this.verified = { processId: Number(peer.processId), processStartedAt: peer.processStartedAt, appVersion: typeof peer.appVersion === 'string' ? peer.appVersion : null, pipe: typeof peer.pipe === 'string' ? peer.pipe : null };
    const response = object(envelope.response);
    if (response.jsonrpc !== '2.0' || response.id !== id) throw new BridgeError('IO', 'Native response identity mismatch');
    if (response.error !== undefined) {
      // Keep the host's own code and message: they tell a protocol change ("No handler
      // registered for method") from a refused argument within minutes.
      const error = object(response.error), code = Number.isSafeInteger(error.code) ? Number(error.code) : null, message = brief(error.message, 200);
      // The pipe the worker kept may be one that no longer serves app tools (e.g. found
      // before the host opened its app-tools pipe): discover again on the next call. The
      // request itself is not repeated.
      this.worker.reset();
      throw new BridgeError(code === -32602 ? 'IPC_CONFIG' : 'IO', `Native request was rejected: [${code ?? '?'}] ${message || 'no message'}`, { nativeError: { code, message }, pipe: this.verified.pipe });
    }
    const result = object(response.result);
    if (!Array.isArray(result.contentItems)) throw new BridgeError('IO', 'Native tool response has an unexpected shape');
    const text = result.contentItems.filter(item => object(item).type === 'inputText');
    if (text.length !== 1 || typeof object(text[0]).text !== 'string') throw new BridgeError('IO', 'Native tool response has an unexpected shape');
    if (result.success !== true) throw new BridgeError('IO', `Native tool ${tool} failed: ${brief(object(text[0]).text, 300) || 'no message'}`);
    // Writes may answer in plain text; reads must be JSON.
    try { return object(JSON.parse(object(text[0]).text as string)); }
    catch (error) { if (write) return { text: String(object(text[0]).text).slice(0, 2000) }; if (error instanceof BridgeError) throw error; throw new BridgeError('IO', 'Native tool response JSON is invalid'); }
  }
  /** The desktop inventory as the host reports it, including sources it could not list. */
  async inventory(): Promise<NativeInventory> {
    // The desktop catalog supports at most 50 non-pinned rows and has no cursor.
    // Results follow the user's sidebar sorting; a newly created chat is not
    // necessarily first. Callers must inspect every row, or read an exposed ID.
    const result = await this.call('list_threads', { limit: 50 });
    if (result.nextCursor) throw new BridgeError('IO', 'Native inventory requires pagination that this host does not support');
    const rows = [...(Array.isArray(result.pinnedThreads) ? result.pinnedThreads : []), ...(Array.isArray(result.threads) ? result.threads : [])].map(object)
      .map(row => ({ id: String(row.id), kind: String(row.kind), title: String(row.title ?? ''), projectId: typeof row.projectId === 'string' ? row.projectId : null, cwd: typeof row.cwd === 'string' ? row.cwd : null }));
    const unavailableSources = (Array.isArray(result.unavailableSources) ? result.unavailableSources : []).map(source => brief(source, 40));
    return { threads: [...new Map(rows.map(row => [row.id, row])).values()], unavailableSources };
  }
  /** The full inventory. Title uniqueness is proven against it, so a host that could not
   * list its ChatGPT chats is an error, never an empty (seemingly unique) list. */
  async listThreads(): Promise<NativeThread[]> {
    const { threads, unavailableSources } = await this.inventory();
    if (unavailableSources.includes('chatgpt')) throw new BridgeError('DEPENDENCY', 'The desktop app could not list its ChatGPT conversations', { fix: 'Make sure ChatGPT is signed in and online in the desktop app' });
    return threads;
  }
  async listProjects(): Promise<NativeProject[]> {
    const result = await this.call('list_projects', {});
    return (Array.isArray(result.projects) ? result.projects : []).map(object).map(row => ({ projectId: String(row.projectId), projectKind: String(row.projectKind), label: String(row.label ?? ''), path: String(row.path ?? ''), hostId: String(row.hostId ?? '') }));
  }
  async setThreadTitle(threadId: string, source: 'chatgpt' | 'codex', title: string): Promise<void> { await this.call('set_thread_title', { source, threadId: identifier(threadId), title }); }
  /** Reads the newest turn (default), or `turnLimit` newest turns from `cursor` on, newest
   * first. Without `outputs`, tool outputs are left out; message text is always included. */
  async readThread(threadId: string, page: { turnLimit?: number; cursor?: string; outputs?: boolean } = {}): Promise<NativeChatPage> {
    const outputs = page.outputs ?? true;
    const result = await this.call('read_thread', { threadId: identifier(threadId), turnLimit: page.turnLimit ?? 1, ...(page.cursor ? { cursor: page.cursor } : {}),
      includeOutputs: outputs, maxOutputCharsPerItem: outputs ? 20000 : 0 });
    // Hosts have returned turns both beside the thread and nested in it.
    const thread = object(result.thread), turns = Array.isArray(result.turns) ? result.turns : Array.isArray(thread.turns) ? thread.turns : null;
    if (thread.id !== threadId || !turns) throw new BridgeError('PROVENANCE', 'Native conversation page identity differs');
    const paging = result.page ? object(result.page) : undefined;
    return { thread: { id: threadId, kind: String(thread.kind), title: String(thread.title ?? ''), status: { type: String(object(thread.status ?? {}).type ?? '') } }, turns,
      ...(paging ? { page: { nextCursor: typeof paging.nextCursor === 'string' ? paging.nextCursor : null, hasMore: paging.hasMore === true } } : {}) } as NativeChatPage;
  }
}
