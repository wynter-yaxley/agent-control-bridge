#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig, type BridgeConfig } from './config.ts';
import { BridgeError, asBridgeError } from './errors.ts';
import { NativeClient, closeNativeWorker } from './native.ts';
import { WindowsNativeUi, closeUiWorkers } from './windows-ui.ts';
import { sendGpt } from './gpt.ts';
import { sendCodex } from './codex.ts';

/** Hermes-facing MCP server: forward one prompt to an existing ChatGPT or Codex
 * conversation and return its real reply. Sends run one at a time. */
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
  const id = z.string().min(1).max(200), prompt = z.string().min(1).max(65536);
  server.registerTool('acb_threads', { description: 'List recent native desktop conversations (id, kind codex/chatgpt, title).', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } },
    () => run(() => native().listThreads()));
  server.registerTool('acb_gpt_send', { description: 'Send a prompt to an existing ChatGPT conversation that is open in the ChatGPT desktop app, wait for and return its reply. A prompt that is already the latest turn is not resent; its reply is returned.', inputSchema: z.object({ conversationId: id, prompt }).strict() },
    args => run(() => sendGpt({ native: native(), ui, timeoutMs: config.timeoutMs, pollMs: Math.max(config.uiPollMs, 1000) }, args.conversationId, args.prompt)));
  server.registerTool('acb_codex_send', { description: 'Send a prompt to an existing Codex thread through codex app-server, wait for and return its final reply. Command/file approvals are declined. A prompt that is already the latest turn is not resent.', inputSchema: z.object({ threadId: id, prompt }).strict() },
    args => run(() => {
      if (!config.codexExecutable) throw new BridgeError('CONFIG', 'codexExecutable is required');
      return sendCodex({ executable: config.codexExecutable, timeoutMs: config.timeoutMs, pollMs: 3000 }, args.threadId, args.prompt);
    }));
  return server;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'carrier-thread': { type: 'string' }, codex: { type: 'string' } }, strict: true });
  const config = loadConfig(values.config, { carrierThreadId: values['carrier-thread'], codexExecutable: values.codex });
  const server = createServer(config);
  const stop = async () => { await server.close(); closeUiWorkers(); closeNativeWorker(); process.exit(0); };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  await server.connect(new StdioServerTransport());
}
