// Agent Control Bridge — Pi Agent 状态读取（只读）
import { readFileSync, existsSync } from "node:fs";

const PI_LOCKS = "/home/hermes/.pi/agent/locks.json";
const PI_SETTINGS = "/home/hermes/.pi/agent/settings.json";
const PI_CODING_AGENT_PKG = "/home/hermes/.nvm/versions/node/v22.22.3/lib/node_modules/@earendil-works/pi-coding-agent/package.json";

export interface PiStatus {
  version: string | null;
  feishuConnected: boolean;
  feishuPid: number | null;
  extensions: string[];
  status: "running" | "degraded" | "unknown";
}

export function readPiStatus(): PiStatus {
  let version: string | null = null;
  try {
    if (existsSync(PI_CODING_AGENT_PKG)) {
      version = (JSON.parse(readFileSync(PI_CODING_AGENT_PKG, "utf8")) as { version?: string }).version ?? null;
    }
  } catch {
    version = null;
  }

  let feishuConnected = false;
  let feishuPid: number | null = null;
  try {
    const locks = JSON.parse(readFileSync(PI_LOCKS, "utf8")) as Record<string, { pid?: number; status?: string }>;
    for (const v of Object.values(locks)) {
      if (v.status === "connected") {
        feishuConnected = true;
        feishuPid = v.pid ?? null;
      }
    }
  } catch {
    feishuConnected = false;
  }

  let extensions: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(PI_SETTINGS, "utf8")) as { packages?: string[] };
    extensions = settings.packages ?? [];
  } catch {
    extensions = [];
  }

  const status: PiStatus["status"] = feishuConnected ? "running" : "degraded";
  return { version, feishuConnected, feishuPid, extensions, status };
}
