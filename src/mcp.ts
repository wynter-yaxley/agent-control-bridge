#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { VERSION, loadConfig, type BridgeConfig } from './config.ts';
import { BridgeError, asBridgeError } from './errors.ts';
import { NativeClient, closeNativeWorker } from './native.ts';
import { WindowsNativeUi, closeUiWorkers } from './windows-ui.ts';
import { createGpt, listGpt, openGpt, readGpt, readGptWithWindow, sendGpt, type GptDeps } from './gpt.ts';
import { closeCodex, createCodex, listCodex, readCodex, searchCodex, sendCodex } from './codex.ts';
import { createWorkspace } from './workspace.ts';
import { carrierThread, codexOptions, status } from './check.ts';

export { VERSION };
const INSTRUCTIONS = 'Agent Control Bridge exposes independent tools for the ChatGPT/Codex desktop app: list, find and read Codex conversations; list and read ChatGPT conversations; create a conversation or send one prompt and get its reply. Each tool does one thing; combine them only as the task requires. List, find and read tools never send anything. Prefer an existing conversation to creating one. On failure, report the error code and fix; do not retry a send blindly (a repeated prompt is never resent, it returns the pending reply).';

type Run = (operation: () => Promise<unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
interface Context { config: BridgeConfig; run: Run; native: () => Promise<NativeClient>; gpt: () => Promise<GptDeps> }
const id = z.string().min(1).max(200), prompt = z.string().min(1).max(65536), title = z.string().min(1).max(200);
const read = { readOnlyHint: true, openWorldHint: false } as const;

/** Readiness and the desktop app's own inventory (native IPC, read-only). */
function desktopTools(server: McpServer, { config, run, native }: Context): void {
  server.registerTool('acb_status', { description: 'Read-only readiness check: Codex found, desktop context, ChatGPT running, desktop inventory reachable, foreground input authorized. Use when a tool fails or before first use.', inputSchema: z.object({}).strict(), annotations: read },
    () => run(() => status(config)));
  server.registerTool('acb_threads', { description: 'List the desktop sidebar inventory of both kinds (id, kind codex/chatgpt, title, projectId, cwd). For one kind, prefer acb_codex_list or acb_gpt_list.', inputSchema: z.object({}).strict(), annotations: read },
    () => run(async () => (await native()).listThreads()));
  server.registerTool('acb_projects', { description: 'List desktop projects (projectId, projectKind, label, path).', inputSchema: z.object({}).strict(), annotations: read },
    () => run(async () => (await native()).listProjects()));
}

/** Codex conversations through `codex app-server`: background, no window, no desktop pipe. */
function codexTools(server: McpServer, { config, run }: Context): void {
  server.registerTool('acb_workspace_create', { description: 'Create a local workspace directory (path, or workspaceRoot/name) and register it as a Codex project. Repeating it for the same directory returns the same project. Background, no window.', inputSchema: z.object({ name: z.string().min(1).max(100), path: z.string().min(1).max(260).optional() }).strict(), annotations: { idempotentHint: true } },
    args => run(() => createWorkspace({ ...codexOptions(config), root: config.workspaceRoot }, args.name, args.path)));
  server.registerTool('acb_codex_list', { description: 'List recently updated Codex conversations (threadId, name, preview, cwd, status, updatedAt), optionally only one working directory; pass nextCursor to continue. Background, read-only.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), cwd: z.string().min(1).max(260).optional(), cursor: z.string().min(1).max(2000).optional() }).strict(), annotations: read },
    args => run(() => listCodex(codexOptions(config), args)));
  server.registerTool('acb_codex_find', { description: 'Full-text search of Codex conversations; returns thread IDs. Background, read-only.', inputSchema: z.object({ searchTerm: z.string().min(1).max(200) }).strict(), annotations: read },
    args => run(() => searchCodex(codexOptions(config), args.searchTerm)));
  server.registerTool('acb_codex_read', { description: 'Read a Codex conversation by ID: name, cwd, status and the prompt/reply text of its newest turns (default 1, up to 20), oldest first. Background, read-only; nothing is sent or resumed.', inputSchema: z.object({ threadId: id, turns: z.number().int().min(1).max(20).optional() }).strict(), annotations: read },
    args => run(() => readCodex(codexOptions(config), args.threadId, args.turns)));
  server.registerTool('acb_codex_create', { description: 'Create a named Codex conversation in a workspace directory; its first prompt is sent and answered so it is saved. Background, no window.', inputSchema: z.object({ cwd: z.string().min(1).max(260), title, prompt: prompt.optional() }).strict() },
    args => run(() => createCodex(codexOptions(config), args.cwd, args.title, args.prompt)));
  server.registerTool('acb_codex_send', { description: 'Send a prompt to a Codex conversation by ID and return its final reply. Background, no window. Archived conversations are unarchived once; approvals are never granted by the bridge. If it times out, call again with the same prompt to read the reply (it is not resent).', inputSchema: z.object({ threadId: id, prompt }).strict() },
    args => run(() => sendCodex(codexOptions(config), args.threadId, args.prompt)));
}

/** ChatGPT conversations: list and read through native IPC (no window); open, create and
 * send through the verified ChatGPT window (UIA, Windows only). */
function gptTools(server: McpServer, { run, native, gpt }: Context): void {
  server.registerTool('acb_gpt_list', { description: 'List ChatGPT conversations of the desktop inventory (conversationId, title, projectId): pinned first, at most 50 others. Read-only, no window.', inputSchema: z.object({}).strict(), annotations: read },
    () => run(async () => listGpt(await native())));
  server.registerTool('acb_gpt_read', { description: 'Read a ChatGPT conversation by ID: title, status and the prompt/reply text of its newest turns (default 1, up to 10), oldest first; pass nextCursor to read older turns. No window by default; the desktop transcript often keeps a reply only as a reference (replyInWindowOnly). With window: true, the newest reply is read from the ChatGPT window (the chat is shown first, as acb_gpt_open). Nothing is typed or sent.', inputSchema: z.object({ conversationId: id, turns: z.number().int().min(1).max(10).optional(), cursor: z.string().min(1).max(2000).optional(), window: z.boolean().optional() }).strict(), annotations: read },
    args => run(async () => {
      if (!args.window) return readGpt(await native(), args.conversationId, args.turns, args.cursor);
      if (args.cursor) throw new BridgeError('INPUT', 'window reads only the newest turns; drop cursor');
      return readGptWithWindow(await gpt(), args.conversationId, args.turns);
    }));
  server.registerTool('acb_gpt_open', { description: 'Show a ChatGPT conversation by ID in the desktop app (current view or its single sidebar entry) and confirm it is the one shown. Uses the ChatGPT window (UIA click), no typing.', inputSchema: z.object({ conversationId: id }).strict() },
    args => run(async () => { const deps = await gpt(), page = await deps.native.readThread(args.conversationId); return { conversationId: args.conversationId, title: page.thread.title, navigation: await openGpt(deps, args.conversationId, page.thread.title) }; }));
  server.registerTool('acb_gpt_create', { description: 'Create a ChatGPT conversation from the left sidebar, identify its one-time marker, and verify its title and persistence before returning its ID. With --allow-foreground-input, restores/activates the verified ChatGPT window once; stops if focus changes. A partial error includes the known ID: do not create again or resend the marker.', inputSchema: z.object({ title, project: z.string().min(1).max(200).optional() }).strict() },
    async args => run(async () => createGpt(await gpt(), args.title, args.project)));
  server.registerTool('acb_gpt_send', { description: 'Send a prompt to a ChatGPT conversation by ID and return its reply. With --allow-foreground-input, restores/activates the verified ChatGPT window once, verifies actual foreground and composer focus, and stops if the user switches away. Without authorization, only an identical existing draft can be sent while ChatGPT is in front. An already-latest prompt is not resent.', inputSchema: z.object({ conversationId: id, prompt }).strict() },
    args => run(async () => sendGpt(await gpt(), args.conversationId, args.prompt)));
}

/** MCP server with independent tool groups. Calls run one at a time. */
export function createServer(config: BridgeConfig): McpServer {
  const server = new McpServer({ name: 'agent-control-bridge', version: VERSION }, { instructions: INSTRUCTIONS });
  const ui = new WindowsNativeUi(config);
  const native = async () => new NativeClient({ carrierThreadId: await carrierThread(config), ...config.nativeInterface });
  let queue: Promise<unknown> = Promise.resolve();
  const run: Run = operation => {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending.then(value => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] }),
      error => { const failure = asBridgeError(error); return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, code: failure.code, message: failure.message, ...failure.details }) }], isError: true }; });
  };
  const gpt = async (): Promise<GptDeps> => ({ native: await native(), ui, timeoutMs: config.timeoutMs, pollMs: Math.max(config.uiPollMs, 1000) });
  const context = { config, run, native, gpt };
  desktopTools(server, context); codexTools(server, context); gptTools(server, context);
  return server;
}

