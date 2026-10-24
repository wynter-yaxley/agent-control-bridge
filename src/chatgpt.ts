import { setTimeout as delay } from 'node:timers/promises';
import { type Sent, sendPrompt, type WaitOptions, waitForTurn } from './conversation.ts';
import type { App, ThreadSummary } from './desktop.ts';
import { AcbError } from './errors.ts';
import { type Conversation, normalize, opensWith, type Turn, toConversation } from './turns.ts';
import type { ChatGptWindow } from './window.ts';

/** The page operations of ChatGptWindow; tests substitute them. */
export type Page = Pick<ChatGptWindow, 'run' | 'readReply' | 'startChat'>;

/** A finished turn whose reply could not be read from the page keeps `replyOnPage` and says why. */
export interface PageRead {
  pageError?: string;
}

export async function listGpt(app: App, options: { limit?: number } = {}): Promise<ThreadSummary[]> {
  return (await app.listThreads()).filter((thread) => thread.kind === 'chatgpt').slice(0, options.limit ?? 20);
}

/**
 * The app keeps most ChatGPT replies only on the page. With `fromPage`, the newest reply is
 * read there: the conversation is shown in the app (the window is not activated).
 */
export async function readGpt(
  app: App,
  page: Page,
  conversationId: string,
  options: { turns?: number; cursor?: string; fromPage?: boolean } = {},
): Promise<Conversation> {
  const read = await app.readThread(conversationId, options);
  if (read.kind !== 'chatgpt') throw new AcbError('INPUT', 'This is a Codex conversation: use acb_codex_read');
  const conversation = toConversation(read);
  const newest = conversation.turns.at(-1);
  if (options.fromPage && !options.cursor && newest?.replyOnPage && newest.status === 'completed') {
    newest.reply = await pageReply(app, page, conversationId, newest);
    newest.replyOnPage = false;
  }
  return conversation;
}

export async function sendGpt(
  app: App,
  page: Page,
  conversationId: string,
  prompt: string,
  options: WaitOptions & { wait: boolean },
): Promise<Sent & PageRead> {
  const sent = await sendPrompt(app, 'chatgpt', conversationId, prompt, options);
  return sent.turn ? { ...sent, ...(await withPageReply(app, page, conversationId, sent.turn)) } : sent;
}

/**
 * Starts a ChatGPT conversation with `prompt` and returns its first reply. The app offers no
 * tool for this, so the window is used: it shows an existing ChatGPT conversation (which
 * puts it in ChatGPT mode), opens a new chat and sends the prompt. The new conversation is
 * then recognized in the app's list by its first message.
 */
export async function createGpt(
  app: App,
  page: Page,
  request: { prompt: string; title?: string },
  options: WaitOptions,
): Promise<{ conversationId: string; title: string; turn: Turn } & PageRead> {
  const prompt = normalize(request.prompt);
  const known = await app.listThreads();
  const anchor = known.find((thread) => thread.kind === 'chatgpt');
  if (!anchor) throw new AcbError('WINDOW', 'Start one ChatGPT conversation in the desktop app first');
  await page.run(async () => {
    await app.show(anchor.id);
    await page.startChat(prompt);
  });
  const conversationId = await recognize(app, new Set(known.map((thread) => thread.id)), prompt);
  const turn = await waitForTurn(app, conversationId, prompt, {}, options);
  // ChatGPT names a new conversation after its first reply, so the title is set afterwards.
  if (request.title) await setTitle(app, conversationId, request.title);
  const read = await withPageReply(app, page, conversationId, turn);
  const { title } = await app.readThread(conversationId, { outputs: false });
  return { conversationId, title, ...read };
}

async function recognize(app: App, known: Set<string>, prompt: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    for (const thread of await app.listThreads()) {
      if (thread.kind !== 'chatgpt' || known.has(thread.id)) continue;
      // A conversation can be listed before its first message is readable; it is checked again.
      const newest = await app.readThread(thread.id).then(
        (read) => read.turns[0],
        () => undefined,
      );
      if (opensWith(newest, prompt)) return thread.id;
    }
    if (Date.now() >= deadline) {
      throw new AcbError('WINDOW', 'The prompt was sent, but the new conversation did not appear in the app');
    }
    await delay(500);
  }
}

/** A title set while ChatGPT still names the conversation can be overwritten; it is checked. */
async function setTitle(app: App, conversationId: string, title: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.setTitle(conversationId, 'chatgpt', title);
    await delay(1500);
    if ((await app.readThread(conversationId, { outputs: false })).title === title) return;
  }
  throw new AcbError('FAILED', 'The conversation was created, but its title did not stick', { conversationId });
}

/** The turn with its reply from the page, or unchanged with the reason the page could not be read. */
async function withPageReply(
  app: App,
  page: Page,
  conversationId: string,
  turn: Turn,
): Promise<{ turn: Turn } & PageRead> {
  if (!turn.replyOnPage) return { turn };
  try {
    return { turn: { ...turn, reply: await pageReply(app, page, conversationId, turn), replyOnPage: false } };
  } catch (error) {
    if (!(error instanceof AcbError)) throw error;
    return { turn, pageError: `${error.message}. Read the reply later with acb_gpt_read and page: true.` };
  }
}

async function pageReply(app: App, page: Page, conversationId: string, turn: Turn): Promise<string> {
  return page.run(async () => {
    await app.show(conversationId);
    const { title } = await app.readThread(conversationId, { outputs: false });
    return page.readReply(title, turn.prompt ?? '');
  });
}
