import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The test owns a unique temporary fixture root; no live Agents or production DB.
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test',
  fileURLToPath(new URL('../test/e2e.test.ts', import.meta.url))], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
