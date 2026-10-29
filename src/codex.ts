import { type Page, SHOW_MS } from './chatgpt.ts';
import { type Sent, sendPrompt, type WaitOptions, waitForTurn } from './conversation.ts';
import type { App, CreateTarget, ThreadPage, ThreadSummary } from './desktop.ts';
import { AcbError } from './errors.ts';
import { type Approval, type ApprovalCard, approvalOf } from './helper.ts';
import { type Conversation, normalize, statusOf, type Turn, toConversation } from './turns.ts';

/**
 * The app returns at most 20,000 characters of a delegated message: the prompt, XML-escaped,
 * inside an envelope of about 130 characters. A longer prompt could not be read back whole,
 * so it could not be told apart from another one; it is refused.
 */
const MAX_ESCAPED_PROMPT = 19_800;

function delegable(prompt: string): string {
  const text = normalize(prompt);
  const escaped = text.length + (text.match(/&/g)?.length ?? 0) * 4 + (text.match(/[<>]/g)?.length ?? 0) * 3;
  if (escaped > MAX_ESCAPED_PROMPT) {
    throw new AcbError(
      'INPUT',
      'Codex messages are limited to about 19,800 characters: put long material in a file and refer to it',
    );
  }
  return text;
}

/** Codex conversations in the app's sidebar order, optionally only those of one folder. */
export async function listCodex(app: App, options: { cwd?: string; limit?: number } = {}): Promise<ThreadSummary[]> {
  const { threads, unavailable } = await app.listThreads();
  if (unavailable.includes('codex'))
    throw new AcbError('UNAVAILABLE', 'The desktop app could not list its Codex conversations');
  const folder = options.cwd && samePath(options.cwd);
  return threads
    .filter(
      (thread) => thread.kind === 'codex' && (!folder || (thread.cwd !== null && samePath(thread.cwd) === folder)),
    )
    .slice(0, options.limit ?? 20);
}

export async function readCodex(
  app: App,
  threadId: string,
  options: { turns?: number; cursor?: string } = {},
): Promise<Conversation> {
  const page = await app.readThread(threadId, options);
  if (page.kind !== 'codex') throw new AcbError('INPUT', 'This is a ChatGPT conversation: use acb_gpt_read');
  return toConversation(page);
}

/** The conversation delegates the message to itself, so no other conversation is named in it. */
export async function sendCodex(
  app: App,
  threadId: string,
  prompt: string,
  options: WaitOptions & { wait: boolean },
): Promise<Sent> {
  return sendPrompt(app, 'codex', threadId, delegable(prompt), { ...options, caller: threadId });
}

export interface CreateCodex {
  prompt: string;
  title?: string;
  /** A project of acb_projects; without one, the app creates a folder under Documents\Codex. */
  projectId?: string;
  /** Folder name for a conversation without a project. */
  folder?: string;
  wait: boolean;
}

export async function createCodex(
  app: App,
  request: CreateCodex,
  options: WaitOptions,
): Promise<{ threadId: string; title: string; cwd: string | null; turn: Turn | null }> {
  const prompt = delegable(request.prompt);
  const target: CreateTarget = request.projectId
    ? { type: 'project', projectId: request.projectId, environment: { type: 'local' } }
    : { type: 'projectless', ...(request.folder ? { directoryName: request.folder } : {}) };
  const threadId = await app.createThread({ prompt, target, ...(request.title ? { title: request.title } : {}) });
  const turn = request.wait
    ? await waitForTurn(app, threadId, prompt, { after: undefined, occurrence: 0 }, options)
    : null;
  const page = await app.readThread(threadId, { outputs: false });
  return { threadId, title: page.title, cwd: page.cwd, turn };
}

/** What a Codex conversation waits for the user to approve, if anything. */
export type Pending = { threadId: string; status: 'none' } | ({ threadId: string; status: 'pending' } & Approval);

