import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AcbError, type ErrorCode } from './errors.ts';
import { normalize } from './turns.ts';

/** A Text or Button of the ChatGPT page, in page order; one Text holds a run of page text. */
export interface PageNode {
  type: string;
  name: string;
  /** A screen-reader-only role heading such as "你说：", not message text. */
  label?: boolean;
}

export interface Exchange {
  /** The user message before the last one, or null when the page shows only one. */
  previous: string | null;
  prompt: string;
  reply: string;
  /** The reply's action buttons are shown, so it is finished. */
  complete: boolean;
}

/** Page labels of the Simplified Chinese app. */
const LABELS = { you: ['你说：', '您说：'], assistant: ['ChatGPT 说：'], finished: '更多操作' };
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a reply may take to show on the page. */
export const READ_TIMEOUT_MS = 20_000;

/** The last user message on the page, the one before it and the ChatGPT reply after it. */
export function lastExchange(nodes: PageNode[]): Exchange | null {
  const heading = (node: PageNode, names: string[]) =>
    node.type === 'Text' && node.label === true && names.includes(node.name);
  const messages = nodes.flatMap((node, index) => (heading(node, LABELS.you) ? [index] : []));
  const you = messages.at(-1);
  if (you === undefined) return null;
  /** The message text after the heading at `start`, up to the next heading. */
  const message = (start: number) => {
    const end = nodes.findIndex((node, index) => index > start && node.label === true);
    return textOf(nodes.slice(start + 1, end < 0 ? nodes.length : end).filter((node) => node.type === 'Text'));
  };
  const previous = messages.length > 1 ? message(messages[messages.length - 2]) : null;
  const assistant = nodes.findIndex((node, index) => index > you && heading(node, LABELS.assistant));
  if (assistant < 0) return { previous, prompt: message(you), reply: '', complete: false };
  const rest = nodes.slice(assistant + 1);
  const finished = rest.findIndex((node) => node.type === 'Button' && node.name === LABELS.finished);
  const reply = (finished < 0 ? rest : rest.slice(0, finished)).filter((node) => node.type === 'Text' && !node.label);
  return { previous, prompt: message(you), reply: textOf(reply), complete: finished >= 0 };
}

function textOf(nodes: PageNode[]): string {
  return nodes
    .map((node) => node.name)
    .join('\n')
    .trim();
}

/**
 * A message as compared with the page: the page lays out whitespace its own way and shows
 * `inline code` of a user message without the backticks.
 */
