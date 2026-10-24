import { type Sent, sendPrompt, type WaitOptions, waitForTurn } from './conversation.ts';
import type { App, CreateTarget, ThreadSummary } from './desktop.ts';
import { AcbError } from './errors.ts';
import { type Conversation, normalize, type Turn, toConversation } from './turns.ts';

/** Codex conversations of the app's sidebar, most recent first; optionally of one folder. */
export async function listCodex(app: App, options: { cwd?: string; limit?: number } = {}): Promise<ThreadSummary[]> {
  const folder = options.cwd && samePath(options.cwd);
  return (await app.listThreads())
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
export function sendCodex(
  app: App,
  threadId: string,
  prompt: string,
  options: WaitOptions & { wait: boolean },
): Promise<Sent> {
  return sendPrompt(app, 'codex', threadId, prompt, { ...options, caller: threadId });
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
  const prompt = normalize(request.prompt);
  const target: CreateTarget = request.projectId
    ? { type: 'project', projectId: request.projectId, environment: { type: 'local' } }
    : { type: 'projectless', ...(request.folder ? { directoryName: request.folder } : {}) };
  const threadId = await app.createThread({ prompt, target, ...(request.title ? { title: request.title } : {}) });
  const turn = request.wait ? await waitForTurn(app, threadId, prompt, {}, options) : null;
  const page = await app.readThread(threadId, { outputs: false });
  return { threadId, title: page.title, cwd: page.cwd, turn };
}

function samePath(path: string): string {
  return path
    .replace(/[\\/]+$/, '')
    .replaceAll('/', '\\')
    .toLowerCase();
}
