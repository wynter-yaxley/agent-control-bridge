import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import type { BridgeConfig } from './config.ts';
import { BridgeError, EXIT_CODES, type ErrorCode } from './errors.ts';
import { controlledProcessEnv } from './silent-process.ts';
import { redact } from './security.ts';

export interface VisibleGptSnapshot {
  source: 'visible-dom' | 'windows-uia';
  conversationId: string | null;
  identityStatus?: 'identityVerified' | 'titleOnly' | 'unavailable';
  browserTitle: string;
  reason?: string;
  kind: 'unknown';
  completionVerified: boolean;
  actualModel: null;
  actualReasoningEffort: null;
  responseInProgress: boolean;
  messages: { role: string; text: string; sourceMessageId: string | null; hash: string; complete?: boolean }[];
}
export type DesktopGptReader = (conversationId: string) => Promise<VisibleGptSnapshot>;

/** Fixed read-only worker. It neither creates a WebView nor navigates one. */
export function createDesktopGptReader(config: BridgeConfig, configPath: string): DesktopGptReader {
  return async conversationId => {
    if (!config.desktop.enabled) throw new BridgeError('UNSUPPORTED', 'Current-instance desktop reading is disabled');
    const worker = fileURLToPath(new URL('../tools/desktop/gpt_read_cdp.py', import.meta.url));
    const stdout = await new Promise<string>((resolveRead, reject) => {
      execFile(config.desktop.python, [worker, '--config', resolve(configPath), '--endpoint', config.desktop.cdpUrl, '--conversation', conversationId, '--json'],
        { timeout: config.background.timeoutMs, maxBuffer: 1048576, windowsHide: true, env: controlledProcessEnv(), encoding: 'utf8' }, (error, stdout, stderr) => {
          if (!error) { resolveRead(stdout); return; }
          let diagnostic: { code: string; error: string };
          // Exit 4 reports zero matched message selectors on stdout; it is not a transport failure.
          try { if ((JSON.parse(stdout) as { status?: string }).status === 'unverified') { reject(new BridgeError('PROVENANCE', 'Visible GPT message selectors matched nothing; body is unverified')); return; } }
          catch { /* Structured failures are reported on stderr. */ }
          try { diagnostic = JSON.parse(stderr); }
          catch { reject(new BridgeError(error.code === 'ENOENT' ? 'DEPENDENCY' : error.killed ? 'TIMEOUT' : 'IO', 'Read-only GPT worker failed without a structured result')); return; }
          const code = diagnostic.code === 'CDP_UNAVAILABLE' ? 'UNSUPPORTED' : Object.hasOwn(EXIT_CODES, diagnostic.code) ? diagnostic.code as ErrorCode : 'IO';
          reject(new BridgeError(code, redact(diagnostic.error)));
        });
    });
    const snapshot = JSON.parse(stdout) as VisibleGptSnapshot;
    if (snapshot.source !== 'visible-dom' || snapshot.conversationId !== conversationId) throw new BridgeError('PROVENANCE', 'Visible GPT snapshot identity differs');
    return {...snapshot,identityStatus:'identityVerified'};
  };
}
