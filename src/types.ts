// Agent Control Bridge — 类型定义

export const TASK_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "UNKNOWN",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EXECUTORS = ["codex", "pi", "chatgpt", "hermes"] as const;
export type Executor = (typeof EXECUTORS)[number];

export interface Project {
  id: string;
  name: string;
  root_path: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  external_id: string | null;
  project_id: string | null;
  source: "codex" | "chatgpt" | "pi" | "manual";
  title: string | null;
  state: string;
  last_observed_at: string | null;
}

export interface Task {
  id: string;
  project_id: string | null;
  session_id: string | null;
  kind: string;
  title: string;
  status: TaskStatus;
  executor: Executor | null;
  priority: number;
  claimed_by: string | null;
  claimed_instance: string | null;
  attempt_executor: string | null;
  attempt_instance: string | null;
  created_by: string | null;
  created_instance: string | null;
  version: number;
  attempt: number;
  claim_expires_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Event {
  id: number;
  task_id: string;
  type: string;
  payload: string | null;
  source: string;
  observed_at: string;
}

export interface Approval {
  id: string;
  task_id: string;
  action: string;
  requested_by: string | null;
  requested_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision: "pending" | "approved" | "rejected";
  reason: string | null;
}

// 状态机转移规则
// 关键约束（铁律）：
//   铁律①：执行者（Pi/Codex）完成工作 → 只能进入 WAITING_APPROVAL（等待独立验收）。
//           SUCCEEDED 只能通过 verify() 由拥有 reviewer capability 的独立 principal 进入。
//           CLI 字符串与 Agent 名称不能授权；禁止直接 transition。
//   铁律②：失去连接（租约过期）→ 只告警、不改状态（保持 RUNNING），绝不误判为完成。
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["WAITING_APPROVAL", "BLOCKED", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"],
  BLOCKED: ["RUNNING", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: ["QUEUED", "CANCELLED"], // 失败后重新排队（修复任务）
  CANCELLED: [],
  UNKNOWN: ["QUEUED"], // 未知状态须由授权 reviewer 重新排队，不能直接领取或判完成。
};

export function isAllowedTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}
