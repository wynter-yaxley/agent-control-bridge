// Compiles src/ to dist/ and copies the PowerShell window helper next to it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';

// Windows PowerShell 5.1 reads a script without a byte order mark as ANSI, which breaks
// the Chinese control names in it.
if (
  !readFileSync('src/window.ps1')
    .subarray(0, 3)
    .equals(Buffer.from([0xef, 0xbb, 0xbf]))
) {
  console.error('src/window.ps1 must be saved as UTF-8 with BOM');
  process.exit(1);
}
rmSync('dist', { recursive: true, force: true });
const tsc = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
copyFileSync('src/window.ps1', 'dist/window.ps1');
