import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AcbError, type ErrorCode } from './errors.ts';
import { normalize } from './turns.ts';

/** A Text or Button of the ChatGPT page, in page order. */
export interface PageNode {
  type: string;
  name: string;
}

export interface Exchange {
  prompt: string;
  reply: string;
  /** The reply's action buttons are shown, so it is finished. */
  complete: boolean;
}

/** Page labels of the Simplified Chinese app. */
const LABELS = { you: ['你说：', '您说：'], assistant: ['ChatGPT 说：'], finished: '更多操作' };
const REQUEST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 20_000;

/** The last user message on the page and the ChatGPT reply after it. */
export function lastExchange(nodes: PageNode[]): Exchange | null {
  const text = (node: PageNode, names: string[]) => node.type === 'Text' && names.includes(node.name);
  const you = nodes.findLastIndex((node) => text(node, LABELS.you));
  if (you < 0) return null;
  const assistant = nodes.findIndex((node, index) => index > you && text(node, LABELS.assistant));
  const end = assistant < 0 ? nodes.length : assistant;
  const prompt = nodes.slice(you + 1, end).filter((node) => node.type === 'Text');
  if (assistant < 0) return { prompt: textOf(prompt), reply: '', complete: false };
  const rest = nodes.slice(assistant + 1);
  const finished = rest.findIndex((node) => node.type === 'Button' && node.name === LABELS.finished);
  const reply = (finished < 0 ? rest : rest.slice(0, finished)).filter((node) => node.type === 'Text');
  return { prompt: textOf(prompt), reply: textOf(reply), complete: finished >= 0 };
}

function textOf(nodes: PageNode[]): string {
  return nodes
    .map((node) => node.name)
    .join('\n')
    .trim();
}

const squash = (text: string) => normalize(text).replace(/\s+/g, ' ');

/**
 * The ChatGPT window, through a long-lived PowerShell UI Automation helper (window.ps1).
 * Reading a page never activates the window; starting a chat does, because the app focuses
 * the window when its new-chat button or composer is used. Page operations run one at a
 * time, since each depends on which conversation the window shows.
 */
export class ChatGptWindow {
  #child: ChildProcess | undefined;
  #answer: ((line: string) => void) | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /** Runs `task` after the page operations already queued. */
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
   * The reply to `prompt` from the page showing `title`, once ChatGPT has finished it. The
   * prompt is matched on the page, so the reply belongs to the message that was sent.
   */
  async readReply(title: string, prompt: string, timeoutMs = READ_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const expected = squash(prompt);
    for (;;) {
      const page = await this.#request({ op: 'transcript', title });
      const exchange = page.found && !page.busy ? lastExchange(page.nodes as PageNode[]) : null;
      if (exchange?.complete && exchange.reply && squash(exchange.prompt).startsWith(expected)) return exchange.reply;
      if (Date.now() >= deadline) {
        throw new AcbError(
          'WINDOW',
          page.found
            ? 'The reply was not found on the ChatGPT page'
            : 'The ChatGPT window does not show the conversation; the app does not update a window that is fully covered, so keep part of it visible',
        );
      }
      await delay(500);
    }
  }

  /** Opens a new chat in the ChatGPT-mode window and sends `prompt`. */
  async startChat(prompt: string): Promise<void> {
    await this.#request({ op: 'compose', prompt });
  }

  async #request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32')
      throw new AcbError('UNAVAILABLE', 'The ChatGPT window can only be used on Windows');
    if (!this.#child) this.#start();
    const child = this.#child as ChildProcess;
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new AcbError('WINDOW', 'The window helper did not answer in time')),
        REQUEST_TIMEOUT_MS,
      );
      const exited = () => fail(new AcbError('WINDOW', 'The window helper stopped'));
      const fail = (error: AcbError) => {
        this.close();
        done();
        reject(error);
      };
      const done = () => {
        clearTimeout(timer);
        child.off('exit', exited);
        this.#answer = undefined;
      };
      this.#answer = (text) => {
        done();
        resolve(text);
      };
      child.once('exit', exited);
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    });
    const response = JSON.parse(line) as Record<string, unknown>;
    if (response.ok !== true) throw new AcbError(response.code as ErrorCode, String(response.message));
    return response;
  }

  #start(): void {
    const script = fileURLToPath(new URL('./window.ps1', import.meta.url));
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
    child.on('error', () => this.#child === child && this.close());
    child.on('exit', () => {
      if (this.#child === child) this.#child = undefined;
    });
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => this.#answer?.(line));
    this.#child = child;
  }
}
