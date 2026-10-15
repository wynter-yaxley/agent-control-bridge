import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, controlledProcessEnv } from './errors.ts';

type Row = Record<string, any>;
const ID = /^[a-zA-Z0-9_-]{1,200}$/;

/** One owned `codex app-server` stdio process. This bridge never grants command or
 * file approvals on the user's behalf: such requests are declined and counted. */
class AppServer {
  private readonly child: ChildProcess;
  private sequence = 0;
  private buffer = '';
  declined = 0;
  private failure?: BridgeError;
  private pending = new Map<number, { resolve: (value: Row) => void; reject: (error: BridgeError) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(executable: string, spawnFn: typeof nodeSpawn) {
    this.child = spawnFn(executable, ['app-server', '--listen', 'stdio://'], { shell: false, windowsHide: true, env: controlledProcessEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.once('error', () => this.fail(new BridgeError('DEPENDENCY', 'Codex app-server could not start')));
    this.child.once('close', () => this.fail(new BridgeError('EXECUTION', 'Codex app-server exited')));
    this.child.stderr?.on('data', () => {});
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (data: string) => {
      this.buffer += data;
      for (let end; (end = this.buffer.indexOf('\n')) >= 0;) { const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); this.receive(line); }
      if (this.buffer.length > 8388608) this.fail(new BridgeError('EXECUTION', 'App-server frame is too large'));
    });
  }
  private receive(line: string): void {
    let message: Row;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message?.method === 'string') {
      if (message.id === undefined) return;
      if (message.method.endsWith('/requestApproval')) { this.declined++; this.write({ id: message.id, result: { decision: 'decline' } }); }
      else this.write({ id: message.id, error: { code: -32601, message: 'Not supported by Agent Control Bridge' } });
      return;
    }
    const item = this.pending.get(message?.id);
    if (!item) return;
    this.pending.delete(message.id); clearTimeout(item.timer);
    if (message.error || !message.result) item.reject(new BridgeError('EXECUTION', `App-server rejected the request${typeof message.error?.message === 'string' ? `: ${message.error.message.slice(0, 200)}` : ''}`));
    else item.resolve(message.result);
  }
  private write(message: unknown): void { if (!this.failure) this.child.stdin?.write(JSON.stringify(message) + '\n'); }
  private fail(error: BridgeError): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  request(method: string, params: Row, timeoutMs = 60000): Promise<Row> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject, timer: setTimeout(() => { this.pending.delete(id); reject(new BridgeError('TIMEOUT', `App-server ${method} timed out`)); }, timeoutMs) });
      this.write({ id, method, params });
    });
  }
  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'agent_control_bridge', title: 'Agent Control Bridge', version: '0.3.0' }, capabilities: { experimentalApi: true } }, 30000);
    this.write({ method: 'initialized', params: {} });
  }
  close(): void { this.fail(new BridgeError('IO', 'App-server connection closed')); try { this.child.kill(); } catch { /* already gone */ } }
}

export interface CodexOptions { executable: string; timeoutMs: number; pollMs: number; spawnFn?: typeof nodeSpawn }
export interface CodexReply { threadId: string; turnId: string; reply: string; messageIds: string[]; alreadySent: boolean; approvalsDeclined: number }
const asks = (turn: Row | undefined, prompt: string) => Array.isArray(turn?.items) && turn.items.some((item: Row) => item?.type === 'userMessage' && Array.isArray(item.content) && item.content.some((part: Row) => typeof part?.text === 'string' && part.text.trim() === prompt));
function replyOf(threadId: string, turn: Row, alreadySent: boolean, declined: number): CodexReply {
  if (turn.status !== 'completed' || turn.error != null) throw new BridgeError('EXECUTION', `Codex turn ended as ${String(turn.status)}${declined ? ` after ${declined} declined approval request(s)` : ''}`);
  const replies = (turn.items as Row[]).filter(item => item?.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string' && item.text.trim());
  if (!replies.length) throw new BridgeError('PROVENANCE', 'Completed Codex turn has no reply text');
  return { threadId, turnId: String(turn.id), reply: replies.map(item => item.text).join('\n\n'), messageIds: replies.map(item => String(item.id)), alreadySent, approvalsDeclined: declined };
}
const checkPrompt = (prompt: unknown) => {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 65536) throw new BridgeError('INPUT', 'Prompt must be 1..65536 characters');
  return prompt.replace(/\r\n/g, '\n').trim();
};
async function session<T>(options: CodexOptions, run: (server: AppServer) => Promise<T>): Promise<T> {
  const server = new AppServer(options.executable, options.spawnFn ?? nodeSpawn);
  try { await server.initialize(); return await run(server); } finally { server.close(); }
}
async function readThread(server: AppServer, threadId: string): Promise<Row> {
  const thread = (await server.request('thread/read', { threadId, includeTurns: true })).thread;
  if (thread?.id !== threadId || !Array.isArray(thread.turns)) throw new BridgeError('PROVENANCE', 'Codex thread readback differs');
  return thread;
}
async function waitTurn(server: AppServer, options: CodexOptions, threadId: string, turnId: string): Promise<CodexReply> {
  const deadline = Date.now() + options.timeoutMs;
  for (let storeErrors = 0; ;) {
    let thread: Row;
    // While the rollout is being written, thread/read can fail briefly: back off, at most 3 times in a row.
    try { thread = await readThread(server, threadId); storeErrors = 0; }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'EXECUTION' || ++storeErrors > 3) throw error;
      await delay(options.pollMs * storeErrors);
      continue;
    }
    const turn = thread.turns.find((item: Row) => item?.id === turnId);
    if (turn && turn.status !== 'inProgress') return replyOf(threadId, turn, false, server.declined);
    if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', `Codex thread ${threadId}: reply is pending; call again with the same prompt to read it (it is not resent)`);
    await delay(options.pollMs);
  }
}
async function startTurn(server: AppServer, threadId: string, prompt: string): Promise<string> {
  const turnId = (await server.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })).turn?.id;
  if (typeof turnId !== 'string') throw new BridgeError('PROVENANCE', 'turn/start returned no turn ID');
  return turnId;
}

