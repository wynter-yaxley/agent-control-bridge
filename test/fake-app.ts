import { setTimeout as delay } from 'node:timers/promises';
import type { App, AppTurn, CreateTarget, Inventory, Kind, Project, ThreadPage } from '../src/desktop.ts';
import { AcbError } from '../src/errors.ts';

export interface FakeThread {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  activeFlags: string[];
  cwd: string | null;
  /** Newest first, as the app returns them. */
  turns: AppTurn[];
  archived?: boolean;
}

export const CODEX = '01a16d92-2759-7d31-a091-a9668dc3123f';
export const GPT = '6adc8297-28a8-83ee-9b00-e17ad8ee2f68';
export const CALLER = '01a16d11-e3d8-7e22-96b7-5061f6b62df2';

export function userTurn(id: string, prompt: string, reply: string | null = 'ok', status = 'completed'): AppTurn {
  const items: AppTurn['items'] = [{ type: 'userMessage', content: [{ type: 'text', text: prompt }] }];
  if (reply !== null) items.push({ type: 'agentMessage', phase: 'final_answer', text: reply });
  return { id, status, error: null, items };
}

export function delegatedTurn(id: string, prompt: string, reply: string | null = 'ok', status = 'completed'): AppTurn {
  const escaped = prompt.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const text = `<codex_delegation>\n  <source_thread_id>${CALLER}</source_thread_id>\n  <input>${escaped}</input>\n</codex_delegation>`;
  const items: AppTurn['items'] = [{ type: 'functionCallOutput', name: 'send_message_to_thread', output: { text } }];
  if (reply !== null) items.push({ type: 'agentMessage', phase: 'final_answer', text: reply });
  return { id, status, error: null, items };
}

/**
 * An in-memory desktop app. A delivered message starts a running turn that the app answers
 * after `answerAfterReads` status reads, using `answer` (a reply string, or a function that
 * finishes the turn itself, e.g. to fail it).
 */
export class FakeApp implements App {
  threads = new Map<string, FakeThread>();
  sent: { id: string; prompt: string; caller?: string }[] = [];
  created: { prompt: string; title?: string; target: CreateTarget }[] = [];
  shown: string[] = [];
  titles: { id: string; title: string }[] = [];
  archiving: { id: string; kind: Kind; archived: boolean }[] = [];
  /** Kinds the app cannot list, as with ChatGPT signed out. */
  unavailable: string[] = [];
  /** How long an accepted message takes to appear as a turn. */
  listAfterMs = 0;
  /** The app refuses the next messages with this error (nothing is sent). */
  refuse: AcbError | null = null;
  /** The app takes the next messages but its answer is lost with this error. */
  lostAnswer: AcbError | null = null;
  /** Called after every read, with the number of reads so far. */
  afterRead: ((reads: number) => void) | null = null;
  #reads = 0;
  answerAfterReads = 1;
  answer: string | ((thread: FakeThread) => void) = 'ok';
  #pending: { thread: FakeThread; reads: number }[] = [];
  #turns = 0;

  add(thread: Partial<FakeThread> & Pick<FakeThread, 'id' | 'kind'>): FakeThread {
    const full: FakeThread = { title: 'title', status: 'idle', activeFlags: [], cwd: null, turns: [], ...thread };
    this.threads.set(full.id, full);
    return full;
  }

  async caller(): Promise<string> {
    return CALLER;
  }

  async listThreads(): Promise<Inventory> {
    const threads = [...this.threads.values()].map((thread) => ({
      id: thread.id,
      kind: thread.kind,
      title: thread.title,
      status: thread.status,
      projectId: null,
      cwd: thread.cwd,
      updatedAt: null,
      pinned: false,
    }));
    return { threads, unavailable: this.unavailable };
  }

  async listProjects(): Promise<Project[]> {
    return [
      { projectId: 'bee59c1b-2a5e-4e67-9bbe-12f8152b606d', label: 'Project', path: 'D:\\Work', isGitRepository: true },
    ];
  }

