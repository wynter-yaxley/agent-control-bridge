import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BridgeError } from './errors.ts';

export interface BridgeConfig {
  /** Reply wait for one send (UIA worker and Codex turn). */
  timeoutMs: number;
  uiPollMs: number;
  /** An existing Codex thread used as the Native IPC caller context. */
  carrierThreadId: string | null;
  codexExecutable: string | null;
  /** Default parent directory for new workspaces. */
  workspaceRoot: string | null;
  /** The user's authorization for foreground SendInput typing into ChatGPT. */
  foregroundInput: boolean;
  nativeInterface: { timeoutMs: number; maxFrameBytes: number; maxCandidates: number };
}
const int = (value: unknown, fallback: number, min: number, max: number, field: string) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new BridgeError('CONFIG', `${field} must be an integer ${min}..${max}`);
  return Number(value);
};
const text = (value: unknown, field: string) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new BridgeError('CONFIG', `${field} must be a nonempty string`);
  return value;
};
/** Reads only the fields it uses; older configuration files keep working (other keys are ignored). */
export function loadConfig(path?: string, overrides: { carrierThreadId?: string; codexExecutable?: string; foregroundInput?: boolean } = {}): BridgeConfig {
  let raw: Record<string, any> = {};
  if (path) {
    const file = resolve(path);
    if (!existsSync(file)) throw new BridgeError('CONFIG', 'Configuration file does not exist');
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new BridgeError('CONFIG', 'Configuration JSON is invalid'); }
  }
  const native = raw.nativeInterface ?? {};
  return {
    timeoutMs: int(raw.timeoutMs ?? raw.background?.timeoutMs, 300000, 10000, 600000, 'timeoutMs'),
    uiPollMs: int(raw.uiPollMs ?? raw.desktop?.uiPollMs, 1000, 1, 10000, 'uiPollMs'),
    carrierThreadId: text(overrides.carrierThreadId ?? raw.carrierThreadId, 'carrierThreadId'),
    codexExecutable: text(overrides.codexExecutable ?? raw.codexExecutable ?? raw.agents?.codex?.executable, 'codexExecutable'),
    workspaceRoot: text(raw.workspaceRoot, 'workspaceRoot'),
    foregroundInput: overrides.foregroundInput === true || raw.foregroundInput === true,
    nativeInterface: { timeoutMs: int(native.timeoutMs, 30000, 1, 60000, 'nativeInterface.timeoutMs'), maxFrameBytes: int(native.maxFrameBytes, 2097152, 4096, 4194304, 'nativeInterface.maxFrameBytes'),
      maxCandidates: int(native.maxCandidates, 16, 1, 32, 'nativeInterface.maxCandidates') },
  };
}