/** Copy-ready Hermes setup for this installation: MCP registration and the bundled skill,
 * for Hermes on Windows or in WSL. */
export function hermesCommands(node = process.execPath, entry = fileURLToPath(import.meta.url)) {
  const wsl = (path: string) => path.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
  const skill = `${entry.replace(/[\\/](?:dist|src)[\\/]mcp\.[jt]s$/, '')}${entry.includes('\\') ? '\\skills\\' : '/skills/'}agent-control-bridge`;
  // Not installed on Windows: Codex tools only, Hermes on the same machine.
  if (!/^[A-Za-z]:\\/.test(entry)) return { local: { mcp: `hermes mcp add acb --command '${node}' --args '${entry}'`, skill: `cp -r '${skill}' ~/.hermes/skills/` } };
  return {
    windows: { mcp: `hermes mcp add acb --command "${node}" --args "${entry}" --allow-foreground-input`, skill: `Copy-Item -Recurse -Force "${skill}" "$env:LOCALAPPDATA\\hermes\\skills\\"` },
    wsl: { mcp: `hermes mcp add acb --command '${wsl(node)}' --args '${entry}' --allow-foreground-input`, skill: `cp -r '${wsl(skill)}' ~/.hermes/skills/` },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'carrier-thread': { type: 'string' }, codex: { type: 'string' }, 'allow-foreground-input': { type: 'boolean' }, debug: { type: 'boolean' }, check: { type: 'boolean' }, version: { type: 'boolean' } }, strict: true });
  if (values.version) { console.log(VERSION); process.exit(0); }
  let config: BridgeConfig;
  try { config = loadConfig(values.config, { carrierThreadId: values['carrier-thread'], codexExecutable: values.codex, foregroundInput: values['allow-foreground-input'], debug: values.debug }); }
  catch (error) { console.error(`agent-control-bridge: ${asBridgeError(error).message}`); process.exit(2); }
  if (values.check) {
    const result = await status(config);
    console.log(JSON.stringify({ version: VERSION, ...result, hermes: hermesCommands() }, null, 2));
    closeCodex(); closeNativeWorker();
    process.exit((result.codex as { ok?: boolean })?.ok ? 0 : 1);
  }
  const server = createServer(config);
  const stop = async () => { await server.close(); closeUiWorkers(); closeNativeWorker(); closeCodex(); process.exit(0); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  process.stdin.once('end', () => void stop());
  await server.connect(new StdioServerTransport());
}
