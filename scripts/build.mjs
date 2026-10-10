import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('dist', { recursive: true });
for (const name of ['schema.sql', 'permissions.ps1']) copyFileSync(`src/${name}`, `dist/${name}`);
