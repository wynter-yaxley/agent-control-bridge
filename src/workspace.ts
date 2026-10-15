import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { BridgeError } from './errors.ts';
import { createProject, type CodexOptions } from './codex.ts';

export interface Workspace { projectId: string; name: string; path: string; roots: unknown; directoryCreated: boolean }
/** Stable UUID-shaped key per directory, so a repeated create returns the same project. */
const keyFor = (path: string) => { const hex = createHash('sha256').update((process.platform === 'win32' ? path.toLowerCase() : path)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`; };

/** Creates a local workspace directory (or uses an existing one) and registers it as a
 * Codex project through the App Server (project/create). */
export async function createWorkspace(options: CodexOptions & { root: string | null; create?: typeof createProject }, name: string, path?: string): Promise<Workspace> {
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)) throw new BridgeError('INPUT', 'Workspace name is not a valid folder name');
  if (!path && !options.root) throw new BridgeError('CONFIG', 'Give a path or configure workspaceRoot');
  const target = normalize(path ?? join(options.root!, name)).replace(/(?<!^[A-Za-z]:)[\\/]+$/, '');
  if (!isAbsolute(target)) throw new BridgeError('INPUT', 'Workspace path must be absolute');
  let directoryCreated = false;
  if (existsSync(target)) { if (!statSync(target).isDirectory()) throw new BridgeError('CONFLICT', 'Workspace path exists and is not a directory'); }
  else { mkdirSync(target, { recursive: true }); directoryCreated = true; }
  const project = await (options.create ?? createProject)(options, name, target, keyFor(target));
  return { ...project, path: target, directoryCreated };
}
