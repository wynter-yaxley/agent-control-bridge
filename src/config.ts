import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { BridgeError } from './errors.ts';
import { readBounded, requireNoSecrets } from './security.ts';
export interface BridgeConfig {
  database: { path: string; busyTimeoutMs: number };
  watcher: { intervalMs: number; timeoutMs: number };
  nativeInterface: { timeoutMs: number; maxFrameBytes: number; maxCandidates: number };
  failureReporting: { blockedAfterMs: number };
  feishu: { apiOrigin: string; timeoutMs: number };
  background: { intervalMs: number; timeoutMs: number; leaseSeconds: number; workspaceRoot: string; maxConcurrent: number; notificationLeaseMs: number };
  agents: { chatgpt: { enabled: boolean; model: string; reasoningEffort: string }; codex: { enabled: boolean; statePath: string; executable: string | null }; hermes: { enabled: boolean; metadataPath: string | null }; pi: { enabled: boolean; locksPath: string | null } };
  desktop: { enabled: boolean; cdpUrl: string; remoteAllowOrigins: string; python: string; allowForegroundAutomation: boolean; allowPhysicalInput: boolean; uiPollMs: number };
  logging: { level: 'info' | 'warn' | 'error'; redactSecrets: true };
}
export function defaults(base = process.cwd()): BridgeConfig {
  return { database: { path: join(base, 'data', 'bridge.db'), busyTimeoutMs: 5000 }, watcher: { intervalMs: 60000, timeoutMs: 10000 }, failureReporting: {blockedAfterMs:600000},
    nativeInterface: { timeoutMs: 30000, maxFrameBytes: 2097152, maxCandidates: 16 },
    feishu: { apiOrigin: 'https://open.feishu.cn', timeoutMs: 15000 },
    background: { intervalMs: 60000, timeoutMs: 120000, leaseSeconds: 600, workspaceRoot: join(base, 'workspaces'), maxConcurrent: 1, notificationLeaseMs: 30000 },
    agents: { chatgpt: { enabled: false, model: 'gpt-6', reasoningEffort: 'high' }, codex: { enabled: false, statePath: join(homedir(), '.codex', '.codex-global-state.json'), executable: null }, hermes: { enabled: false, metadataPath: null }, pi: { enabled: false, locksPath: null } },
    desktop: { enabled: false, cdpUrl: 'http://127.0.0.1:9222', remoteAllowOrigins:'http://127.0.0.1:9222', python: 'python', allowForegroundAutomation: false, allowPhysicalInput: false, uiPollMs: 100 }, logging: { level: 'info', redactSecrets: true } };
}
function merge(target: Record<string, unknown>, source: unknown, prefix = ''): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new BridgeError('CONFIG', `Invalid configuration object ${prefix}`);
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) throw new BridgeError('CONFIG', `Unknown configuration field ${prefix}${key}`);
    const old = target[key];
    if (old !== null && typeof old === 'object') merge(old as Record<string, unknown>, value, `${prefix}${key}.`);
    else target[key] = value;
  }
}
export function loadConfig(options: { configPath?: string; dbPath?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): BridgeConfig {
  const cwd = resolve(options.cwd ?? process.cwd()), env = options.env ?? process.env;
  const path = resolve(cwd, options.configPath ?? env.ACB_CONFIG ?? '.bridge.config.json');
  const base = existsSync(path) ? dirname(path) : cwd;
  const config = defaults(base);
  if (options.configPath || env.ACB_CONFIG || existsSync(path)) {
    if (!existsSync(path)) throw new BridgeError('CONFIG', 'Configuration file does not exist');
    try { const text = readBounded(path, 65536); requireNoSecrets(text); merge(config as unknown as Record<string, unknown>, JSON.parse(text)); }
    catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('CONFIG', 'Configuration JSON is invalid'); }
  }
  if (env.ACB_DB_PATH) config.database.path = resolve(cwd, env.ACB_DB_PATH);
  if (env.ACB_WATCH_INTERVAL_MS !== undefined) config.watcher.intervalMs = Number(env.ACB_WATCH_INTERVAL_MS);
  if (env.ACB_BLOCKED_REPORT_MS !== undefined) config.failureReporting.blockedAfterMs=Number(env.ACB_BLOCKED_REPORT_MS);
  if (env.ACB_CHATGPT_MODEL) config.agents.chatgpt.model = env.ACB_CHATGPT_MODEL;
  if (env.ACB_CHATGPT_REASONING) config.agents.chatgpt.reasoningEffort = env.ACB_CHATGPT_REASONING;
  if (env.ACB_CDP_URL) config.desktop.cdpUrl = env.ACB_CDP_URL;
  if (env.ACB_CODEX_HOME) config.agents.codex.statePath = resolve(cwd, env.ACB_CODEX_HOME, '.codex-global-state.json');
  if (options.dbPath) config.database.path = resolve(cwd, options.dbPath);
  const integer = (value: unknown, field: string, min: number, max: number) => {
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new BridgeError('CONFIG', `${field} must be an integer ${min}..${max}`);
  };
  integer(config.watcher.intervalMs, 'watcher.intervalMs', 1, 3600000);
  integer(config.watcher.timeoutMs, 'watcher.timeoutMs', 1, 300000);
  integer(config.nativeInterface.timeoutMs, 'nativeInterface.timeoutMs', 1, 60000);
  integer(config.nativeInterface.maxFrameBytes, 'nativeInterface.maxFrameBytes', 4096, 4194304);
  integer(config.nativeInterface.maxCandidates, 'nativeInterface.maxCandidates', 1, 32);
  integer(config.desktop.uiPollMs, 'desktop.uiPollMs', 1, 10000);
  integer(config.failureReporting.blockedAfterMs,'failureReporting.blockedAfterMs',1,86400000);
  integer(config.database.busyTimeoutMs, 'database.busyTimeoutMs', 0, 30000);
  integer(config.feishu.timeoutMs, 'feishu.timeoutMs', 1, 60000);
  if (!['https://open.feishu.cn', 'https://open.larksuite.com'].includes(config.feishu.apiOrigin)) throw new BridgeError('CONFIG', 'Feishu API requires an official HTTPS origin');
  integer(config.background.intervalMs, 'background.intervalMs', 1, 3600000);
  integer(config.background.timeoutMs, 'background.timeoutMs', 1, 600000);
  integer(config.background.leaseSeconds, 'background.leaseSeconds', 1, 86400);
  integer(config.background.maxConcurrent, 'background.maxConcurrent', 1, 1);
  integer(config.background.notificationLeaseMs, 'background.notificationLeaseMs', 1, 300000);
  if (config.background.leaseSeconds * 1000 <= config.background.timeoutMs) throw new BridgeError('CONFIG', 'Execution lease must exceed its operation timeout');
  if (typeof config.background.workspaceRoot !== 'string' || !config.background.workspaceRoot.trim()) throw new BridgeError('CONFIG', 'Invalid background workspace root');
  config.background.workspaceRoot = resolve(base, config.background.workspaceRoot);
  for (const agent of Object.values(config.agents)) if (typeof agent.enabled !== 'boolean') throw new BridgeError('CONFIG', 'Agent enabled must be boolean');
  for (const key of ['enabled', 'allowForegroundAutomation', 'allowPhysicalInput'] as const) if (typeof config.desktop[key] !== 'boolean') throw new BridgeError('CONFIG', `desktop.${key} must be boolean`);
  if (config.desktop.allowPhysicalInput) throw new BridgeError('CONFIG', 'Physical input is unsupported');
  for (const value of [config.database.path, config.agents.codex.statePath, config.desktop.python, config.agents.chatgpt.model, config.agents.chatgpt.reasoningEffort]) if (typeof value !== 'string' || !value.trim()) throw new BridgeError('CONFIG', 'Configured paths/model must be nonempty strings');
  for (const value of [config.agents.codex.executable, config.agents.hermes.metadataPath, config.agents.pi.locksPath]) if (value !== null && (typeof value !== 'string' || !value.trim())) throw new BridgeError('CONFIG', 'Optional paths must be null or nonempty strings');
  if (!['info', 'warn', 'error'].includes(config.logging.level) || config.logging.redactSecrets !== true) throw new BridgeError('CONFIG', 'Logging must redact secrets');
  let cdp: URL; try { cdp = new URL(config.desktop.cdpUrl); } catch { throw new BridgeError('CONFIG', 'desktop.cdpUrl is invalid'); }
  if (cdp.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(cdp.hostname) || cdp.username || cdp.password || cdp.search || cdp.hash) throw new BridgeError('CONFIG', 'CDP must be credential-free loopback HTTP');
  if (config.desktop.remoteAllowOrigins !== cdp.origin) throw new BridgeError('CONFIG', 'desktop.remoteAllowOrigins must be the configured restricted loopback origin; wildcard rejected');
  config.database.path = resolve(base, config.database.path);
  for (const [object, key] of [[config.agents.codex, 'statePath'], [config.agents.codex, 'executable'], [config.agents.hermes, 'metadataPath'], [config.agents.pi, 'locksPath']] as const) {
    const record = object as unknown as Record<string, unknown>; const value = record[key]; if (typeof value === 'string' && !isAbsolute(value)) record[key] = resolve(base, value);
  }
  return config;
}