/**
 * The approval card Codex shows while it waits for the user. The app's tools only tell that it
 * waits, so the card is read from the page: the conversation is shown (the window is not
 * activated, but opened from the tray or raised above covering windows for the read). Without
 * a wait, the page is not touched.
 */
export async function readApproval(app: App, page: Page, threadId: string): Promise<Pending> {
  const read = await waiting(app, threadId);
  if (!read) return { threadId, status: 'none' };
  const card = await withCard(app, page, read, async (card) => card);
  return card ? { threadId, status: 'pending', ...approvalOf(card) } : { threadId, status: 'none' };
}

/**
 * Presses `button` on the approval card that asks `question`: the user's choice, or the default
 * allow they agreed to. ACB does not press on its own: without `confirm`, nothing is read or
 * pressed. The result names the card, for the agent to report to the user.
 */
export async function answerApproval(
  app: App,
  page: Page,
  threadId: string,
  { question, button, confirm }: { question: string; button: string; confirm: boolean },
): Promise<{ threadId: string; pressed: string; title: string; question: string }> {
  if (confirm !== true) {
    throw new AcbError(
      'UNCONFIRMED',
      'Answering an approval needs confirm: true (the user chose this, or it is the default allow they agreed to)',
      { threadId },
    );
  }
  const read = await waiting(app, threadId);
  if (!read) throw new AcbError('NO_APPROVAL', 'Codex is not waiting for the user in this conversation', { threadId });
  const title = await withCard(app, page, read, async (card) => {
    const shown = card && approvalOf(card);
    if (!card || !shown || normalize(shown.question) !== normalize(question)) {
      throw new AcbError('NO_APPROVAL', 'The conversation shows no approval card with this question; read it again', {
        threadId,
      });
    }
    if (!shown.buttons.some((option) => option.name === button)) {
      throw new AcbError('NO_APPROVAL', `The approval card has no button named ${button}`, {
        threadId,
        buttons: shown.buttons.map((option) => option.name),
      });
    }
    await page.press(read.title, card.text, button);
    return shown.title;
  });
  return { threadId, pressed: button, title, question };
}

/** The Codex conversation when it waits for the user; undefined when it does not. */
async function waiting(app: App, threadId: string): Promise<ThreadPage | undefined> {
  const read = await app.readThread(threadId, { outputs: false });
  if (read.kind !== 'codex') throw new AcbError('INPUT', 'This is a ChatGPT conversation, which asks for no approvals');
  return statusOf(read) === 'needsUser' ? read : undefined;
}

/**
 * Shows the conversation and runs `use` with the approval card its page shows (null: none).
 * The page shows no conversation ID, so it is told by its title, which no other listed
 * conversation may have.
 */
async function withCard<T>(
  app: App,
  page: Page,
  read: ThreadPage,
  use: (card: ApprovalCard | null) => Promise<T>,
): Promise<T> {
  const { threads } = await app.listThreads();
  if (threads.some((thread) => thread.title === read.title && thread.id !== read.id)) {
    throw new AcbError('WINDOW', 'Another conversation has the same title; rename one to read its approval card', {
      threadId: read.id,
    });
  }
  return page.run(async () => {
    const giveBack = await page.holdForeground();
    try {
      // As for history: the card must be read while the user is away, so a window closed in
      // the tray is opened, and a covered one raised (it is shown before the page switches).
      if (await page.launch()) await giveBack();
      const lower = await page.raise();
      try {
        await app.show(read.id);
        await giveBack();
        const card = await page.approval(read.title, SHOW_MS);
        if (card === undefined) {
          throw new AcbError('WINDOW', 'The ChatGPT window does not show the conversation on screen', {
            threadId: read.id,
          });
        }
        return await use(card);
      } finally {
        await lower();
      }
    } finally {
      await giveBack();
    }
  });
}

function samePath(path: string): string {
  return path
    .replace(/[\\/]+$/, '')
    .replaceAll('/', '\\')
    .toLowerCase();
}
