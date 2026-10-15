export type ErrorCode = 'FOCUS_REQUIRED' | 'AUTH' | 'INPUT' | 'CONFIG' | 'IPC_CONFIG' | 'OWNER' | 'PROVENANCE' | 'STATE' | 'CONFLICT' | 'DEPENDENCY' | 'UNSUPPORTED' | 'TIMEOUT' | 'EXECUTION' | 'IO';
export const ERROR_CODES: readonly string[] = ['FOCUS_REQUIRED', 'AUTH', 'INPUT', 'CONFIG', 'IPC_CONFIG', 'OWNER', 'PROVENANCE', 'STATE', 'CONFLICT', 'DEPENDENCY', 'UNSUPPORTED', 'TIMEOUT', 'EXECUTION', 'IO'];
export class BridgeError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.name = 'BridgeError'; this.code = code; }
}
export const asBridgeError = (error: unknown): BridgeError => error instanceof BridgeError ? error : new BridgeError('IO', error instanceof Error ? error.message.slice(0, 300) : 'Operation failed');
/** OS runtime variables only for helper processes; no tokens or arbitrary user variables. */
export function controlledProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'USERNAME', 'USERDOMAIN'])
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  // Built-in cmdlets must resolve from OS-owned modules.
  if (process.platform === 'win32') env.PSModulePath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  return env;
}
