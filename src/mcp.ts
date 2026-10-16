#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig, type BridgeConfig } from './config.ts';
import { asBridgeError } from './errors.ts';
import { NativeClient, closeNativeWorker } from './native.ts';
import { WindowsNativeUi, closeUiWorkers } from './windows-ui.ts';
import { createGpt, openGpt, sendGpt, type GptDeps } from './gpt.ts';
import { closeCodex, createCodex, searchCodex, sendCodex } from './codex.ts';
import { createWorkspace } from './workspace.ts';
import { carrierThread, codexOptions, status } from './check.ts';

export const VERSION = '0.4.0';
const INSTRUCTIONS = 'Agent Control Bridge connects you to the ChatGPT and Codex desktop apps. Reuse existing projects and conversations (acb_threads, acb_codex_find) before creating new ones. ChatGPT analyses, plans and reviews; Codex writes code, runs commands, edits files and tests; you forward prompts and report progress. Do not redo Codex work yourself or write scripts around these tools. On failure, report the error code and fix; do not retry a send blindly (a repeated prompt is never resent, it returns the pending reply).';

/** Hermes-facing MCP server: workspaces and Codex projects, GPT/Codex conversations,
 * locating a target, sending one prompt and returning the real reply. One call at a time. */
export function createServer(config: BridgeConfig): McpServer {
  const server = new McpServer({ name: 'agent-control-bridge', version: VERSION }, { instructions: INSTRUCTIONS });
  const ui = new WindowsNativeUi(config);
  const native = async () => new NativeClient({ carrierThreadId: await carrierThread(config), ...config.nativeInterface });
  let queue: Promise<unknown> = Promise.resolve();
  const run = (operation: () => Promise<unknown>) => {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending.then(value => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] }),
      error => { const failure = asBridgeError(error); return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, code: failure.code, message: failure.message, ...failure.details }) }], isError: true }; });
  };
  const id = z.string().min(1).max(200), prompt = z.string().min(1).max(65536), title = z.string().min(1).max(200);
  const gpt = async (): Promise<GptDeps> => ({ native: await native(), ui, timeoutMs: config.timeoutMs, pollMs: Math.max(config.uiPollMs, 1000) });
  const read = { readOnlyHint: true, openWorldHint: false } as const;
  server.registerTool('acb_status', { description: 'Read-only readiness check: Codex found, desktop context, ChatGPT running, foreground input authorized. Use only when a tool fails or before first use.', inputSchema: z.object({}).strict(), annotations: read },
    () => run(() => status(config)));
  server.registerTool('acb_threads', { description: 'List recent desktop conversations (id, kind codex/chatgpt, title, projectId, cwd). Use it to reuse an existing conversation.', inputSchema: z.object({}).strict(), annotations: read },
    () => run(async () => (await native()).listThreads()));
  server.registerTool('acb_projects', { description: 'List desktop projects (projectId, projectKind, label, path).', inputSchema: z.object({}).strict(), annotations: read },
    () => run(async () => (await native()).listProjects()));
  server.registerTool('acb_workspace_create', { description: 'Create a local workspace directory (path, or workspaceRoot/name) and register it as a Codex project. Repeating it for the same directory returns the same project. Background, no window.', inputSchema: z.object({ name: z.string().min(1).max(100), path: z.string().min(1).max(260).optional() }).strict(), annotations: { idempotentHint: true } },
    args => run(() => createWorkspace({ ...codexOptions(config), root: config.workspaceRoot }, args.name, args.path)));
  server.registerTool('acb_codex_create', { description: 'Create a named Codex conversation in a workspace directory; its first prompt is sent and answered so it is saved. Background, no window.', inputSchema: z.object({ cwd: z.string().min(1).max(260), title, prompt: prompt.optional() }).strict() },
    args => run(() => createCodex(codexOptions(config), args.cwd, args.title, args.prompt)));
  server.registerTool('acb_codex_find', { description: 'Full-text search of Codex conversations; returns thread IDs. Background, read-only.', inputSchema: z.object({ searchTerm: z.string().min(1).max(200) }).strict(), annotations: read },
    args => run(() => searchCodex(codexOptions(config), args.searchTerm)));
  server.registerTool('acb_codex_send', { description: 'Send a prompt to a Codex conversation by ID and return its final reply. Background, no window. Archived conversations are unarchived once; approvals are never granted by the bridge. If it times out, call again with the same prompt to read the reply (it is not resent).', inputSchema: z.object({ threadId: id, prompt }).strict() },
    args => run(() => sendCodex(codexOptions(config), args.threadId, args.prompt)));
  server.registerTool('acb_gpt_create', { description: 'Create a ChatGPT conversation from the left sidebar, identify its one-time marker, and verify its title and persistence before returning its ID. With --allow-foreground-input, restores/activates the verified ChatGPT window once; stops if focus changes. A partial error includes the known ID: do not create again or resend the marker.', inputSchema: z.object({ title, project: z.string().min(1).max(200).optional() }).strict() },
    async args => run(async () => createGpt(await gpt(), args.title, args.project)));
  server.registerTool('acb_gpt_open', { description: 'Show a ChatGPT conversation by ID in the desktop app (current view or its single sidebar entry) and confirm it is the one shown. Uses the ChatGPT window (UIA click), no typing.', inputSchema: z.object({ conversationId: id }).strict() },
    args => run(async () => { const deps = await gpt(), page = await deps.native.readThread(args.conversationId); return { conversationId: args.conversationId, title: page.thread.title, navigation: await openGpt(deps, args.conversationId, page.thread.title) }; }));
  server.registerTool('acb_gpt_send', { description: 'Send a prompt to a ChatGPT conversation by ID and return its reply. With --allow-foreground-input, restores/activates the verified ChatGPT window once, verifies actual foreground and composer focus, and stops if the user switches away. Without authorization, only an identical existing draft can be sent while ChatGPT is in front. An already-latest prompt is not resent.', inputSchema: z.object({ conversationId: id, prompt }).strict() },
    args => run(async () => sendGpt(await gpt(), args.conversationId, args.prompt)));
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
