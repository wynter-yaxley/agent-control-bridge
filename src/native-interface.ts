#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { checkNativeDesktop, NativeInterfaceError } from './native-readonly.ts';
import { classifyError } from './errors.ts';
import { BridgeError } from './errors.ts';
import { checkNativeProvisioningCapabilities } from './native-capabilities.ts';

try {
  const args = parseArgs({ options: { config: { type: 'string' }, carrier: { type: 'string' }, conversation: { type: 'string' }, title: { type: 'string' }, 'provisioning-capabilities': { type: 'boolean' }, project: { type: 'string' }, workspace: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (args.values.help) process.stdout.write('Read-only Windows desktop native interface check. No message send, login, browser, project creation or model turn.\n--config <file> --carrier <existing Codex task ID> [--conversation <existing GPT ID>] [--title <expected title>]\n--provisioning-capabilities [--project <native project ID> --workspace <absolute Windows path> --name <exact project name>]\nEvidence is diagnostic only; it cannot authorize execution or identify an ordinary GPT generation.\n');
  else {
    const config = loadConfig({ configPath: args.values.config });
    const values = args.values, projectArgs = [values.project, values.workspace, values.name];
    if (projectArgs.some(value => value !== undefined) && (!values['provisioning-capabilities'] || !projectArgs.every(value => value !== undefined)) ||
        values['provisioning-capabilities'] && (values.conversation !== undefined || values.title !== undefined)) throw new BridgeError('INPUT', 'Use one diagnostic mode and supply all native project expectations');
    const options = { carrierThreadId: values.carrier ?? '', ...config.nativeInterface };
    const result = values['provisioning-capabilities'] ? await checkNativeProvisioningCapabilities({ ...options,
      expectedProject: values.project !== undefined ? { appProjectId: values.project, workspacePath: values.workspace!, name: values.name! } : undefined }) :
      await checkNativeDesktop({ ...options, conversationId: values.conversation, expectedTitle: values.title });
    process.stdout.write(JSON.stringify(result) + '\n');
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: classifyError(error).code, ...(error instanceof NativeInterfaceError ? { stage: error.stage } : {}), readOnly: true, privateDiagnosticsOmitted: true }) + '\n'); process.exitCode = 1;
}
