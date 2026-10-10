// Agent Control Bridge — ChatGPT 同步（诚实 + 官方导出导入）
// 关键事实（不可改变）：ChatGPT 个人网页会话没有供第三方完整订阅的官方 MCP 事件流。
// 因此本模块不做"自动同步"，而是：
//   1. 诚实报告同步状态（not_configured / manual_only）。
//   2. 支持解析 ChatGPT 官方数据导出（Data controls → Export 的 conversations.json）入库。
//   3. 支持手动 Markdown 导入（见 CLI markdown-import）。
// 不窃取 Cookie/token，不读取未授权会话。
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync, openSync, closeSync, unlinkSync, fstatSync, lstatSync } from "node:fs";
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { now, transaction } from "./db.ts";
import { protectPath } from './permissions.ts';

// ---------- 实时服务状态（官方公开状态页 API，真实 HTTP 读取） ----------
export interface ChatgptServiceStatus {
  source: string;
  fetched_at: string;
  overall: string; // 总体指示 + 描述
  watched: { name: string; status: string }[]; // ChatGPT 面向用户的组件
  degraded: string[]; // 任何非 operational 的组件
  incidents: string[]; // 未解决事件
  error?: string; // 获取失败时如实标注（不虚构）
}

// 重点观察的 ChatGPT 用户侧组件（响应里没有的静默跳过）
const WATCHED = ["ChatGPT Work", "Conversations", "Login", "Voice mode", "GPTs", "Image Generation", "Deep Research", "File uploads", "Search"];

export function fetchChatgptServiceStatus(): ChatgptServiceStatus {
  const fetched_at = now();
  const base: ChatgptServiceStatus = { source: "status.openai.com（OpenAI 官方状态页 API）", fetched_at, overall: "unknown", watched: [], degraded: [], incidents: [] };
  let raw: string;
  try {
    raw = execSync("curl -s --max-time 6 https://status.openai.com/api/v2/summary.json", { timeout: 8000 }).toString();
  } catch {
    return { ...base, error: "无法访问官方状态页（网络不可达），状态未知——不虚构" };
  }
  try {
    const d = JSON.parse(raw) as {
      status?: { description?: string; indicator?: string };
      components?: { name: string; status: string }[];
      incidents?: { name: string; status: string; impact?: string }[];
    };
    const overall = `${d.status?.description ?? "unknown"} (${d.status?.indicator ?? "unknown"})`;
    const comps = d.components ?? [];
    const watched = comps.filter((c) => WATCHED.includes(c.name)).map((c) => ({ name: c.name, status: c.status }));
    const degraded = comps.filter((c) => c.status !== "operational").map((c) => `${c.name}: ${c.status}`);
    const incidents = (d.incidents ?? []).map((i) => `${i.name} | ${i.status} | impact=${i.impact ?? "?"}`);
    return { ...base, overall, watched, degraded, incidents };
  } catch {
    return { ...base, error: "状态页响应解析失败，状态未知——不虚构" };
  }
}

// ---------- UWP 桌面应用实时状态（真实读取：进程/窗口/包版本/缓存活跃度） ----------
// ChatGPT 桌面 = OpenAI.Codex MSIX 包内 app\ChatGPT.exe；Appx 虚拟化落盘在 LocalCache。
export interface ChatgptAppStatus {
  source: string;
  package_installed: boolean;
  version: string | null;
  running: boolean | null; // null = 查询失败，未知（不虚构）
  process_count: number | null;
  window_title: string | null;
  cache_last_write: string | null; // Local Storage/leveldb 最新写入（应用活跃度）
  local_conversation_cache: false; // 诚实固定：会话标题/内容不在本地（云端），本地只有 device-id
  note: string;
}

const APPX_PKG = "/mnt/c/Users/[USER]/AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0";
const APP_PROFILE = `${APPX_PKG}/LocalCache/Roaming/Codex/web/Codex`;
const APP_LS_LEVELDB = `${APP_PROFILE}/Default/Local Storage/leveldb`;

