import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { EXECUTORS, type Executor } from './types.ts';
import { WINDOWS_POWERSHELL } from './permissions.ts';
import { BridgeError } from './errors.ts';

export interface CallerIdentity {
  readonly principal: string;
  readonly instance: string;
  readonly executor: Executor | null;
  readonly reviewer: boolean;
  readonly controller?: boolean;
}
declare const callerBrand: unique symbol;
export type CallerContext = Readonly<{ [callerBrand]: true }>;

// The trusted host owns the authority. Contexts from JSON or another authority
// cannot authorize this store. Arbitrary code inside this host is trusted code.
export class CallerAuthority {
  #contexts = new WeakMap<object, Readonly<CallerIdentity>>();
  issue(identity: CallerIdentity): CallerContext {
    if (typeof identity.principal !== 'string' || !identity.principal || typeof identity.instance !== 'string' || !identity.instance ||
        (identity.executor !== null && !EXECUTORS.includes(identity.executor)) ||
        typeof identity.reviewer !== 'boolean' ||
        (identity.controller !== undefined && typeof identity.controller !== 'boolean')) throw new Error('Invalid trusted caller identity');
    const handle = Object.freeze({}) as CallerContext;
    this.#contexts.set(handle, Object.freeze({ ...identity, controller: identity.controller ?? (identity.executor === 'hermes' && identity.reviewer) }));
    return handle;
  }
  resolve(context: unknown): Readonly<CallerIdentity> | null {
    return typeof context === 'object' && context !== null ? this.#contexts.get(context) ?? null : null;
  }
}

interface PolicyEntry { principal: string; instance: string; executor: Executor | null; reviewer: boolean; controller?: boolean }
export function currentPrincipal(): string {
  if (process.platform !== 'win32') return `uid:${process.getuid!()}`;
  let value: string;
  try { value = execFileSync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
  { timeout: 10_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new BridgeError('AUTH', 'Cannot establish OS caller identity'); }
  if (!/^S-1-\d+(?:-\d+)+$/.test(value)) throw new BridgeError('AUTH', 'Cannot establish OS caller identity');
  return value;
}

// Fixed policy path protected by the project ACL. CLI/env/Agent text never
// supplies a principal, instance or reviewer capability.
export function localCaller(authority: CallerAuthority, policyPath: string): { context: CallerContext; authorizedSids: string[] } {
  const principal = currentPrincipal();
  if (!existsSync(policyPath)) return {
    context: authority.issue({ principal, instance: 'local-cli', executor: 'pi', reviewer: false }), authorizedSids: [],
  };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(policyPath, 'utf8')); }
  catch { throw new BridgeError('AUTH', 'Caller policy is unreadable or invalid'); }
  if (!Array.isArray(raw)) throw new BridgeError('AUTH', 'Invalid caller policy');
  const entries: PolicyEntry[] = raw.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new BridgeError('AUTH', 'Invalid caller policy entry');
    const item = entry as Record<string, unknown>;
    if (typeof item.principal !== 'string' || typeof item.instance !== 'string' || !item.instance ||
        typeof item.reviewer !== 'boolean' ||
        (item.controller !== undefined && typeof item.controller !== 'boolean') ||
        (item.executor !== null && !EXECUTORS.includes(item.executor as Executor)) ||
        (process.platform === 'win32' && (!/^S-1-\d+(?:-\d+)+$/.test(item.principal) ||
          ['S-1-1-0','S-1-5-11','S-1-5-32-545'].includes(item.principal)))) throw new BridgeError('AUTH', 'Invalid caller policy entry');
    return item as unknown as PolicyEntry;
  });
  if (new Set(entries.map(e => e.principal)).size !== entries.length) throw new BridgeError('AUTH', 'Duplicate policy principal');
  const caller = entries.find(e => e.principal === principal);
  if (!caller) throw new BridgeError('AUTH', 'OS caller is not authorized by deployment policy');
  return { context: authority.issue(caller), authorizedSids: process.platform === 'win32' ? entries.map(e => e.principal) : [] };
}
