import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcbError } from './errors.ts';
import { type Json, pipeTransport, type Transport } from './pipe.ts';

/**
 * Client for the tools the ChatGPT desktop app serves to its own agents (namespace
 * `codex_app`). The app runs every message itself, so conversations update live in its
 * sidebar.
 */

export type { Json } from './pipe.ts';
export type Kind = 'codex' | 'chatgpt';

export interface ThreadSummary {
  id: string;
  kind: Kind;
  title: string;
  /** `idle`, `active` or `notLoaded`, as the app reports it. */
  status: string;
  projectId: string | null;
  cwd: string | null;
  updatedAt: string | null;
  pinned: boolean;
}

export interface Project {
  projectId: string;
  label: string;
  path: string;
  isGitRepository: boolean;
}

/** One raw turn of `read_thread`; items are interpreted in turns.ts. */
export interface AppTurn {
  id: string;
  status: string;
  error: unknown;
  items: Json[];
}

export interface ThreadPage {
  id: string;
  kind: Kind;
  title: string;
  status: string;
  /** Why an active thread waits, e.g. `waitingOnApproval`. */
  activeFlags: string[];
  cwd: string | null;
  /** Newest first. */
  turns: AppTurn[];
  nextCursor: string | null;
}

export type CreateTarget =
  | { type: 'project'; projectId: string; environment: { type: 'local' } }
  | { type: 'projectless'; directoryName?: string };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Codex conversations of `~/.codex/session_index.jsonl`, most recently updated first. */