  async readThread(
    id: string,
    options: { turns?: number; cursor?: string; outputs?: boolean } = {},
  ): Promise<ThreadPage> {
    const thread = this.#get(id);
    if (options.outputs === false) this.#progress(thread);
    const start = Number(options.cursor ?? 0);
    const end = start + (options.turns ?? 1);
    const turns = thread.turns
      .slice(start, end)
      .map((turn) => (options.outputs === false ? withoutText(turn) : structuredClone(turn)));
    const page = {
      id,
      kind: thread.kind,
      title: thread.title,
      status: thread.status,
      activeFlags: [...thread.activeFlags],
      cwd: thread.cwd,
      turns,
      nextCursor: end < thread.turns.length ? String(end) : null,
    };
    this.afterRead?.(++this.#reads);
    return page;
  }

  async sendMessage(id: string, prompt: string, caller?: string): Promise<void> {
    const thread = this.#get(id);
    if (thread.archived) throw new AcbError('FAILED', `session ${id} is archived`, { refused: true, archived: true });
    if (this.refuse) throw this.refuse;
    this.sent.push({ id, prompt, ...(caller ? { caller } : {}) });
    if (!this.listAfterMs) this.#start(thread, prompt);
    else void delay(this.listAfterMs, undefined, { ref: false }).then(() => this.#start(thread, prompt));
    if (this.lostAnswer) throw this.lostAnswer;
  }

  async createThread(args: { prompt: string; title?: string; target: CreateTarget }): Promise<string> {
    this.created.push(args);
    const thread = this.add({
      id: `01a16d92-0000-7000-8000-${String(this.created.length).padStart(12, '0')}`,
      kind: 'codex',
      title: args.title ?? args.prompt,
      cwd: 'C:\\new',
    });
    this.#start(thread, args.prompt);
    return thread.id;
  }

  async setTitle(id: string, _kind: Kind, title: string): Promise<void> {
    this.titles.push({ id, title });
    this.#get(id).title = title;
  }

  async setArchived(id: string, kind: Kind, archived: boolean): Promise<void> {
    this.archiving.push({ id, kind, archived });
    this.#get(id).archived = archived;
  }

  async show(id: string): Promise<void> {
    this.shown.push(id);
  }

  /** Starts the turn a message opens, as the app does for user messages and delegations. */
  start(thread: FakeThread, prompt: string): void {
    this.#start(thread, prompt);
  }

  #start(thread: FakeThread, prompt: string): void {
    const id = `turn-${++this.#turns}`;
    const opened =
      thread.kind === 'codex'
        ? delegatedTurn(id, prompt, null, 'inProgress')
        : userTurn(id, prompt, null, 'inProgress');
    thread.turns.unshift(opened);
    thread.status = 'active';
    this.#pending.push({ thread, reads: this.answerAfterReads });
  }

  #progress(thread: FakeThread): void {
    const pending = this.#pending.find((entry) => entry.thread === thread);
    if (!pending || pending.reads-- > 0) return;
    this.#pending.splice(this.#pending.indexOf(pending), 1);
    if (typeof this.answer === 'function') {
      this.answer(thread);
      return;
    }
    thread.turns[0].status = 'completed';
    thread.turns[0].items.push({ type: 'agentMessage', phase: 'final_answer', text: this.answer });
    thread.status = 'idle';
  }

  #get(id: string): FakeThread {
    const thread = this.threads.get(id);
    if (!thread) throw new AcbError('NOT_FOUND', `No thread found for ${id}`);
    return thread;
  }
}

/** The app drops message text and delegated prompts when outputs are excluded. */
function withoutText(turn: AppTurn): AppTurn {
  return {
    ...turn,
    items: turn.items.map((item) => {
      if (item.type === 'functionCallOutput') return { type: item.type, name: item.name };
      if (item.type === 'userMessage') return { type: item.type, content: [] };
      return { ...item, text: '' };
    }),
  };
}