export function readChatgptAppStatus(): ChatgptAppStatus {
  const base: ChatgptAppStatus = {
    source: "OpenAI.Codex MSIX 包内 ChatGPT.exe（Appx LocalCache，真实文件/进程读取）",
    package_installed: existsSync(APPX_PKG),
    version: null,
    running: false,
    process_count: 0,
    window_title: null,
    cache_last_write: null,
    local_conversation_cache: false,
    note: "ChatGPT 对话本体在云端；本地缓存仅 device-id/工作元数据，未读取任何登录凭据。",
  };
  // 进程 + 窗口标题（无变量管道——WSL→PowerShell 会吃掉 $ 变量，勿用变量）
  try {
    const out = execSync(
      `powershell.exe -NoProfile -Command "Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count; Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object MainWindowTitle -ne '' | Select-Object -First 1 -ExpandProperty MainWindowTitle"`,
      { timeout: 10000 }
    ).toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    base.process_count = out.length ? parseInt(out[0], 10) : 0;
    base.running = base.process_count > 0;
    if (out.length > 1) base.window_title = out.slice(1).join(" ");
  } catch {
    base.running = null;
    base.process_count = null;
    base.note += "（进程查询失败，状态未知——不虚构）";
  }
  // 包版本（一次查询；失败不虚构）
  try {
    const v = execSync(`powershell.exe -NoProfile -Command "(Get-AppxPackage -Name OpenAI.Codex).Version"`, { timeout: 10000 }).toString().trim();
    if (v) base.version = v;
  } catch { /* 保持 null */ }
  // 缓存活跃度（leveldb 最新 mtime）
  try {
    const files = readdirSync(APP_LS_LEVELDB);
    let newest = 0;
    for (const f of files) {
      const st = statSync(`${APP_LS_LEVELDB}/${f}`);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
    if (newest > 0) base.cache_last_write = new Date(newest).toISOString();
  } catch { /* 保持 null */ }
  return base;
}

export interface ChatgptStatus {
  status: "not_configured" | "manual_only";
  official_event_stream: false; // 诚实固定为 false
  imported_sessions: number;
  last_sync_at: string | null;
  message: string;
}

export function readChatgptStatus(db: DatabaseSync): ChatgptStatus {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE source='chatgpt'`).get() as { n: number }).n;
  const last = (db.prepare(`SELECT MAX(last_observed_at) AS t FROM sessions WHERE source='chatgpt'`).get() as { t: string | null }).t;
  return {
    status: n > 0 ? "manual_only" : "not_configured",
    official_event_stream: false,
    imported_sessions: n,
    last_sync_at: last,
    message:
      "ChatGPT 个人网页会话无官方第三方订阅事件流，无法自动同步。" +
      (n > 0
        ? `当前已手动导入 ${n} 个会话（来自官方数据导出或 Markdown）。`
        : "可用路径：① 官方数据导出（Settings → Data controls → Export）的 conversations.json 用 chatgpt-import 导入；② 手动 Markdown 导入；③ 受控浏览器观察可见消息（需用户自行登录）。") +
      "浏览器关闭、页面未更新或同步中断时，如实显示未同步，不虚构进度。",
  };
}

// 解析 ChatGPT 官方导出的 conversations.json（新格式：数组，每项含 title/conversation_id/mapping）
interface ChatgptConversation {
  title?: string;
  conversation_id?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, { message?: { author?: { role?: string }; content?: { parts?: unknown[] }; create_time?: number } }>;
}

export interface ImportResult {
  sessions: number;
  messages: number;
  markdownPath: string | null;
}

export function importChatgptExport(db: DatabaseSync, filePath: string, outputPath?: string): ImportResult | { error: string } {
  const input = resolve(filePath), extension = extname(input);
  if (extension.toLowerCase() !== '.json') return { error: 'Input must have a .json extension (case insensitive)' };
  const output = resolve(outputPath ?? input.slice(0, -extension.length) + '.conversations.md');
  const normalize = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  if (normalize(input) === normalize(output)) return { error: 'Output must not be the input file' };
  // wx is authoritative: preflight checks alone cannot prevent races/aliases.
  if (existsSync(output)) return { error: 'Output already exists; refusing overwrite' };
  let fd: number | undefined;
  let fileIdentity: ReturnType<typeof fstatSync> | undefined;
  try {
    const info = lstatSync(input);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) throw new Error('Invalid input');
    const raw = readFileSync(input, 'utf8');
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 10000) throw new Error('Invalid export');
    const rows: { id: string; external: string; title: string; time: string }[] = [];
    const lines = ['# ChatGPT 会话导出', ''];
    let messages = 0;
    for (const [index, value] of data.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation');
      const item = value as ChatgptConversation;
      if ((item.title !== undefined && typeof item.title !== 'string') ||
          (item.conversation_id !== undefined && typeof item.conversation_id !== 'string') ||
          (item.mapping !== undefined && (!item.mapping || typeof item.mapping !== 'object' || Array.isArray(item.mapping)))) throw new Error('Invalid conversation');
      const external = item.conversation_id ?? createHash('sha256').update(raw).update(String(index)).digest('hex');
      const title = item.title ?? `会话 ${index + 1}`;
      const time = item.create_time === undefined ? now() : new Date(item.create_time * 1000).toISOString();
      rows.push({ id: `chatgpt:${external}`, external, title, time });
      lines.push(`\n## ${title}\n`);
      const entries = Object.values(item.mapping ?? {}).filter(e => e?.message?.author?.role === 'user' || e?.message?.author?.role === 'assistant');
      entries.sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
      for (const entry of entries) {
        const parts = entry.message?.content?.parts ?? [];
        if (!Array.isArray(parts)) throw new Error('Invalid content');
        const content = parts.filter(p => typeof p === 'string').join('\n').trim();
        if (content) { messages++; lines.push(`**[${entry.message!.author!.role}]**\n${content}\n`); }
      }
    }
    fd = openSync(output, 'wx', 0o600);
    fileIdentity = fstatSync(fd);
    protectPath(output);
    transaction(db, () => {
      for (const row of rows) db.prepare(`INSERT INTO sessions(id,external_id,source,title,state,last_observed_at)
        VALUES(?,?,'chatgpt',?,'archived',?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,last_observed_at=excluded.last_observed_at WHERE sessions.source='chatgpt'`)
        .run(row.id, row.external, row.title, row.time);
      writeFileSync(fd!, lines.join('\n'), 'utf8');
    });
    return { sessions: rows.length, messages, markdownPath: output };
  } catch {
    // Do not echo parse errors: Node may include private conversation contents.
    if (fd !== undefined && fileIdentity && existsSync(output)) {
      const current = lstatSync(output);
      if (current.ino === fileIdentity.ino && current.dev === fileIdentity.dev) {
        closeSync(fd); fd = undefined; unlinkSync(output);
      }
    }
    return { error: 'Export import failed; no overwrite permitted and database changes rolled back' };
  } finally { if (fd !== undefined) closeSync(fd); }
}
