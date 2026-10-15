import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
const workers = ['native-pipe-worker.ps1', 'windows-native-worker.ps1'];
// Windows PowerShell 5.1 reads a script without BOM as ANSI, and its Chinese control names stop matching.
for (const name of workers) if (!readFileSync(`src/${name}`).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { console.error(`src/${name} must be saved as UTF-8 with BOM`); process.exit(1); }
rmSync('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('dist', { recursive: true });
for (const name of workers) copyFileSync(`src/${name}`, `dist/${name}`);
