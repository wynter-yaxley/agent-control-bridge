#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Desktop, UUID } from './desktop.ts';
import { WindowsHelper } from './helper.ts';
import { findPipe, pipeTransport } from './pipe.ts';
import { createServer } from './server.ts';

const HELP = `Usage: agent-control-bridge [--caller <threadId>] [--timeout <seconds>]

MCP server (stdio) for the ChatGPT desktop app on Windows.

  --caller <threadId>   Codex conversation named as caller of the app's tools
                        (default: the most recent one; env ACB_CALLER)
  --timeout <seconds>   How long a send waits for the reply (default 240; env ACB_TIMEOUT)
  --version             Print the version
  --help                Print this help`;

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function options() {
  const { values } = parseArgs({
    options: {
      caller: { type: 'string' },
      timeout: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
      // Accepted for configurations of version 0.5 and earlier; typing is no longer used.
      'allow-foreground-input': { type: 'boolean' },
    },
  });
  if (values.help) exit(HELP, 0);
  if (values.version) exit(version, 0);
  const caller = values.caller ?? process.env.ACB_CALLER;
  if (caller !== undefined && !UUID.test(caller)) exit('--caller must be a Codex conversation ID', 2);
  const seconds = Number(values.timeout ?? process.env.ACB_TIMEOUT ?? 240);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) exit('--timeout must be 10-3600 seconds', 2);
  return { caller, timeoutMs: seconds * 1000 };
}

function exit(message: string, code: number): never {
  (code ? process.stderr : process.stdout).write(`${message}\n`);
  process.exit(code);
}

const { caller, timeoutMs } = options();
const helper = new WindowsHelper();
const app = new Desktop({ caller, transport: pipeTransport(() => findPipe((path) => helper.isAppPipe(path))) });
const server = createServer({ app, page: helper, version, timeoutMs });
// Start the helper while the client is still connecting.
server.server.oninitialized = () => helper.warm();
const stop = () => {
  helper.close();
  process.exit(0);
};
process.stdin.once('end', stop);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await server.connect(new StdioServerTransport());
