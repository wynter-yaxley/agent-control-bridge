import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { BridgeError, asBridgeError } from './errors.ts';
import { VERSION, refreshCodex, type BridgeConfig } from './config.ts';
import { latestCodexThread, type CodexOptions } from './codex.ts';
import { NativeClient } from './native.ts';

type Probe = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string; fix?: string };
const failed = (error: unknown, fix?: string): Probe => {
  const failure = asBridgeError(error), hint = typeof failure.details?.fix === 'string' ? failure.details.fix : fix;
  const extra = failure.details?.nativeError ? { nativeError: failure.details.nativeError } : failure.details?.stage ? { stage: failure.details.stage } : {};
  return { ok: false, code: failure.code, message: failure.message, ...extra, ...(hint ? { fix: hint } : {}) };
};
const started = new Date().toISOString();

export const codexOptions = (config: BridgeConfig): CodexOptions => {
  refreshCodex(config);
  if (!config.codexExecutable) throw new BridgeError('CONFIG', 'Codex was not found: install the Codex desktop app, or pass --codex <path to codex.exe> (or set ACB_CODEX)');
  return { executable: config.codexExecutable, timeoutMs: config.timeoutMs, pollMs: 3000 };
};

/** The Native IPC caller context: the configured thread, else the most recent Codex thread. */
export async function carrierThread(config: BridgeConfig): Promise<string> {
  if (config.carrierThreadId) return config.carrierThreadId;
  const id = await latestCodexThread(codexOptions(config));
  if (!id) throw new BridgeError('CONFIG', 'No Codex conversation exists yet to use as the desktop context: start one in Codex once, or set carrierThreadId');
  return (config.carrierThreadId = id);
}

/** Read-only readiness check (no window, keyboard or conversation is touched). */
export async function status(config: BridgeConfig): Promise<Record<string, unknown>> {
  // The process identity tells a stale long-running server apart from a fresh one.
  const result: Record<string, unknown> = { version: VERSION, server: { pid: process.pid, startedAt: started }, platform: process.platform, node: process.version, timeoutMs: config.timeoutMs, workspaceRoot: config.workspaceRoot, foregroundInput: config.foregroundInput };
  let carrier: string | null = null;
  // codex.exe is checked even when the carrier thread is configured; that thread alone
  // still lets the native inventory be checked without Codex.
  try { codexOptions(config); carrier = await carrierThread(config); result.codex = { ok: true, path: config.codexExecutable, source: config.codexSource, carrierThread: carrier }; }
  catch (error) { result.codex = failed(error, 'Codex tools need the Codex desktop app (or --codex); GPT tools also need one Codex conversation as context'); carrier = config.carrierThreadId; }
  if (process.platform !== 'win32') { result.chatgpt = { ok: false, code: 'UNSUPPORTED', message: 'ChatGPT desktop tools run only on Windows' }; return result; }
  const tasks = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  result.chatgpt = /"ChatGPT\.exe"/i.test(tasks.stdout ?? '') ? { ok: true, running: true } : { ok: false, code: 'OWNER', message: 'The ChatGPT desktop app is not running', fix: 'Start ChatGPT and sign in' };
  // Pipe names only (no connection): which desktop IPC generation is running.
  let pipes: Record<string, number> | undefined;
  try { const names = readdirSync('\\\\.\\pipe\\'); pipes = { appTools: names.filter(name => /^codex-app-tools-[a-f0-9-]+$/.test(name)).length, browserUse: names.filter(name => /^codex-browser-use-[a-f0-9-]+$/.test(name)).length }; } catch { /* not listable */ }
  if (carrier) {
    const native = new NativeClient({ carrierThreadId: carrier, ...config.nativeInterface });
    try {
      const inventory = await native.inventory(), peer = native.peer;
      result.nativeIpc = { ok: true, recentThreads: inventory.threads.length, ...(inventory.unavailableSources.length ? { unavailableSources: inventory.unavailableSources } : {}), host: { appVersion: peer?.appVersion ?? null, pipe: peer?.pipe ?? null }, ...(pipes ? { pipes } : {}) };
    } catch (error) {
      // A host that was verified and then refused is the case that needs its version.
      const peer = native.peer;
      result.nativeIpc = { ...failed(error, pipes && !pipes.appTools && !pipes.browserUse ? 'Start the ChatGPT/Codex desktop app in the same Windows session (it hosts the conversation inventory)'
        : 'The desktop app is running but refused the request: compare nativeError with the app version; if the app was just updated, update ACB'),
        host: peer ? { appVersion: peer.appVersion, pipe: peer.pipe } : null, ...(pipes ? { pipes } : {}) };
    }
  }
  if (!config.foregroundInput) result.note = 'Without --allow-foreground-input, GPT prompts are sent only when the identical text is already a draft in the composer';
  return result;
}
