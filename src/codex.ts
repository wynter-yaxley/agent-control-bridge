// Agent Control Bridge — Codex 状态读取（只读，基于 .codex-global-state.json）
import { readFileSync, existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.ts";

// Codex 全局状态的默认路径（Windows 侧）
const DEFAULT_CODEX_STATE =
  "/mnt/c/Users/[USER]/.codex/.codex-global-state.json";

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
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
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
    return { error: `解析 Codex 状态失败: ${(e as Error).message}` };
  }
}

// 把 Codex 状态同步进 Bridge（projects + sessions 表，只读来源）
export function syncCodexToBridge(db: DatabaseSync, state: CodexState): { projects: number; threads: number } {
  const t = now();
  for (const p of state.projects) {
    db.prepare(
      `INSERT INTO projects (id, name, root_path, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'codex', ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path, updated_at=excluded.updated_at`
    ).run(p.id, p.name, p.rootPath, t, t);
  }
  for (const th of state.threads) {
    // 本地 session id 直接用 thread id（幂等）
    db.prepare(
      `INSERT INTO sessions (id, external_id, project_id, source, state, last_observed_at)
       VALUES (?, ?, ?, 'codex', 'unknown', ?)
       ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, last_observed_at=excluded.last_observed_at`
    ).run(th.id, th.id, th.projectId, t);
  }
  return { projects: state.projects.length, threads: state.threads.length };
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
