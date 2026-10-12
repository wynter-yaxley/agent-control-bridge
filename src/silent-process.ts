import { spawn } from 'node:child_process';
import { redact } from './security.ts';
export interface OperationResult { operation: string; ok: boolean; code: string; exitCode: number | null; needsUserAction: boolean; partialChanges: boolean; summary: string; stdout?: string }
export function controlledProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // OS runtime metadata only; no model, npm authentication or arbitrary user variables.
  for (const key of ['PATH','Path','SystemRoot','SystemDrive','WINDIR','ComSpec','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','TEMP','TMP','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','ALLUSERSPROFILE','USERNAME','USERDOMAIN']) if (process.env[key] !== undefined) env[key] = process.env[key];
  // Built-in cmdlets must resolve from OS-owned modules, even in a sanitized runner.
  if(process.platform==='win32')env.PSModulePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
  return env;
}
export async function silentProcess(operation: string, executable: string, args: readonly string[], options: { timeoutMs?: number; mutation?: boolean; cwd?: string } = {}): Promise<OperationResult> {
  const env=controlledProcessEnv();
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GCM_GUI_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', CI: '1' });
  return new Promise(resolve => {
    const child = spawn(executable, [...args], { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', timedOut = false, truncated = false;
    const collect = (data: Buffer, error: boolean) => {
      if (stdout.length + stderr.length + data.length > 1048576) { truncated = true; child.kill(); return; }
      if (error) stderr += data.toString(); else stdout += data.toString();
    };
    child.stdout.on('data', data => collect(data, false)); child.stderr.on('data', data => collect(data, true));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 30000);
    child.once('error', () => { clearTimeout(timer); resolve({ operation, ok: false, code: 'DEPENDENCY', exitCode: null, needsUserAction: true, partialChanges: false, summary: 'Executable is missing or cannot be started' }); });
    child.once('close', exitCode => {
      clearTimeout(timer); const auth = /authentication|authorization|login|log in|credential|401|403|permission denied/i.test(stderr);
      const ok = exitCode === 0 && !timedOut && !truncated;
      resolve({ operation, ok, code: ok ? 'OK' : timedOut ? 'TIMEOUT' : truncated ? 'OUTPUT_LIMIT' : auth ? 'AUTH' : 'EXECUTION', exitCode,
        needsUserAction: auth, partialChanges: !ok && Boolean(options.mutation),
        summary: ok ? 'Operation completed' : timedOut ? 'Deadline exceeded; external outcome must be checked' : auth ? 'Existing authorization unavailable; no login or fallback attempted' : 'Operation failed; private tool diagnostics omitted',
        ...(ok ? { stdout: redact(stdout) } : {}) });
    });
  });
}
