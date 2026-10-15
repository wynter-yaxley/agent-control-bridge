import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, controlledProcessEnv } from './errors.ts';

type Row = Record<string, any>;
const ID = /^[a-zA-Z0-9_-]{1,200}$/;

/** One owned `codex app-server` stdio process. Server requests (command/file
 * approvals and anything else) are declined: a forwarded prompt never grants them. */
class AppServer {
  private readonly child: ChildProcess;
  private sequence = 0;
  private buffer = '';
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
      if (message.id !== undefined) this.write(message.method.endsWith('/requestApproval') ? { id: message.id, result: { decision: 'decline' } } : { id: message.id, error: { code: -32601, message: 'Not supported by Agent Control Bridge' } });
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

export interface CodexReply { threadId: string; turnId: string; reply: string; messageIds: string[]; alreadySent: boolean }
const asks = (turn: Row | undefined, prompt: string) => Array.isArray(turn?.items) && turn.items.some((item: Row) => item?.type === 'userMessage' && Array.isArray(item.content) && item.content.some((part: Row) => part?.text === prompt));
function replyOf(threadId: string, turn: Row, alreadySent: boolean): CodexReply {
  if (turn.status !== 'completed' || turn.error != null) throw new BridgeError('EXECUTION', `Codex turn ended as ${String(turn.status)}`);
  const replies = (turn.items as Row[]).filter(item => item?.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string' && item.text.trim());
  if (!replies.length) throw new BridgeError('PROVENANCE', 'Completed Codex turn has no reply text');
  return { threadId, turnId: String(turn.id), reply: replies.map(item => item.text).join('\n\n'), messageIds: replies.map(item => String(item.id)), alreadySent };
}

/** Sends one prompt to an existing Codex thread through its App Server and returns
 * the final reply. If the latest turn already carries this exact prompt it is not
 * sent again; its reply is returned (or CONFLICT while it is still running). */
export async function sendCodex(options: { executable: string; timeoutMs: number; pollMs: number; spawnFn?: typeof nodeSpawn }, threadId: string, prompt: string): Promise<CodexReply> {
  if (typeof threadId !== 'string' || !ID.test(threadId)) throw new BridgeError('INPUT', 'Invalid Codex thread ID');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 65536) throw new BridgeError('INPUT', 'Prompt must be 1..65536 characters');
  const server = new AppServer(options.executable, options.spawnFn ?? nodeSpawn);
  const read = async () => {
    const thread = (await server.request('thread/read', { threadId, includeTurns: true })).thread;
    if (thread?.id !== threadId || !Array.isArray(thread.turns)) throw new BridgeError('PROVENANCE', 'Codex thread readback differs');
    return thread as Row;
  };
  try {
    await server.initialize();
    const before = await read(), latest = before.turns.at(-1);
    if (asks(latest, prompt)) {
      if (latest.status === 'inProgress') throw new BridgeError('CONFLICT', 'This prompt was already sent and is still running; call again later to read the reply');
      return replyOf(threadId, latest, true);
    }
    if (before.status?.type === 'active') throw new BridgeError('CONFLICT', 'Codex thread is busy');
    await server.request('thread/resume', { threadId });
    const turnId = (await server.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })).turn?.id;
    if (typeof turnId !== 'string') throw new BridgeError('PROVENANCE', 'turn/start returned no turn ID');
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const turn = (await read()).turns.find((item: Row) => item?.id === turnId);
      if (turn && turn.status !== 'inProgress') return replyOf(threadId, turn, false);
      if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'Reply is pending; call again with the same prompt to read it (it is not resent)');
      await delay(options.pollMs);
    }
  } finally { server.close(); }
}
