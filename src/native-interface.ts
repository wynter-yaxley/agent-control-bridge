#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { checkNativeDesktop, NativeInterfaceError, closeNativeReadWorker } from './native-readonly.ts';
import { classifyError } from './errors.ts';
import { BridgeError } from './errors.ts';

try {
  const args = parseArgs({ options: { config: { type: 'string' }, carrier: { type: 'string' }, conversation: { type: 'string' }, title: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (args.values.help) process.stdout.write('Read-only Windows desktop native interface check. No message send, login, browser, project creation or model turn.\n--config <file> --carrier <existing Codex task ID> [--conversation <existing GPT ID>] [--title <expected title>]\nEvidence is diagnostic only; it cannot authorize execution or identify an ordinary GPT generation.\n');
  else {
    const config = loadConfig({ configPath: args.values.config });
    const values = args.values;
    const result = await checkNativeDesktop({ carrierThreadId: values.carrier ?? '', ...config.nativeInterface,
      conversationId: values.conversation, expectedTitle: values.title });
    process.stdout.write(JSON.stringify(result) + '\n');
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: classifyError(error).code, ...(error instanceof NativeInterfaceError ? { stage: error.stage } : {}), readOnly: true, privateDiagnosticsOmitted: true }) + '\n'); process.exitCode = 1;
} finally { closeNativeReadWorker(); }