const squash = (text: string) => normalize(text).replace(/[\s`]/g, '');

export interface PageState {
  /** ChatGPT is still writing. */
  busy: boolean;
  exchange: Exchange | null;
}

/**
 * The finished reply on a page whose last two user messages are `previous` (null: there is no
 * earlier one) and `prompt`, as far as the page shows them (see squash); null otherwise. Two
 * messages, not one, tell the current page from an older state of it that ended with the same
 * prompt.
 */
export function readyReply(state: PageState | null, prompt: string, previous: string | null): string | null {
  const exchange = state && !state.busy ? state.exchange : null;
  const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : squash(a) === squash(b));
  const current = exchange?.complete && same(exchange.prompt, prompt) && same(exchange.previous, previous);
  return current && exchange.reply ? exchange.reply : null;
}

/** Why the page does not show the reply to `prompt`. */
function missing(state: PageState | null, prompt: string): string {
  if (!state) {
    return 'The ChatGPT window does not show the conversation; the app does not update a window that is fully covered, so keep part of it visible';
  }
  const previous = state.exchange?.previous;
  if (previous && squash(previous) === squash(prompt)) {
    return 'The page shows a newer message than the app lists; the app lists a ChatGPT turn up to a minute after it ends, so read again shortly';
  }
  return 'The reply was not found on the ChatGPT page';
}

/**
 * A long-lived Windows PowerShell helper (helper.ps1) for what the app's tools do not offer:
 * checking who serves the tool pipe, reading the ChatGPT page and starting a ChatGPT chat
 * (UI Automation). Reading a page never activates the window; starting a chat does, because
 * the app focuses the window when its new-chat button or composer is used.
 */
export class WindowsHelper {
  #child: ChildProcess | undefined;
  #answer: ((line: string) => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #requests: Promise<unknown> = Promise.resolve();

  /**
   * Runs `task` after the page operations already queued. Every operation that depends on,
   * or changes, the conversation the window shows runs through here.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** Starts the helper ahead of the first request. */
  warm(): void {
    if (process.platform === 'win32' && !this.#child) this.#start();
  }

  close(): void {
    this.#child?.kill();
    this.#child = undefined;
  }

  /**
   * Notes which window has the foreground and returns a function that gives it back if the
   * app has taken it since; switching pages or opening a new chat can make the app take it.
   */
  async holdForeground(): Promise<() => Promise<void>> {
    const { window } = await this.#request({ op: 'foreground' });
    return async () => {
      const { taken, restored } = await this.#request({ op: 'give-back', window });
      if (taken && !restored) process.stderr.write('agent-control-bridge: could not give the foreground back\n');
    };
  }

  /** Whether the server of the tool pipe at `path` is the signed app of this user session. */
  async isAppPipe(path: string): Promise<boolean> {
    return (await this.#request({ op: 'pipe-owner', path })).isApp === true;
  }

  /**
   * The newest exchange on the page showing `title`, or null when no window shows it within
   * `waitMs` (the page needs a moment after it has been asked to show a conversation).
   */
  async pageState(title: string, waitMs = 0): Promise<PageState | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const page = await this.#request({ op: 'transcript', title });
      if (page.found) return { busy: page.busy === true, exchange: lastExchange(page.nodes as PageNode[]) };
      if (Date.now() >= until) return null;
      await delay(300);
    }
  }

  /**
   * The reply to `prompt` from the page showing `title`, once ChatGPT has finished it. The
   * page's last two user messages must be `previous` and `prompt` (see readyReply).
   */
  async readReply(
    title: string,
    prompt: string,
    previous: string | null,
    timeoutMs = READ_TIMEOUT_MS,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.pageState(title);
      const reply = readyReply(state, prompt, previous);
      if (reply !== null) return reply;
      if (Date.now() >= deadline) throw new AcbError('WINDOW', missing(state, prompt));
      await delay(500);
    }
  }

  /** Opens a new chat in the ChatGPT-mode window and sends `prompt`. */
  async startChat(prompt: string): Promise<void> {
    await this.#request({ op: 'compose', prompt });
  }

  /** One request at a time: the helper answers the lines it reads in order. */
  #request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = this.#requests.then(() => this.#exchange(message));
    this.#requests = result.catch(() => undefined);
    return result;
  }

  async #exchange(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32')
      throw new AcbError('UNAVAILABLE', 'The ChatGPT window can only be used on Windows');
    if (!this.#child) this.#start();
    const child = this.#child as ChildProcess;
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => fail('The Windows helper did not answer in time'), REQUEST_TIMEOUT_MS);
      const stopped = () => fail('The Windows helper stopped');
      const fail = (reason: string) => {
        done();
        this.close();
        reject(new AcbError('WINDOW', reason));
      };
      const done = () => {
        clearTimeout(timer);
        child.off('exit', stopped).off('error', stopped);
        this.#answer = undefined;
      };
      this.#answer = (text) => {
        done();
        resolve(text);
      };
      child.once('exit', stopped).once('error', stopped);
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    });
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(line);
    } catch {
      throw new AcbError('PROTOCOL', 'The Windows helper sent an unreadable answer');
    }
    if (response.ok !== true) throw new AcbError(response.code as ErrorCode, String(response.message));
    return response;
  }

  #start(): void {
    const script = fileURLToPath(new URL('./helper.ps1', import.meta.url));
    // A script block bypasses the execution policy, which -File would be subject to.
    const command = `& ([scriptblock]::Create([IO.File]::ReadAllText('${script.replaceAll("'", "''")}')))`;
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    const child = spawn(
      join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        // The helper needs no user environment, and gets none.
        env: {
          SystemRoot: system,
          TEMP: process.env.TEMP ?? '',
          PSModulePath: join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        },
      },
    );
    const forget = () => {
      if (this.#child === child) this.#child = undefined;
    };
    child.on('error', forget).on('exit', forget);
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => this.#answer?.(line));
    this.#child = child;
  }
}
