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

/** What the ChatGPT page shows of a conversation. */
export interface PageState {
  /** ChatGPT is writing a reply. */
  busy: boolean;
  /** The user messages, oldest first. */
  prompts: string[];
  /** The reply to the last user message, as far as it is shown. */
  reply: string;
  /** The reply's action buttons are shown, so it is finished. */
  complete: boolean;
}

/** Page labels of the Simplified Chinese app. */
const LABELS = { you: ['你说：', '您说：'], assistant: ['ChatGPT 说：'], finished: '更多操作' };
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a reply may take to show on the page. */
export const READ_TIMEOUT_MS = 20_000;

/** The user messages on the page and the ChatGPT reply after the last one. */
export function readPage(nodes: PageNode[], busy: boolean): PageState {
  const heading = (node: PageNode, names: string[]) =>
    node.type === 'Text' && node.label === true && names.includes(node.name);
  const starts = nodes.flatMap((node, index) => (heading(node, LABELS.you) ? [index] : []));
  /** The message text after the heading at `start`, up to the next heading. */
  const message = (start: number) => {
    const end = nodes.findIndex((node, index) => index > start && node.label === true);
    return textOf(nodes.slice(start + 1, end < 0 ? nodes.length : end).filter((node) => node.type === 'Text'));
  };
  const prompts = starts.map(message);
  const you = starts.at(-1);
  const assistant = nodes.findIndex(
    (node, index) => you !== undefined && index > you && heading(node, LABELS.assistant),
  );
  if (assistant < 0) return { busy, prompts, reply: '', complete: false };
  const rest = nodes.slice(assistant + 1);
  const finished = rest.findIndex((node) => node.type === 'Button' && node.name === LABELS.finished);
  const reply = (finished < 0 ? rest : rest.slice(0, finished)).filter((node) => node.type === 'Text' && !node.label);
  return { busy, prompts, reply: textOf(reply), complete: finished >= 0 };
}

function textOf(nodes: PageNode[]): string {
  return nodes
    .map((node) => node.name)
    .join('\n')
    .trim();
}

/**
 * Whether a message reads the same as one shown on the page. The page shows the `inline code`
 * of a user message without its backticks and may lay out whitespace differently.
 */
export function samePrompt(shown: string, message: string): boolean {
  const plain = (text: string) =>
    normalize(text)
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\s+/g, ' ');
  return plain(shown) === plain(message);
}

/** Whether the page's user messages end with `prompts` (are exactly `prompts` with `whole`). */
export function showsPrompts(state: PageState, prompts: string[], whole = false): boolean {
  const offset = state.prompts.length - prompts.length;
  if (offset < 0 || (whole && offset > 0)) return false;
  return prompts.every((prompt, index) => samePrompt(state.prompts[offset + index], prompt));
}

/** The finished reply on a page whose user messages end with `prompts` (see showsPrompts); null otherwise. */
export function replyTo(state: PageState | null, prompts: string[], whole = false): string | null {
  if (!state || state.busy || !state.complete || !state.reply) return null;
  return showsPrompts(state, prompts, whole) ? state.reply : null;
}

/** Why the page does not show the reply after `prompts`. */
function missing(state: PageState | null, prompts: string[]): string {
  if (!state) {
    return 'The ChatGPT window does not show the conversation; the app does not update a window that is fully covered, so keep part of it visible';
  }
  if (showsPrompts({ ...state, prompts: state.prompts.slice(0, -1) }, prompts)) {
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
   * What the page showing `title` shows, or null when no window shows it within `waitMs` (the
   * page needs a moment after it has been asked to show a conversation).
   */
  async pageState(title: string, waitMs = 0): Promise<PageState | null> {
    const until = Date.now() + waitMs;
    for (;;) {
      const page = await this.#request({ op: 'transcript', title });
      if (page.found) return readPage(page.nodes as PageNode[], page.busy === true);
      if (Date.now() >= until) return null;
      await delay(300);
    }
  }

  /**
   * The reply after `prompts` from the page showing `title`, once ChatGPT has finished it. The
   * page's user messages must end with `prompts` (see replyTo).
   */
  async readReply(title: string, prompts: string[], timeoutMs = READ_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.pageState(title);
      const reply = replyTo(state, prompts);
      if (reply !== null) return reply;
      if (Date.now() >= deadline) throw new AcbError('WINDOW', missing(state, prompts));
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
