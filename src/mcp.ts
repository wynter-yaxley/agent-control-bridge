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
import { createCodex, sendCodex } from './codex.ts';
import { createWorkspace } from './workspace.ts';

/** Hermes-facing MCP server: create a workspace/project and GPT/Codex conversations,
 * open a target, send one prompt and return the real reply. Calls run one at a time. */
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
  const codex = () => { if (!config.codexExecutable) throw new BridgeError('CONFIG', 'codexExecutable is required'); return config.codexExecutable; };
  server.registerTool('acb_threads', { description: 'List recent native desktop conversations (id, kind codex/chatgpt, title, projectId).', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } },
    () => run(() => native().listThreads()));
  server.registerTool('acb_projects', { description: 'List native projects (projectId, kind, label, path).', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } },
    () => run(() => native().listProjects()));
  server.registerTool('acb_workspace_create', { description: 'Create a local workspace directory (path, or workspaceRoot/name) and its native project; an existing project for the directory is reused.', inputSchema: z.object({ name: z.string().min(1).max(100), path: z.string().min(1).max(260).optional() }).strict() },
    args => run(() => createWorkspace({ native: native(), ui, root: config.workspaceRoot, timeoutMs: config.timeoutMs, pollMs: 1000 }, args.name, args.path)));
  server.registerTool('acb_gpt_create', { description: 'Create a new ordinary ChatGPT conversation with a unique title (optionally moved into a project) and return its ID.', inputSchema: z.object({ title, projectId: id.optional() }).strict() },
    args => run(() => createGpt(gpt(), args.title, args.projectId)));
  server.registerTool('acb_codex_create', { description: 'Create a Codex conversation in a native local project; waits for the reply to its first prompt.', inputSchema: z.object({ projectId: id, title, prompt: prompt.optional() }).strict() },
    args => run(() => createCodex({ native: native(), timeoutMs: config.timeoutMs, pollMs: 3000 }, args.projectId, args.title, args.prompt)));
  server.registerTool('acb_gpt_open', { description: 'Open a ChatGPT conversation by ID in the desktop app and confirm it is the one shown.', inputSchema: z.object({ conversationId: id }).strict() },
    args => run(async () => { const deps = gpt(), page = await deps.native.readThread(args.conversationId); return { conversationId: args.conversationId, title: page.thread.title, navigation: await openGpt(deps, args.conversationId, page.thread.title) }; }));
  server.registerTool('acb_gpt_send', { description: 'Open a ChatGPT conversation, send a prompt, wait for and return its reply. A prompt that is already the latest turn is not resent; its reply is returned.', inputSchema: z.object({ conversationId: id, prompt }).strict() },
    args => run(() => sendGpt(gpt(), args.conversationId, args.prompt)));
  server.registerTool('acb_codex_send', { description: 'Send a prompt to an existing Codex thread through codex app-server, wait for and return its final reply. Command/file approvals are declined. A prompt that is already the latest turn is not resent.', inputSchema: z.object({ threadId: id, prompt }).strict() },
    args => run(() => sendCodex({ executable: codex(), timeoutMs: config.timeoutMs, pollMs: 3000 }, args.threadId, args.prompt)));
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
