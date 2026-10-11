import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { checkCodexProvisioning } from '../src/codex-app-server.ts';
try {
  const args = parseArgs({ options: { config: { type: 'string' }, executable: { type: 'string' }, 'name-dormant-threads': { type: 'boolean' }, 'skip-listings': { type: 'boolean' }, help: { type: 'boolean' } }, strict: true });
  if (args.values.help) process.stdout.write('Isolated Codex creation/model/effort diagnostic. No desktop writes, login, inference or business database.\n--config <file> --executable <absolute codex path> [--name-dormant-threads] [--skip-listings]\nSkipped listings yield PARTIAL, never a passed full check.\n');
  else {
    const config = loadConfig({ configPath: args.values.config });
    const result = await checkCodexProvisioning({ executable: args.values.executable ?? config.agents.codex.executable ?? '', timeoutMs: config.nativeInterface.timeoutMs, nameDormantThreads: args.values['name-dormant-threads'], skipListings: args.values['skip-listings'] });
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1;
  }
} catch { process.stderr.write('{"ok":false,"code":"CONFIG","privateDiagnosticsOmitted":true}\n'); process.exitCode = 2; }
