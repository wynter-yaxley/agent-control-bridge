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
  /** A heading's UI Automation runtime ID: the same while its message stays on the page. */
  id?: string;
}

/** What the ChatGPT page shows of a conversation. */
export interface PageState extends PageMessages {
  /** ChatGPT is writing a reply. */
  busy: boolean;
  /** The page is scrolled to the end, so its last messages are the conversation's newest. */
  atEnd: boolean;
  /** Where the conversation is scrolled to; null when it fits, so it does not scroll. */
  scroll: Scroll | null;
  /** The page has older messages to load: it loads them once scrolled to its top. */
  older: boolean;
  /** The messages the page holds, oldest first. */
  messages: PageMessage[];
}

/** A message the page holds. */
export interface PageMessage {
  /** The runtime ID of its heading, which tells it apart from an equal message. */
  id: string | null;
  role: 'you' | 'assistant';
  text: string;
  /** For a reply, its action buttons are shown, so it is finished. */
  complete: boolean;
}

export interface PageMessages {
  /** The user messages the page holds, oldest first: the newest few, near what it shows. */
  prompts: string[];
  /** The reply to the last user message, as far as it is shown. */
  reply: string;
  /** The reply's action buttons are shown, so it is finished. */
  complete: boolean;
}

/** The approval card Codex shows while it waits for the user, as the Windows helper reads it. */
export interface ApprovalCard {
  /** Its title, then its question, one line break between blocks. */
  text: string;
  buttons: { name: string; className: string; usable: boolean }[];
}

export interface Approval {
  /** The card's title, e.g. 请求权限. */
  title: string;
  question: string;
  buttons: { name: string; kind: 'deny' | 'allow' | 'other'; className: string }[];
  /**
   * The button that allows the least, for the user's default of allowing: 允许一次 when the
   * card has it, else its primary allow button; never a broader one such as 始终允许.
   */
  defaultButton: string | null;
}

/**
 * The approval of a card. A deny button shares its class with the other secondary buttons
 * (始终允许), so it is told by its name; the primary button, by its class, allows.
 */
export function approvalOf(card: ApprovalCard): Approval {
  const [title, ...question] = card.text.split('\n');
  const buttons = card.buttons
    .filter((button) => button.usable)
    .map(({ name, className }): Approval['buttons'][number] => ({
      name,
      kind: name === LABELS.deny ? 'deny' : /(^| )bg-primary-solid( |$)/.test(className) ? 'allow' : 'other',
      className,
    }));
  const allow =
    buttons.find((button) => button.name === LABELS.allowOnce) ?? buttons.find((button) => button.kind === 'allow');
  return { title, question: question.join('\n'), buttons, defaultButton: allow?.name ?? null };
}

/** A vertical scroll position: how far down, and how much of the height shows (percent). */
export interface Scroll {
  percent: number;
  view: number;
}

/** How far from its end, in screens, a page still counts as at its end: scrolling is fractional. */
const END_SCREENS = 0.05;

/**
 * Whether a conversation scrolled to `scroll` (null: it fits, so it does not scroll) shows its
 * end. The page holds only the messages near what it shows, so its last one is the newest only
 * at the end.
 */
export function atEnd(scroll: Scroll | null): boolean {
  if (!scroll) return true;
  if (!(scroll.view > 0)) return false;
  return (100 / scroll.view - 1) * (1 - scroll.percent / 100) <= END_SCREENS;
}

/** Page labels of the Simplified Chinese app. */
const LABELS = {
  you: ['你说：', '您说：'],
  assistant: ['ChatGPT 说：'],
  finished: '更多操作',
  deny: '拒绝',
  allowOnce: '允许一次',
};
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a reply may take to show on the page. */
export const READ_TIMEOUT_MS = 20_000;

/** A page can be between UI updates; repeat a failed read once without changing its checks. */
export async function retryPageRead<T>(read: () => Promise<T>, deadline: number): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof AcbError && error.code === 'WINDOW') || Date.now() + 500 >= deadline) throw error;
    await delay(500);
    return read();
  }
}

/**
 * The messages on the page, oldest first. A user message runs to the next heading; a reply
 * runs to its action buttons, which show once it is finished, or to the next role heading.
 */
export function readMessages(nodes: PageNode[]): PageMessage[] {
  const role = (node: PageNode | undefined) => {
    if (node?.type !== 'Text' || node.label !== true) return null;
    if (LABELS.you.includes(node.name)) return 'you';
    return LABELS.assistant.includes(node.name) ? 'assistant' : null;
  };
  const finished = (node: PageNode | undefined) => node?.type === 'Button' && node.name === LABELS.finished;
  return nodes.flatMap((node, start): PageMessage[] => {
    const kind = role(node);
    if (!kind) return [];
    let end = start + 1;
    const last = (next: PageNode) => (kind === 'you' ? next.label === true : role(next) !== null || finished(next));
    while (end < nodes.length && !last(nodes[end])) end++;
    const text = textOf(nodes.slice(start + 1, end).filter((next) => next.type === 'Text' && !next.label));
    return [{ id: node.id ?? null, role: kind, text, complete: kind === 'you' || finished(nodes[end]) }];
  });
}

/** The user messages of `messages` and the ChatGPT reply after the last one. */
export function readPage(messages: PageMessage[]): PageMessages {
  const last = messages.findLastIndex((message) => message.role === 'you');
  const reply = last < 0 ? undefined : messages.slice(last + 1).find((message) => message.role === 'assistant');
  return {
    prompts: messages.flatMap((message) => (message.role === 'you' ? [message.text] : [])),
    reply: reply?.text ?? '',
    complete: reply?.complete ?? false,
  };
}