export async function recentCodexThreads(codexHome: string): Promise<string[]> {
  let index: string;
  try {
    index = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const ids = index
    .trim()
    .split('\n')
    .slice(-50)
    .reverse()
    .map((line) => {
      try {
        return (JSON.parse(line) as Json).id;
      } catch {
        return undefined;
      }
    })
    .filter((id): id is string => typeof id === 'string' && UUID.test(id));
  return [...new Set(ids)];
}

export interface DesktopOptions {
  transport?: Transport;
  /** The Codex conversation named as caller; found automatically when omitted. */
  caller?: string;
  codexHome?: string;
}

/** The app tools ACB uses, with typed results. */
export class Desktop {
  readonly #send: Transport;
  readonly #codexHome: string;
  #caller: string | undefined;

  constructor(options: DesktopOptions = {}) {
    this.#send = options.transport ?? pipeTransport();
    this.#caller = options.caller;
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  }

  /**
   * Every call names a Codex conversation as its caller, as the app's own agents do. Unless
   * one is configured, ACB uses the most recent conversation the app accepts. A message sent
   * to a Codex conversation names that conversation itself instead.
   */
  async caller(): Promise<string> {
    if (this.#caller) return this.#caller;
    for (const id of await recentCodexThreads(this.#codexHome)) {
      try {
        await this.call('list_projects', {}, id);
        this.#caller = id;
        return id;
      } catch (error) {
        if (!(error instanceof AcbError) || error.code !== 'PROTOCOL') throw error;
      }
    }
    throw new AcbError(
      'UNAVAILABLE',
      'No Codex conversation can act as caller: start one Codex conversation in the desktop app, or pass --caller',
    );
  }

  async call(tool: string, args: Json, caller?: string): Promise<Json> {
    const response = await this.#send({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: {
        namespace: 'codex_app',
        tool,
        arguments: args,
        threadId: caller ?? (await this.caller()),
        callId: `acb-${randomUUID()}`,
        turnId: `acb-${randomUUID()}`,
        callerSource: 'codex',
      },
    });
    return toolResult(tool, response);
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const result = await this.call('list_threads', { limit: 50 });
    // Other kinds the app may list (e.g. cloud Work tasks) are not conversations ACB handles.
    return [
      ...rows(result.pinnedThreads).map((row) => summary(row, true)),
      ...rows(result.threads).map((row) => summary(row, false)),
    ].filter((row): row is ThreadSummary => row !== null);
  }

  async listProjects(): Promise<Project[]> {
    return rows((await this.call('list_projects', {})).projects).map((row) => ({
      projectId: String(row.projectId),
      label: String(row.label ?? ''),
      path: String(row.path ?? ''),
      isGitRepository: row.isGitRepository === true,
    }));
  }

  /**
   * The newest `turns` turns (1-10) from `cursor` on. Without `outputs` the app drops message
   * text and delegated prompts, which is enough to watch a turn's status cheaply.
   */
  async readThread(
    id: string,
    options: { turns?: number; cursor?: string; outputs?: boolean } = {},
  ): Promise<ThreadPage> {
    const outputs = options.outputs ?? true;
    const result = await this.call('read_thread', {
      threadId: id,
      turnLimit: options.turns ?? 1,
      includeOutputs: outputs,
      maxOutputCharsPerItem: outputs ? 20_000 : 0,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const thread = object(result.thread);
    if (thread.id !== id || !Array.isArray(result.turns)) {
      throw new AcbError('PROTOCOL', 'The desktop app returned a different conversation');
    }
    const status = object(thread.status ?? {});
    const page = object(result.page ?? {});
    const kind = kindOf(thread.kind);
    if (!kind) throw new AcbError('INPUT', 'This is neither a ChatGPT nor a Codex conversation');
    return {
      id,
      kind,
      title: String(thread.title ?? ''),
      status: String(status.type ?? ''),
      activeFlags: Array.isArray(status.activeFlags) ? status.activeFlags.map(String) : [],
      cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
      turns: rows(result.turns).map((turn) => ({
        id: String(turn.id),
        status: String(turn.status),
        error: turn.error ?? null,
        items: rows(turn.items),
      })),
      nextCursor: page.hasMore === true && typeof page.nextCursor === 'string' ? page.nextCursor : null,
    };
  }

  /** The app records the message as delegated by `caller`; ChatGPT shows it as a user message. */
  async sendMessage(id: string, prompt: string, caller?: string): Promise<void> {
    await this.call('send_message_to_thread', { threadId: id, prompt }, caller);
  }

  async createThread(args: { prompt: string; title?: string; target: CreateTarget }): Promise<string> {
    const result = await this.call('create_thread', args);
    if (typeof result.threadId !== 'string')
      throw new AcbError('PROTOCOL', 'The desktop app did not return the new thread');
    return result.threadId;
  }

  async setTitle(id: string, kind: Kind, title: string): Promise<void> {
    await this.call('set_thread_title', { threadId: id, source: kind, title });
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    await this.call('set_thread_archived', { threadId: id, archived });
  }

  /** Shows the conversation in the app's most recently focused window, without activating it. */
  async show(id: string): Promise<void> {
    await this.call('navigate_to_codex_page', { threadId: id });
  }
}

/** The subset of Desktop the conversation tools use; tests substitute it. */
export type App = Pick<
  Desktop,
  | 'caller'
  | 'listThreads'
  | 'listProjects'
  | 'readThread'
  | 'sendMessage'
  | 'createThread'
  | 'setTitle'
  | 'setArchived'
  | 'show'
>;

/** Unwraps a `tools/call` response: one text item holding JSON, or a failure message. */
export function toolResult(tool: string, response: Json): Json {
  if (response.error !== undefined) {
    const error = object(response.error);
    throw new AcbError('PROTOCOL', `The desktop app refused ${tool}: ${String(error.message ?? 'no reason given')}`, {
      appError: { code: error.code ?? null, message: error.message ?? null },
    });
  }
  const result = object(response.result);
  const item = rows(result.contentItems).find((entry) => entry.type === 'inputText');
  const text = typeof item?.text === 'string' ? item.text : '';
  if (result.success !== true) throw failure(tool, text);
  try {
    return object(JSON.parse(text));
  } catch {
    return { text };
  }
}

function failure(tool: string, text: string): AcbError {
  const message = text.replace(/\s+/g, ' ').trim().slice(0, 500) || `${tool} failed`;
  if (/not found|\bno\b[\w ]* found/i.test(message)) return new AcbError('NOT_FOUND', message);
  if (/is archived/i.test(message)) return new AcbError('FAILED', message, { archived: true });
  if (/invalid arguments/i.test(message)) return new AcbError('INPUT', message);
  return new AcbError('FAILED', message);
}

function summary(row: Json, pinned: boolean): ThreadSummary | null {
  const kind = kindOf(row.kind);
  if (!kind) return null;
  return {
    id: String(row.id),
    kind,
    title: String(row.title ?? ''),
    status: String(row.status ?? ''),
    projectId: typeof row.projectId === 'string' ? row.projectId : null,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    updatedAt: typeof row.updatedAt === 'number' ? new Date(row.updatedAt * 1000).toISOString() : null,
    pinned,
  };
}

function kindOf(value: unknown): Kind | null {
  return value === 'codex' || value === 'chatgpt' ? value : null;
}

function object(value: unknown): Json {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json;
  throw new AcbError('PROTOCOL', 'The desktop app sent an unexpected response');
}

function rows(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((row): row is Json => !!row && typeof row === 'object') : [];
}
