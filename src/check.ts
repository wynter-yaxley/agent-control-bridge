import { spawnSync } from 'node:child_process';
import { BridgeError, asBridgeError } from './errors.ts';
import type { BridgeConfig } from './config.ts';
import { latestCodexThread, type CodexOptions } from './codex.ts';
import { NativeClient } from './native.ts';

type Probe = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string; fix?: string };
const failed = (error: unknown, fix?: string): Probe => { const failure = asBridgeError(error); return { ok: false, code: failure.code, message: failure.message, ...(fix ? { fix } : {}) }; };

export const codexOptions = (config: BridgeConfig): CodexOptions => {
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
  const result: Record<string, unknown> = { platform: process.platform, node: process.version, timeoutMs: config.timeoutMs, workspaceRoot: config.workspaceRoot, foregroundInput: config.foregroundInput };
  let carrier: string | null = null;
  try { carrier = await carrierThread(config); result.codex = { ok: true, path: config.codexExecutable, source: config.codexSource, carrierThread: carrier }; }
  catch (error) { result.codex = failed(error, 'Codex tools need the Codex desktop app (or --codex); GPT tools also need one Codex conversation as context'); }
  if (process.platform !== 'win32') { result.chatgpt = { ok: false, code: 'UNSUPPORTED', message: 'ChatGPT desktop tools run only on Windows' }; return result; }
  const tasks = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  result.chatgpt = /"ChatGPT\.exe"/i.test(tasks.stdout ?? '') ? { ok: true, running: true } : { ok: false, code: 'OWNER', message: 'The ChatGPT desktop app is not running', fix: 'Start ChatGPT and sign in' };
  if (carrier) {
    try { const threads = await new NativeClient({ carrierThreadId: carrier, ...config.nativeInterface }).listThreads(); result.nativeIpc = { ok: true, recentThreads: threads.length }; }
    catch (error) { result.nativeIpc = failed(error, 'Start the Codex desktop app in the same Windows session (it hosts the conversation inventory)'); }
  }
  if (!config.foregroundInput) result.note = 'Without --allow-foreground-input, GPT prompts are sent only when the identical text is already a draft in the composer';
  return result;
}