function textOf(nodes: PageNode[]): string {
  return nodes
    .map((node) => node.name)
    .join('\n')
    .trim();
}

/**
 * Whether a message reads the same as one shown on the page, which keeps a user message as
 * written except for the backticks around its `inline code`.
 */
export function samePrompt(shown: string, message: string): boolean {
  const plain = (text: string) => normalize(text).replace(/`([^`\n]+)`/g, '$1');
  return plain(shown) === plain(message);
}

/** Whether `shown` ends with `prompts`. */
function endsWith(shown: string[], prompts: string[]): boolean {
  const offset = shown.length - prompts.length;
  return offset >= 0 && prompts.every((prompt, index) => samePrompt(shown[offset + index], prompt));
}

/**
 * Whether the page's user messages end with `prompts`. The page holds only the newest messages
 * (five or more, fewer when they are long), so only as many as it holds are compared, but at
 * least two.
 */
export function showsPrompts(state: PageMessages, prompts: string[]): boolean {
  const count = Math.max(Math.min(prompts.length, state.prompts.length), Math.min(2, prompts.length));
  return endsWith(state.prompts, prompts.slice(prompts.length - count));
}

/**
 * The finished reply on a page scrolled to the end whose user messages end with `prompts` (see
 * showsPrompts); null otherwise.
 */
export function replyTo(state: PageState | null, prompts: string[]): string | null {
  if (!state?.atEnd || state.busy || !state.complete || !state.reply) return null;
  return showsPrompts(state, prompts) ? state.reply : null;
}

/**
 * The messages the page shows after `known`, the newest messages known to be in the
 * conversation; undefined when the page does not show `known` exactly once.
 */
export function shownAfter(state: PageMessages, known: string[]): string[] | undefined {
  if (!known.length) return undefined;
  const ends: number[] = [];
  for (let end = known.length; end <= state.prompts.length; end++) {
    if (endsWith(state.prompts.slice(0, end), known)) ends.push(end);
  }
  return ends.length === 1 ? state.prompts.slice(ends[0]) : undefined;
}

/** Why the page does not show the reply after `prompts`. */
function missing(state: PageState | null, prompts: string[]): string {
  if (!state) {
    return 'The ChatGPT window does not show the conversation; the app does not update a window that is fully covered, so keep part of it visible';
  }
  if (!state.atEnd) return 'The ChatGPT page is scrolled up from the newest messages';
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
      if (page.found) {
        const scroll = (page.scroll as Scroll | null) ?? null;
        const messages = readMessages(page.nodes as PageNode[]);
        return {
          busy: page.busy === true,
          // Without the conversation's frame, where it is scrolled to is unknown.
          atEnd: page.framed === true && atEnd(scroll),
          scroll,
          older: page.older === true,
          messages,
          ...readPage(messages),
        };
      }
      if (Date.now() >= until) return null;
      await delay(150);
    }
  }

  /**
   * The reply after `prompts` from the page showing `title`, once ChatGPT has finished it. The
   * page's user messages must end with `prompts` (see replyTo) on two reads in a row: a page
   * just asked to show a conversation can show what it kept of it for a moment.
   */
  async readReply(title: string, prompts: string[], timeoutMs = READ_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let previous: string | null = null;
    for (;;) {
      const state = await this.pageState(title);
      const reply = replyTo(state, prompts);
      if (reply !== null && reply === previous) return reply;
      previous = reply;
      if (Date.now() >= deadline) throw new AcbError('WINDOW', missing(state, prompts));
      await delay(500);
    }
  }

  /** Opens the desktop window if absent, including the tray state; whether it was opened. */
  async launch(): Promise<boolean> {
    return (await this.#request({ op: 'launch' })).started === true;
  }

  /**
   * Brings the app's windows that do not show on screen above the others without activating
   * them, so their pages update, and returns a function that puts them back.
   */
  async raise(): Promise<() => Promise<void>> {
    const { raised } = await this.#request({ op: 'raise' });
    return async () => {
      if (Array.isArray(raised) && raised.length) await this.#request({ op: 'lower', raised });
    };
  }

  /**
   * Scrolls the conversation shown under `title` to the first of the messages with heading
   * runtime IDs `ids` that is still on the page, then `pages` screens further up; false when
   * none is, or no window shows it.
   */
  async reveal(title: string, ids: string[], pages = 0): Promise<boolean> {
    return (await this.#request({ op: 'reveal', title, ids, pages })).found === true;
  }

  /** Scrolls the conversation shown under `title` to `percent` of its height; false when no window shows it. */
  async scroll(title: string, percent: number): Promise<boolean> {
    return (await this.#request({ op: 'scroll', title, percent })).found === true;
  }

  /**
   * The approval card of the conversation shown under `title`, once the page shows one within
   * `waitMs`: null when it shows none by then, undefined when no window shows the page.
   */
  async approval(title: string, waitMs = 0): Promise<ApprovalCard | null | undefined> {
    const until = Date.now() + waitMs;
    for (;;) {
      const { found, card } = await this.#request({ op: 'approval', title });
      if (found && card) return card as ApprovalCard;
      if (Date.now() >= until) return found ? null : undefined;
      await delay(150);
    }
  }

  /** Presses button `name` on the approval card under `title`, if the card still reads `text`. */
  async press(title: string, text: string, name: string): Promise<void> {
    await this.#request({ op: 'press', title, text, name });
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
