#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { inspectCodexThread } from './codex-app-server.ts';
import { withDeadline } from './deadline.ts';
import { classifyError } from './errors.ts';

try {
  const args = parseArgs({ options: { config: { type: 'string' }, executable: { type: 'string' }, conversation: { type: 'string' }, workspace: { type: 'string' }, project: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (args.values.help) process.stdout.write('Read-only official Codex app-server interface check. No resume, thread creation, login or model turn.\n--config <file> --executable <codex path> --conversation <thread ID> [--workspace <path>] [--project <native project ID>]\nExpected values are diagnostic comparisons, not execution authorization.\n');
  else {
    const config = loadConfig({ configPath: args.values.config });
    const actual = await withDeadline(signal => inspectCodexThread({ executable: args.values.executable ?? config.agents.codex.executable ?? '', timeoutMs: config.watcher.timeoutMs, conversationId: args.values.conversation ?? '', signal }), config.watcher.timeoutMs);
    const workspaceMatches = args.values.workspace === undefined ? null : process.platform === 'win32' ? resolve(actual.workspacePath).toLowerCase() === resolve(args.values.workspace).toLowerCase() : resolve(actual.workspacePath) === resolve(args.values.workspace);
    process.stdout.write(JSON.stringify({ ok: true, readOnly: true, conversationMatches: actual.conversationId === args.values.conversation, workspaceMatches, local: actual.local, threadStatus: actual.status,
      canonicalProjectStatus: actual.appProjectId === null ? 'UNAVAILABLE' : args.values.project === undefined ? 'NOT_COMPARED' : actual.appProjectId === args.values.project ? 'MATCH' : 'MISMATCH',
      executionAuthorized: false, nativeHostAcceptanceRequired: true, realModelInvoked: false, ordinaryChatVerified: false }) + '\n');
  }
} catch (error) {
  const failure = classifyError(error);
  process.stderr.write(JSON.stringify({ ok: false, code: failure.code, privateDiagnosticsOmitted: true }) + '\n'); process.exitCode = 1;
}
