import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.ts';
import type { NativeProject } from './native.ts';
import type { UiResult } from './windows-ui.ts';

export interface WorkspaceDeps {
  native: { listProjects(): Promise<NativeProject[]> };
  ui: { call(operation: 'workspace-create', fields: { name: string; path: string }, signal: AbortSignal): Promise<UiResult> };
  root: string | null;
  timeoutMs: number;
  pollMs: number;
}
export interface Workspace { projectId: string; label: string; path: string; directoryCreated: boolean; projectCreated: boolean }
const key = (path: string) => { const value = normalize(path).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? value.toLowerCase() : value; };

/** Creates (or reuses) a local directory and its native ChatGPT/Codex project. A
 * project already registered for the directory is associated, never duplicated. */
export async function createWorkspace(deps: WorkspaceDeps, name: string, path?: string): Promise<Workspace> {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new BridgeError('INPUT', 'Workspace name is not a valid folder name');
  if (!path && !deps.root) throw new BridgeError('CONFIG', 'Give a path or configure workspaceRoot');
  const target = normalize(path ?? join(deps.root!, name)).replace(/[\\/]+$/, '');
  if (!isAbsolute(target)) throw new BridgeError('INPUT', 'Workspace path must be absolute');
  let directoryCreated = false;
  if (existsSync(target)) { if (!statSync(target).isDirectory()) throw new BridgeError('CONFLICT', 'Workspace path exists and is not a directory'); }
  else { mkdirSync(target, { recursive: true }); directoryCreated = true; }
  const registered = async () => {
    const found = (await deps.native.listProjects()).filter(project => project.projectKind === 'local' && key(project.path) === key(target));
    if (found.length > 1) throw new BridgeError('PROVENANCE', 'Several native projects use this directory');
    return found[0];
  };
  const existing = await registered();
  if (existing) return { projectId: existing.projectId, label: existing.label, path: existing.path, directoryCreated, projectCreated: false };
  await deps.ui.call('workspace-create', { name, path: target }, AbortSignal.timeout(deps.timeoutMs + 60000));
  const deadline = Date.now() + 60000;
  for (;;) {
    const project = await registered();
    if (project) return { projectId: project.projectId, label: project.label, path: project.path, directoryCreated, projectCreated: true };
    if (Date.now() >= deadline) throw new BridgeError('TIMEOUT', 'The project dialog finished but no native project lists this directory; check the app before retrying');
    await delay(deps.pollMs);
  }
}
