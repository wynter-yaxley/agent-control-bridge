import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { checkCodexProjectProvisioning } from '../src/codex-app-server.ts';
try {
  const args = parseArgs({ options: { config: { type: 'string' }, executable: { type: 'string' }, 'identity-only': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (args.values.help) process.stdout.write('Isolated experimental project/create, project membership, exact naming and persistence check. No inference, desktop writes or credentials.\n--config <file> --executable <absolute Codex path> [--identity-only]\nIdentity-only skips inventories and returns PARTIAL. A passed check does not prove native desktop registration or ordinary GPT creation.\n');
  else {
    const config = loadConfig({ configPath: args.values.config });
    const result = await checkCodexProjectProvisioning({ executable: args.values.executable ?? config.agents.codex.executable ?? '', timeoutMs: config.nativeInterface.timeoutMs, includeListings: args.values['identity-only'] ? false : undefined });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
  }
} catch { process.stderr.write('{"ok":false,"code":"CONFIG","privateDiagnosticsOmitted":true}\n'); process.exitCode = 2; }
