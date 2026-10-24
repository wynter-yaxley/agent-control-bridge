import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { createGpt, listGpt, type Page, readGpt, sendGpt } from './chatgpt.ts';
import { createCodex, listCodex, readCodex, sendCodex } from './codex.ts';
import { type App, UUID } from './desktop.ts';
import { toAcbError } from './errors.ts';

export interface Services {
  app: App;
  page: Page;
  version: string;
  /** How long a send waits for the reply. */
  timeoutMs: number;
}

const INSTRUCTIONS = `Tools for the ChatGPT desktop app on this computer: list, read, create and message ChatGPT and Codex conversations.
Messages run inside the app, so the user sees them live. Listing and reading never send anything.
Sending a prompt that is already the newest message of the conversation does not send it again: repeat a timed-out send to collect its reply.
Only acb_gpt_create brings the ChatGPT window to the front; reading a ChatGPT reply from the page and acb_open switch the page the app shows.`;

const id = (what: string) => z.string().regex(UUID, `Expected a ${what} ID`).describe(`${what} ID`);
const prompt = z.string().trim().min(1).max(100_000).describe('Message to send');
const title = z.string().trim().min(1).max(200).describe('Conversation title');
const turns = z.number().int().min(1).max(10).optional().describe('Newest turns to return (1-10, default 1)');
const cursor = z.string().min(1).max(4000).optional().describe('nextCursor of a previous read, for older turns');
const limit = z.number().int().min(1).max(50).optional().describe('Maximum conversations (1-50, default 20)');
const wait = z
  .boolean()
  .optional()
  .describe('Wait for the reply (default true). With false, read the conversation later.');

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const SEND = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function createServer({ app, page, version, timeoutMs }: Services): McpServer {
  const server = new McpServer({ name: 'agent-control-bridge', version }, { instructions: INSTRUCTIONS });
  const waiting = (wait: boolean | undefined) => ({ wait: wait ?? true, timeoutMs });

  server.registerTool(
    'acb_status',
    {
      description: 'Check that the ChatGPT desktop app is reachable. Call it first when a tool reports UNAVAILABLE.',
      inputSchema: {},
      annotations: READ,
    },
    () =>
      answer(async () => {
        const started = Date.now();
        await app.listProjects();
        return { version, app: 'reachable', latencyMs: Date.now() - started, caller: await app.caller() };
      }),
  );

  server.registerTool(
    'acb_projects',
    {
      description:
        'List the projects of the desktop app (projectId, label, path, isGitRepository). Pass a projectId to acb_codex_create.',
      inputSchema: {},
      annotations: READ,
    },
    () => answer(() => app.listProjects()),
  );

  server.registerTool(
    'acb_open',
    {
      description:
        'Show a ChatGPT or Codex conversation in the desktop app, e.g. so the user can watch it. Switches the page of the app window without activating it; sends nothing.',
      inputSchema: { id: id('Conversation') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      answer(async () => {
        await app.show(args.id);
        return { shown: args.id };
      }),
  );

  server.registerTool(
    'acb_codex_list',
    {
      description:
        'List recent Codex conversations of the desktop app (id, title, status, cwd, projectId, updatedAt), most recent first.',
      inputSchema: { cwd: z.string().min(1).max(1000).optional().describe('Only conversations in this folder'), limit },
      annotations: READ,
    },
    (args) => answer(() => listCodex(app, args)),
  );

  server.registerTool(
    'acb_codex_read',
    {
      description:
        'Read a Codex conversation: its status (idle, running, needsUser) and the prompt and final reply of its newest turns, oldest first.',
      inputSchema: { threadId: id('Codex conversation'), turns, cursor },
      annotations: READ,
    },
    (args) => answer(() => readCodex(app, args.threadId, args)),
  );

  server.registerTool(
    'acb_codex_create',
    {
      description:
        'Start a Codex conversation in the desktop app with a first prompt and return its reply. Runs in a project (projectId from acb_projects) or, without one, in a new folder under Documents\\Codex. In the app, the first message is shown as sent by another conversation.',
      inputSchema: {
        prompt,
        title: title.optional(),
        projectId: id('Project').optional(),
        folder: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[\w.-]+$/)
          .optional()
          .describe('Folder name when there is no project'),
        wait,
      },
      annotations: CREATE,
    },
    (args) => answer(() => createCodex(app, { ...args, wait: args.wait ?? true }, { timeoutMs })),
  );

  server.registerTool(
    'acb_codex_send',
    {
      description:
        "Send a prompt to a Codex conversation and return its final reply. Codex runs it in the desktop app with the app's permissions; NEEDS_USER means it waits for the user's approval there. Archived conversations are restored. Long tasks: pass wait: false, then acb_codex_read.",
      inputSchema: { threadId: id('Codex conversation'), prompt, wait },
      annotations: SEND,
    },
    (args) => answer(() => sendCodex(app, args.threadId, args.prompt, waiting(args.wait))),
  );

  server.registerTool(
    'acb_gpt_list',
    {
      description:
        'List recent ChatGPT conversations of the desktop app (id, title, status, projectId, pinned), pinned first.',
      inputSchema: { limit },
      annotations: READ,
    },
    (args) => answer(() => listGpt(app, args)),
  );

  server.registerTool(
    'acb_gpt_read',
    {
      description:
        'Read a ChatGPT conversation: the prompt and reply of its newest turns, oldest first. The app keeps most replies only on the page (replyOnPage: true); page: true reads the newest one there by showing the conversation in the app (not activating the window).',
      inputSchema: {
        conversationId: id('ChatGPT conversation'),
        turns,
        cursor,
        page: z.boolean().optional().describe('Read the newest reply from the ChatGPT page'),
      },
      annotations: READ,
    },
    (args) => answer(() => readGpt(app, page, args.conversationId, { ...args, fromPage: args.page })),
  );

  server.registerTool(
    'acb_gpt_create',
    {
      description:
        'Start a ChatGPT conversation with a first prompt and return its reply. The only tool that brings the ChatGPT window to the front: the app has no other way to open a new chat. No keystrokes are sent.',
      inputSchema: { prompt, title: title.optional() },
      annotations: CREATE,
    },
    (args) => answer(() => createGpt(app, page, args, { timeoutMs })),
  );

  server.registerTool(
    'acb_gpt_send',
    {
      description:
        'Send a prompt to a ChatGPT conversation and return its reply. Sending happens in the background; the reply is then read from the page, so the app shows this conversation (the window is not activated).',
      inputSchema: { conversationId: id('ChatGPT conversation'), prompt, wait },
      annotations: SEND,
    },
    (args) => answer(() => sendGpt(app, page, args.conversationId, args.prompt, waiting(args.wait))),
  );

  return server;
}

/** Tool results are compact JSON; failures carry the error code and its details. */
async function answer(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await work()) }] };
  } catch (error) {
    const failure = toAcbError(error);
    const body = { error: failure.code, message: failure.message, ...failure.details };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
}
