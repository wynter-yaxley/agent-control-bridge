#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig, type BridgeConfig } from './config.ts';
import { BridgeError, asBridgeError } from './errors.ts';
import { NativeClient, closeNativeWorker } from './native.ts';
import { WindowsNativeUi, closeUiWorkers } from './windows-ui.ts';
import { createGpt, openGpt, sendGpt, type GptDeps } from './gpt.ts';
import { createCodex, searchCodex, sendCodex } from './codex.ts';
import { createWorkspace } from './workspace.ts';

/** Hermes-facing MCP server: workspaces and Codex projects, GPT/Codex conversations,
 * locating a target, sending one prompt and returning the real reply. One call at a time. */
export function createServer(config: BridgeConfig): McpServer {
  const server = new McpServer({ name: 'agent-control-bridge', version: '0.3.0' });
  const ui = new WindowsNativeUi(config);
  const native = () => {
    if (!config.carrierThreadId) throw new BridgeError('CONFIG', 'carrierThreadId (an existing Codex thread ID) is required for Native IPC');
    return new NativeClient({ carrierThreadId: config.carrierThreadId, ...config.nativeInterface });
  };
  let queue: Promise<unknown> = Promise.resolve();
  const run = (operation: () => Promise<unknown>) => {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending.then(value => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] }),
      error => { const failure = asBridgeError(error); return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, code: failure.code, message: failure.message }) }], isError: true }; });
  };
  const id = z.string().min(1).max(200), prompt = z.string().min(1).max(65536), title = z.string().min(1).max(200);
  const gpt = (): GptDeps => ({ native: native(), ui, timeoutMs: config.timeoutMs, pollMs: Math.max(config.uiPollMs, 1000) });
  const codex = () => { if (!config.codexExecutable) throw new BridgeError('CONFIG', 'codexExecutable is required'); return { executable: config.codexExecutable, timeoutMs: config.timeoutMs, pollMs: 3000 }; };
  server.registerTool('acb_threads', { description: 'List recent native desktop conversations (id, kind codex/chatgpt, title, projectId, cwd).', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } },
    () => run(() => native().listThreads()));
  server.registerTool('acb_projects', { description: 'List native desktop projects (projectId, projectKind, label, path).', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } },
    () => run(() => native().listProjects()));
  server.registerTool('acb_workspace_create', { description: 'Create a local workspace directory (path, or workspaceRoot/name) and register it as a Codex project (App Server project/create). Repeating it for the same directory returns the same project.', inputSchema: z.object({ name: z.string().min(1).max(100), path: z.string().min(1).max(260).optional() }).strict() },
    args => run(() => createWorkspace({ ...codex(), root: config.workspaceRoot }, args.name, args.path)));
  server.registerTool('acb_codex_create', { description: 'Create a named Codex conversation in a workspace directory (App Server thread/start); its first prompt is sent and answered so the thread is persisted.', inputSchema: z.object({ cwd: z.string().min(1).max(260), title, prompt: prompt.optional() }).strict() },
    args => run(() => createCodex(codex(), args.cwd, args.title, args.prompt)));
  server.registerTool('acb_codex_find', { description: 'Full-text search of Codex conversations (App Server thread/search); returns thread IDs.', inputSchema: z.object({ searchTerm: z.string().min(1).max(200) }).strict(), annotations: { readOnlyHint: true } },
    args => run(() => searchCodex(codex(), args.searchTerm)));
  server.registerTool('acb_codex_send', { description: 'Send a prompt to a Codex thread by ID, wait for and return its final reply. Archived threads are unarchived once; approvals are never granted by the bridge. A prompt that is already the latest turn is not resent.', inputSchema: z.object({ threadId: id, prompt }).strict() },
    args => run(() => sendCodex(codex(), args.threadId, args.prompt)));
  server.registerTool('acb_gpt_create', { description: 'Create a new ordinary ChatGPT conversation with a unique title and return its exact ID. Needs --allow-foreground-input and the ChatGPT window in front.', inputSchema: z.object({ title }).strict() },
    args => run(() => createGpt(gpt(), args.title)));
  server.registerTool('acb_gpt_open', { description: 'Locate a ChatGPT conversation by ID in the desktop app (current view or its single sidebar entry) and confirm it is the one shown.', inputSchema: z.object({ conversationId: id }).strict() },
    args => run(async () => { const deps = gpt(), page = await deps.native.readThread(args.conversationId); return { conversationId: args.conversationId, title: page.thread.title, navigation: await openGpt(deps, args.conversationId, page.thread.title) }; }));
  server.registerTool('acb_gpt_send', { description: 'Locate a ChatGPT conversation, send a prompt (an identical user-written draft is sent as is; otherwise typed with --allow-foreground-input), wait for and return its reply. A prompt that is already the latest turn is not resent.', inputSchema: z.object({ conversationId: id, prompt }).strict() },
    args => run(() => sendGpt(gpt(), args.conversationId, args.prompt)));
  return server;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'carrier-thread': { type: 'string' }, codex: { type: 'string' }, 'allow-foreground-input': { type: 'boolean' } }, strict: true });
  const config = loadConfig(values.config, { carrierThreadId: values['carrier-thread'], codexExecutable: values.codex, foregroundInput: values['allow-foreground-input'] });
  const server = createServer(config);
  const stop = async () => { await server.close(); closeUiWorkers(); closeNativeWorker(); process.exit(0); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  await server.connect(new StdioServerTransport());
}
