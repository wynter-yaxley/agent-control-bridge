// Agent Control Bridge — Codex 状态读取（只读，基于 .codex-global-state.json）
import { readFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "./db.ts";
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readBounded, requireNoSecrets, safeText } from './security.ts';

// Codex 全局状态的默认路径（Windows 侧）
const DEFAULT_CODEX_STATE =
  join(homedir(), '.codex', '.codex-global-state.json');

export interface CodexProject {
  id: string;
  name: string;
  rootPath: string;
}

export interface CodexThread {
  id: string;
  projectId: string | null;
  workspace: string | null;
}

export interface CodexState {
  selectedProjectId: string | null;
  projects: CodexProject[];
  threads: CodexThread[];
  projectOrder: string[];
}

// 读取并解析 Codex 全局状态（只读，绝不做任何写回）
export function readCodexState(statePath: string = DEFAULT_CODEX_STATE): CodexState | { error: string } {
  if (!existsSync(statePath)) {
    return { error: `Codex 状态文件不存在: ${statePath}` };
  }
  try {
    const parsed: unknown = JSON.parse(readBounded(statePath));
    const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    const string = (value: unknown): value is string => typeof value==='string' && value.length<=4096;
    if (!record(parsed)) throw new Error('Invalid state');
    const raw = parsed;
    for(const key of ['selected-project','local-projects','thread-project-assignments','thread-workspace-root-hints']) if(raw[key]!==undefined&&!record(raw[key])) throw new Error();
    const selectedValue=raw['selected-project'] as Record<string,unknown>|undefined;
    if(selectedValue?.projectId!==undefined && !string(selectedValue.projectId)) throw new Error();
    const projectValues=Object.values(raw['local-projects'] as Record<string,unknown>??{});
    const assignmentValues=Object.entries(raw['thread-project-assignments'] as Record<string,unknown>??{});
    if(projectValues.length>1000 || assignmentValues.length>10000) throw new Error();
    for(const value of projectValues) if(!record(value)||!string(value.id)||!value.id||!string(value.name)||!Array.isArray(value.rootPaths)||value.rootPaths.some(path=>!string(path))) throw new Error();
    for(const [id,value] of assignmentValues) if(!id||!record(value)||(value.projectId!==undefined&&!string(value.projectId))) throw new Error();
    for(const value of Object.values(raw['thread-workspace-root-hints'] as Record<string,unknown>??{})) if(!string(value)) throw new Error();
    const selected = raw["selected-project"] as { projectId?: string } | undefined;
    const projectsRaw = raw["local-projects"] as Record<string, { id: string; name: string; rootPaths: string[] }> | undefined;
    const assignments = raw["thread-project-assignments"] as Record<string, { projectId?: string }> | undefined;
    const hints = raw["thread-workspace-root-hints"] as Record<string, string> | undefined;
    const order = (raw["project-order"] as string[] | undefined) ?? [];

    const projects: CodexProject[] = Object.values(projectsRaw ?? {}).map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPaths?.[0] ?? "",
    }));
    if (projects.some(p => typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || typeof p.rootPath !== 'string') || !Array.isArray(order) || order.some(p => typeof p !== 'string')) throw new Error('Invalid metadata');

    const threads: CodexThread[] = Object.keys(assignments ?? {}).map((id) => ({
      id,
      projectId: assignments![id].projectId ?? null,
      workspace: hints?.[id] ?? null,
    }));

    return {
      selectedProjectId: selected?.projectId ?? null,
      projects,
      threads,
      projectOrder: order,
    };
  } catch (e) {
    return { error: 'Codex metadata is malformed or unavailable; execution state is unknown' };
  }
}

// 把 Codex 状态同步进 Bridge（projects + sessions 表，只读来源）
export function syncCodexToBridge(db: DatabaseSync, state: CodexState): { projects: number; threads: number } {
  if(state.projects.length>1000||state.threads.length>10000) throw new Error('Metadata limit exceeded');
  for(const value of [...state.projects.flatMap(p=>[p.id,p.name,p.rootPath]),...state.threads.flatMap(t=>[t.id,t.projectId,t.workspace])]) {
    if(value!==null) { if(typeof value!=='string'||value.length>4096) throw new Error('Invalid metadata'); requireNoSecrets(value); }
  }
  return transaction(db, () => {
  const t = now();
  for (const p of state.projects) {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'codex', ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path, updated_at=excluded.updated_at`
    ).run(p.id, safeText(p.name), p.rootPath, t, t);
  }
  for (const th of state.threads) {
    // 本地 session id 直接用 thread id（幂等）
    db.prepare(
      `INSERT INTO sessions (id, external_id, project_id, source, state, last_observed_at)
       VALUES (?, ?, ?, 'codex', 'unknown', ?)
       ON CONFLICT(source,external_id) WHERE external_id IS NOT NULL DO UPDATE SET project_id=excluded.project_id, last_observed_at=excluded.last_observed_at`
    ).run(`codex:${th.id}`, th.id, th.projectId, t);
  }
  return { projects: state.projects.length, threads: state.threads.length };
  });
}

// 项目下 thread 数量统计
export function countThreadsByProject(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare(`SELECT project_id, COUNT(*) AS n FROM sessions WHERE source='codex' GROUP BY project_id`).all() as {
    project_id: string | null;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) if (r.project_id) out[r.project_id] = r.n;
  return out;
}
