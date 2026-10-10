import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = fileURLToPath(new URL('../test/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort().map(name => join(directory, name));
if (!files.length) { console.error('No test files discovered'); process.exitCode = 1; }
else {
  console.log(`Discovered ${files.length} test files`);
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  const count = /# tests (\d+)/.exec(result.stdout ?? '');
  process.exitCode = result.status === 0 && count && Number(count[1]) > 0 ? 0 : 1;
  if (!count || Number(count[1]) === 0) console.error('Test runner did not execute any tests');
}
