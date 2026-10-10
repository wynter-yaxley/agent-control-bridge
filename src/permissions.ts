import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './errors.ts';
// Fixed OS-owned executable: PATH cannot substitute an identity/ACL helper.
// Nonstandard Windows installations fail closed instead of trusting env input.
export const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// Fail closed; no elevation and no shell argument interpolation.
export function protectPath(path: string, authorizedSids: readonly string[] = []): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Symlink paths are not supported');
  if (process.platform === 'win32') {
    try {
      // EncodedCommand permits fixed inline code under Restricted execution
      // policy without changing that policy. User values are base64 data.
      const script = readFileSync(fileURLToPath(new URL('./permissions.ps1', import.meta.url)), 'utf8');
      const data = Buffer.from(path).toString('base64');
      const sids = Buffer.from(authorizedSids.join(',')).toString('base64');
      // Decode data with .NET; no module auto-loading or account-name lookup.
      const command = `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')); $s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sids}')); & {${script}\n} -TargetPath $p -AdditionalSids $s`;
      execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const detail = error as { code?: string; stdout?: Buffer };
      const phases = detail.stdout?.toString().match(/ACB_ACL_PHASE:(?:entered|read|rules|apply|verify|done)/g);
      const phase = phases?.at(-1)?.slice('ACB_ACL_PHASE:'.length) ?? 'startup';
      throw new BridgeError(detail.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'AUTH', `Cannot restrict NTFS ACL; database access refused (phase=${phase})`);
    }
  } else chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
}
