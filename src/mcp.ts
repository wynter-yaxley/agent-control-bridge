#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallerAuthority, localCaller } from './caller.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';
import { BackgroundBridge, type BackgroundHostBindings } from './background.ts';
import { createBridgeMcpServer } from './mcp-server.ts';
import { BridgeError, classifyError, EXIT_CODES } from './errors.ts';
import { createDesktopGptReader } from './desktop-gpt-reader.ts';
import { createWindowsNativeGptReader } from './windows-native-host.ts';
import { closeNativeReadWorker } from './native-readonly.ts';

// A trusted Hermes embedding can supply persistent host objects. This factory
// is executable host code, never a command-line/config/MCP argument.
export async function runMcp(args: string[], createHost?: (services: {config: ReturnType<typeof loadConfig>; authority: CallerAuthority; context: ReturnType<typeof localCaller>['context']}) => Promise<BackgroundHostBindings> | BackgroundHostBindings): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, options: { config: { type: 'string' }, db: { type: 'string' }, help: { type: 'boolean' } }, tokens: true, strict: true }); }
  catch { throw new BridgeError('INPUT', 'Invalid MCP startup arguments'); }
  const flags = parsed.tokens!.filter(token => token.kind === 'option').map(token => token.name);
  if (new Set(flags).size !== flags.length) throw new BridgeError('INPUT', 'Duplicate MCP startup arguments');
  if (parsed.values.help) { process.stdout.write('Agent Control Bridge MCP (stdio)\n--config <file> --db <file>\nIdentity: OS principal + protected config/caller-policy.json. No browser/profile or source-import tools.\n'); return; }
  const config = loadConfig({ configPath: parsed.values.config as string | undefined, dbPath: parsed.values.db as string | undefined });
  const authority = new CallerAuthority();
  const caller = localCaller(authority, fileURLToPath(new URL('../config/caller-policy.json', import.meta.url)));
  const db = createDb({ dbPath: config.database.path, busyTimeoutMs: config.database.busyTimeoutMs, authorizedSids: caller.authorizedSids });
  const host = createHost ? await createHost({config,authority,context:caller.context}) : {};
  const bridge = new BackgroundBridge(db, authority, caller.context, config, {
    gptReader: config.desktop.enabled ? createDesktopGptReader(config, parsed.values.config as string ?? process.env.ACB_CONFIG ?? '.bridge.config.json') : undefined,
    gptUiReader: config.desktop.enabled && process.platform==='win32' ? createWindowsNativeGptReader(config,process.env.CODEX_THREAD_ID) : undefined,
    ...host,
  }, code => process.stderr.write(`ACB ${code}\n`));
  let version: string;
  try { version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version; }
  catch { db.close(); throw new BridgeError('CONFIG', 'Package version is unavailable'); }
  const server = createBridgeMcpServer({ bridge, db, authority, context: caller.context, notificationLeaseMs: config.background.notificationLeaseMs, version });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await bridge.shutdown();
    await server.close(); closeNativeReadWorker(); db.close();
  };
  server.server.onclose = () => { void close(); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  try {
    await server.connect(new StdioServerTransport());
    if (authority.resolve(caller.context)?.controller) bridge.start();
  } catch (error) { await close(); throw error; }
}
if (import.meta.main) {
  void runMcp(process.argv.slice(2)).catch(error => { const failure = classifyError(error); process.stderr.write(`${failure.code}: ${failure.message}\n`); process.exitCode = EXIT_CODES[failure.code]; });
}
