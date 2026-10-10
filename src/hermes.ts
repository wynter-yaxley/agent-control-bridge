// Agent Control Bridge — Hermes 状态读取（只读）
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const HERMES_PKG = "/home/hermes/.hermes/hermes-agent/package.json";
const HERMES_FEISHU_SEEN = "/home/hermes/.hermes/feishu_seen_message_ids.json";

export interface HermesStatus {
  version: string | null;
  feishuActivity: boolean;
  alive: boolean;
  status: "running" | "degraded" | "unknown";
}

function hermesAlive(): boolean {
  try {
    const out = execSync("pgrep -f hermes_cli", { timeout: 3000 }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

export function readHermesStatus(): HermesStatus {
  let version: string | null = null;
  try {
    if (existsSync(HERMES_PKG)) {
      version = (JSON.parse(readFileSync(HERMES_PKG, "utf8")) as { version?: string }).version ?? null;
    }
  } catch {
    version = null;
  }

  let feishuActivity = false;
  try {
    if (existsSync(HERMES_FEISHU_SEEN)) {
      const seen = JSON.parse(readFileSync(HERMES_FEISHU_SEEN, "utf8")) as { message_ids?: Record<string, unknown> };
      feishuActivity = Object.keys(seen.message_ids ?? {}).length > 0;
    }
  } catch {
    feishuActivity = false;
  }

  const alive = hermesAlive();
  return { version, feishuActivity, alive, status: alive ? "running" : "degraded" };
}
