import type { AppTurn, Json, Kind, ThreadPage } from './desktop.ts';

/** A turn as ACB reports it: the message, the final reply and how it ended. */
export interface Turn {
  turnId: string;
  /** `completed`, `inProgress`, `failed` or `interrupted`. */
  status: string;
  prompt: string | null;
  /** Final answer text; commentary, reasoning and tool output are left out. */
  reply: string | null;
  /** The app keeps this ChatGPT reply only on the page; read it with `page: true`. */
  replyOnPage: boolean;
  /** The app shortened the prompt or the reply (it returns at most 20,000 characters each). */
  truncated: boolean;
  error: string | null;
}

/** `running` while a turn is in progress, `needsUser` while Codex waits for the user. */
export type Status = 'idle' | 'running' | 'needsUser';

export interface Conversation {
  id: string;
  kind: Kind;
  title: string;
  status: Status;
  cwd: string | null;
  /** Oldest first. */
  turns: Turn[];
  /** Pass as `cursor` to read older turns. */
  nextCursor: string | null;
}

export interface Prompt {
  text: string;
  /** False when the app shortened it; `text` is then a prefix of the message. */
  complete: boolean;
}

const WAITING_FOR_USER = new Set(['waitingOnApproval', 'waitingOnUserInput']);
/** How the app stores a ChatGPT reply whose text lives only on the page. */
const PAGE_REFERENCE = /^(?:\s*::chatgpt-content-reference\{[^}\n]*\}\s*)+$/;

export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
}

export function statusOf(page: Pick<ThreadPage, 'status' | 'activeFlags'>): Status {
  if (page.status !== 'active') return 'idle';
  return page.activeFlags.some((flag) => WAITING_FOR_USER.has(flag)) ? 'needsUser' : 'running';
}

/**
 * The message that opened the turn: a user message, or the delegation the app records for
 * a message sent through its tools (`<codex_delegation>…<input>message</input>…`).
 */
export function promptOf(turn: AppTurn): Prompt | null {
  const first = turn.items[0];
  const output = first?.type === 'functionCallOutput' ? (first.output as Json | undefined) : undefined;
  if (typeof output?.text === 'string' && output.text.trimStart().startsWith('<codex_delegation>')) {
    const start = output.text.indexOf('<input>');
    if (start < 0) return { text: '', complete: false };
    const end = output.text.indexOf('</input>', start);
    const raw = end < 0 ? output.text.slice(start + 7).replace(/&[a-z]*$/, '') : output.text.slice(start + 7, end);
    return { text: normalize(unescapeXml(raw)), complete: end >= 0 };
  }
  const parts = turn.items
    .filter((item) => item.type === 'userMessage' && Array.isArray(item.content))
    .flatMap((item) => item.content as Json[])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string');
  if (!parts.length) return null;
  return {
    text: normalize(parts.map((part) => String(part.text)).join('\n\n')),
    complete: !parts.some((part) => part.truncated === true),
  };
}

/** Whether the turn was opened by `text` (already normalized). */
export function opensWith(turn: AppTurn | undefined, text: string): boolean {
  const prompt = turn && promptOf(turn);
  if (!prompt) return false;
  return prompt.complete ? prompt.text === text : prompt.text.length > 0 && text.startsWith(prompt.text);
}

export function toTurn(turn: AppTurn): Turn {
  const prompt = promptOf(turn);
  const answers = turn.items.filter(
    (item) =>
      item.type === 'agentMessage' && item.phase !== 'commentary' && typeof item.text === 'string' && item.text.trim(),
  );
  const written = answers.filter((item) => !PAGE_REFERENCE.test(String(item.text)));
  return {
    turnId: turn.id,
    status: turn.status,
    prompt: prompt?.text || null,
    reply: written.length ? written.map((item) => String(item.text)).join('\n\n') : null,
    replyOnPage: !written.length && answers.length > 0,
    truncated: prompt?.complete === false || written.some((item) => item.truncated === true),
    error: errorText(turn.error),
  };
}

export function toConversation(page: ThreadPage): Conversation {
  return {
    id: page.id,
    kind: page.kind,
    title: page.title,
    status: statusOf(page),
    cwd: page.cwd,
    turns: page.turns.map(toTurn).reverse(),
    nextCursor: page.nextCursor,
  };
}

function unescapeXml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function errorText(error: unknown): string | null {
  if (error == null) return null;
  if (typeof error === 'string') return error.slice(0, 2000);
  const message = (error as Json).message;
  return typeof message === 'string' ? message.slice(0, 2000) : 'The turn failed';
}
