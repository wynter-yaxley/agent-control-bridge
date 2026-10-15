import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BridgeError } from './errors.ts';

export interface BridgeConfig {
  /** Reply wait for one send (UIA worker and Codex turn); below Hermes' 300 s tool timeout. */
  timeoutMs: number;
  uiPollMs: number;
  /** An existing Codex thread used as the Native IPC caller context; found automatically when null. */
  carrierThreadId: string | null;
  codexExecutable: string | null;
  /** Where codexExecutable came from: option, env, config, desktop app or PATH. */
  codexSource: string | null;
  /** Default parent directory for new workspaces. */
  workspaceRoot: string;
  /** The user's authorization for foreground SendInput typing into ChatGPT. */
  foregroundInput: boolean;
  /** Forward UIA stage lines to stderr (ACB_DEBUG=1). */
  debug: boolean;
  nativeInterface: { timeoutMs: number; maxFrameBytes: number; maxCandidates: number };
}
type Env = Record<string, string | undefined>;
const int = (value: unknown, fallback: number, min: number, max: number, field: string) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new BridgeError('CONFIG', `${field} must be an integer ${min}..${max}`);
  return Number(value);
};
const text = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new BridgeError('CONFIG', `${field} must be a nonempty string`);
  return value;
};

/** The Codex desktop app's bundled codex.exe (newest version folder), else codex on PATH. */
export function findCodex(env: Env = process.env, platform: string = process.platform): { path: string; source: string } | null {
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const bin = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const newest = readdirSync(bin).map(name => join(bin, name, 'codex.exe')).filter(file => existsSync(file))
        .map(file => ({ file, time: statSync(file).mtimeMs })).sort((a, b) => b.time - a.time)[0];
      if (newest) return { path: newest.file, source: 'desktop' };
    } catch { /* no desktop install */ }
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':')) {
    const file = dir && join(dir, platform === 'win32' ? 'codex.exe' : 'codex');
    if (file && existsSync(file)) return { path: file, source: 'PATH' };
  }
  return null;
}

/** Options, then ACB_* environment variables, then the optional JSON file, then discovery
 * and defaults. Older configuration files keep working (unknown keys are ignored). */
export function loadConfig(path?: string, overrides: { carrierThreadId?: string; codexExecutable?: string; foregroundInput?: boolean; debug?: boolean } = {}, env: Env = process.env): BridgeConfig {
  let raw: Record<string, any> = {};
  const file = path ?? text(env.ACB_CONFIG, 'ACB_CONFIG');
  if (file) {
    if (!existsSync(resolve(file))) throw new BridgeError('CONFIG', `Configuration file does not exist: ${file}`);
    try { raw = JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^﻿/, '')); } catch { throw new BridgeError('CONFIG', 'Configuration JSON is invalid'); }
  }
  const native = raw.nativeInterface ?? {};
  const given = ([['option', overrides.codexExecutable], ['env', env.ACB_CODEX], ['config', raw.codexExecutable ?? raw.agents?.codex?.executable]] as [string, unknown][]).find(([, value]) => value);
  const codex = given ? { path: text(given[1], 'codexExecutable')!, source: given[0] } : findCodex(env);
  return {
    timeoutMs: int(raw.timeoutMs ?? raw.background?.timeoutMs, 240000, 10000, 600000, 'timeoutMs'),
    uiPollMs: int(raw.uiPollMs ?? raw.desktop?.uiPollMs, 1000, 1, 10000, 'uiPollMs'),
    carrierThreadId: text(overrides.carrierThreadId ?? env.ACB_CARRIER_THREAD ?? raw.carrierThreadId, 'carrierThreadId'),
    codexExecutable: codex?.path ?? null,
    codexSource: codex?.source ?? null,
    workspaceRoot: text(env.ACB_WORKSPACE_ROOT ?? raw.workspaceRoot, 'workspaceRoot') ?? resolve(homedir(), 'acb-workspaces'),
    foregroundInput: overrides.foregroundInput === true || raw.foregroundInput === true || env.ACB_ALLOW_FOREGROUND_INPUT === '1',
    debug: overrides.debug === true || env.ACB_DEBUG === '1',
    nativeInterface: { timeoutMs: int(native.timeoutMs, 30000, 1, 60000, 'nativeInterface.timeoutMs'), maxFrameBytes: int(native.maxFrameBytes, 2097152, 4096, 4194304, 'nativeInterface.maxFrameBytes'),
      maxCandidates: int(native.maxCandidates, 32, 1, 32, 'nativeInterface.maxCandidates') },
  };
}