/** Sends one prompt to an existing Codex thread and returns the final reply. A prompt
 * that is already the latest turn is not resent; its reply is returned (CONFLICT while
 * running). An archived thread is unarchived once when turn/start refuses it. */
export async function sendCodex(options: CodexOptions, threadId: string, text: string): Promise<CodexReply> {
  if (typeof threadId !== 'string' || !ID.test(threadId)) throw new BridgeError('INPUT', 'Invalid Codex thread ID');
  const prompt = checkPrompt(text);
  return session(options, async server => {
    const before = await readThread(server, threadId), latest = before.turns.at(-1);
    if (asks(latest, prompt)) {
      if (latest.status === 'inProgress') throw new BridgeError('CONFLICT', 'This prompt was already sent and is still running; call again later to read the reply');
      return replyOf(threadId, latest, true, 0);
    }
    if (before.status?.type === 'active') throw new BridgeError('CONFLICT', 'Codex thread is busy');
    await server.request('thread/resume', { threadId });
    let turnId: string;
    // A rejected turn/start created no turn, so one retry after unarchiving cannot duplicate it.
    try { turnId = await startTurn(server, threadId, prompt); }
    catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'EXECUTION') throw error;
      await server.request('thread/unarchive', { threadId });
      await server.request('thread/resume', { threadId });
      turnId = await startTurn(server, threadId, prompt);
    }
    return waitTurn(server, options, threadId, turnId);
  });
}

/** Creates a Codex conversation bound to a local workspace directory. A new thread is
 * only persisted by its first turn, so the first prompt is sent and answered here. */
export async function createCodex(options: CodexOptions, cwd: string, title: string, firstPrompt?: string): Promise<CodexReply & { cwd: string; title: string }> {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title)) throw new BridgeError('INPUT', 'Title must be one line of 1..200 characters');
  if (typeof cwd !== 'string' || !cwd.trim()) throw new BridgeError('INPUT', 'A workspace directory is required');
  const prompt = checkPrompt(firstPrompt ?? '这是 Agent Control Bridge 新建的 Codex 对话。请只回复：ACB_READY，不执行命令、不修改文件。');
  return session(options, async server => {
    const threadId = (await server.request('thread/start', { cwd })).thread?.id;
    if (typeof threadId !== 'string' || !ID.test(threadId)) throw new BridgeError('PROVENANCE', 'thread/start returned no thread ID');
    const reply = await waitTurn(server, options, threadId, await startTurn(server, threadId, prompt));
    await server.request('thread/name/set', { threadId, name: title });
    return { ...reply, cwd, title };
  });
}

/** Registers a Codex project for a directory. The idempotency key is derived from the
 * path, so repeating the call for the same directory is not a second project. */
export async function createProject(options: CodexOptions, name: string, path: string, idempotencyKey: string): Promise<{ projectId: string; name: string; roots: unknown }> {
  return session(options, async server => {
    const project = (await server.request('project/create', { name, roots: [{ path }], idempotencyKey })).project;
    if (typeof project?.id !== 'string') throw new BridgeError('PROVENANCE', 'project/create returned no project ID');
    const read = (await server.request('project/read', { projectId: project.id })).project ?? project;
    return { projectId: project.id, name: String(read.name ?? name), roots: read.roots ?? project.roots };
  });
}

/** Full-text search over Codex threads (thread/search). */
export async function searchCodex(options: CodexOptions, searchTerm: string): Promise<{ threadId: string; name: string | null; cwd: string | null }[]> {
  if (typeof searchTerm !== 'string' || !searchTerm.trim() || searchTerm.length > 200) throw new BridgeError('INPUT', 'Search term must be 1..200 characters');
  return session(options, async server => {
    const data = (await server.request('thread/search', { searchTerm })).data;
    return (Array.isArray(data) ? data : []).slice(0, 50).map((row: Row) => row?.thread ?? row).filter((thread: Row) => typeof thread?.id === 'string')
      .map((thread: Row) => ({ threadId: thread.id, name: typeof thread.name === 'string' ? thread.name : typeof thread.title === 'string' ? thread.title : null, cwd: typeof thread.cwd === 'string' ? thread.cwd : null }));
  });
}
