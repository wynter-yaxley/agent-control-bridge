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
import { execFileSync } from 'node:child_process';
import { WINDOWS_POWERSHELL } from './permissions.ts';
import { readBounded, safeText } from './security.ts';
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
    raw = execFileSync('curl', ['--silent', '--fail', '--max-time', '6', 'https://status.openai.com/api/v2/summary.json'], { timeout: 8000, maxBuffer: 1048576 }).toString();
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

export function readChatgptAppStatus(): ChatgptAppStatus {
  const base: ChatgptAppStatus = { source: 'OS process metadata only', package_installed: false, version: null, running: null, process_count: null, window_title: null, cache_last_write: null, local_conversation_cache: false, note: 'No profiles, credentials or conversation caches are accessed; process existence does not prove task execution' };
  if (process.platform !== 'win32') return { ...base, note: 'Windows desktop metadata unavailable on this platform' };
  try {
    const output = execFileSync(WINDOWS_POWERSHELL, ['-NoProfile','-NonInteractive','-Command', '(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Measure-Object).Count'], { timeout: 10000, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
    if (!/^\d+$/.test(output)) throw new Error();
    base.process_count = Number(output); base.running = Number(output) > 0;
  } catch { base.note += '; process query failed, state unknown'; }
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
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Invalid input');
    const raw = readBounded(input);
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 1000) throw new Error('Invalid export');
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
      const title = safeText(item.title ?? `会话 ${index + 1}`);
      if (title.length > 4096) throw new Error();
      if (item.create_time !== undefined && (typeof item.create_time !== 'number' || !Number.isFinite(item.create_time))) throw new Error();
      const time = item.create_time === undefined ? now() : new Date(item.create_time * 1000).toISOString();
      rows.push({ id: `chatgpt:${external}`, external, title, time });
      lines.push(`\n## ${title}\n`);
      const entries = Object.values(item.mapping ?? {}).filter(e => e?.message?.author?.role === 'user' || e?.message?.author?.role === 'assistant');
      entries.sort((a, b) => (a.message?.create_time ?? 0) - (b.message?.create_time ?? 0));
      for (const entry of entries) {
        const parts = entry.message?.content?.parts ?? [];
        if (!Array.isArray(parts)) throw new Error('Invalid content');
        const content = safeText(parts.filter(p => typeof p === 'string').join('\n').trim());
        if (content.length > 65536 || messages > 10000) throw new Error();
        if (content) { messages++; lines.push(`**[${entry.message!.author!.role}]**\n${content}\n`); }
      }
    }
    fd = openSync(output, 'wx', 0o600);
    fileIdentity = fstatSync(fd);
    protectPath(output);
    transaction(db, () => {
      for (const row of rows) db.prepare(`INSERT INTO sessions(id,external_id,source,title,state,last_observed_at,source_created_at)
        VALUES(?,?,'chatgpt',?,'archived',?,?) ON CONFLICT(source,external_id) WHERE external_id IS NOT NULL DO UPDATE SET title=excluded.title,last_observed_at=excluded.last_observed_at,source_created_at=excluded.source_created_at`)
        .run(row.id, row.external, row.title, now(), row.time);
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
