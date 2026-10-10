// Agent Control Bridge — Codex 操作封装（fork / exec / resume）
// 诚实边界：这些是「执行/分叉」操作，不是「只读历史」。
// 会话内容（对话历史）无法通过 CLI 只读读取；读取需 app-server（experimental）。
// fork / resume 涉及写 Codex 会话，属高风险，必须经 Bridge 审批流程后执行。
import { existsSync } from "node:fs";

const CODEX_EXE = 'codex'; // Command plans only; real executable comes from unified config.

export interface CodexOp {
  command: string;
  args: string[];
  highRisk: boolean;
  description: string;
}

export function codexAvailable(executable: string | null = null): boolean {
  return executable !== null && existsSync(executable);
}

// fork：从原会话创建可验证分支（任务书第四阶段优先级 B）
export function buildFork(threadId: string): CodexOp {
  return {
    command: CODEX_EXE,
    args: ["fork", threadId],
    highRisk: true, // fork 会创建新会话，需审批
    description: `从会话 ${threadId} 创建分支`,
  };
}

// resume：恢复原会话（任务书第四阶段优先级 A）
export function buildResume(threadId: string, prompt?: string): CodexOp {
  const args = ["exec", "resume", threadId];
  if (prompt) args.push(prompt);
  return {
    command: CODEX_EXE,
    args,
    highRisk: true, // 恢复会话会向原 Thread 写入，需审批 + 确认无并发写入
    description: `恢复会话 ${threadId}${prompt ? " 并发送指令" : ""}`,
  };
}

// 只读：列出 agents（注意：这是 TUI 交互式，实际可能不适用 headless）
export function buildAgentsList(): CodexOp {
  return {
    command: CODEX_EXE,
    args: ["agents"],
    highRisk: false,
    description: "列出 Codex 会话（TUI，可能不适用 headless）",
  };
}

// 说明：当前 CLI 版本无 headless 的「读取会话历史内容」接口。
// 因此会话内容的获取降级为：元数据（已接入）+ 用户手动 Markdown 导入（见 markdown 导入命令）。
export function codexContentReadLimitation(): string {
  return (
    "Codex CLI 无 headless 读取会话历史内容的接口（resume 为交互式，exec resume 会实际执行）。" +
    "会话内容读取需 app-server（experimental）或用户手动导出。本桥不伪称支持会话内容读取。"
  );
}
