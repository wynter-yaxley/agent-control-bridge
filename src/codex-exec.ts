// Agent Control Bridge — Codex 后台投递适配器（codex exec，非交互后台执行）。
//
// 与 src/desktop-ipc.ts 的 CDP/IPC 桌面适配器不同：本适配器直接 spawn codex CLI
// （`codex exec` / `codex exec resume`）在后台完成投递，完全不经过 Codex 桌面 UI，
// 不抢鼠标焦点。shell:false + windowsHide:true，prompt 经 stdin 传递。
//
// fail-closed 契约：超时 / 非零退出 / spawn 失败 / 回执中无稳定 thread/turn 标识，
// 一律抛 BridgeError，绝不假装成功（外部结果未知时由 PromptPipeline 标记
// DELIVERY_UNCERTAIN，等待人工确认后才能重试）。
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { BridgeError } from './errors.ts';
import { safeText } from './security.ts';
import { StringDecoder } from 'node:string_decoder';
import type { CodexDelivery, DeliveryTarget } from './prompts.ts';

// codex exec --json 的回执上限，防止失控输出耗尽内存。
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// 稳定标识（thread id / session id / turn id）的宽松格式：非空、可打印、无路径/控制字符。
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const MAX_PROMPT_LENGTH = 65536;

export interface CodexExecDeliveryOptions {
  /** 显式指定的 codex 可执行文件路径，优先级最高。 */
  executable?: string;
  /** 环境变量来源（测试注入用），默认 process.env；读取 ACB_CODEX_EXECUTABLE。 */
  env?: NodeJS.ProcessEnv;
  /** 只读读取 config.agents.codex.executable；不改写配置默认值。 */
  config?: { agents?: { codex?: { executable?: string | null } } };
  /** 单次 codex exec 进程的硬超时（毫秒）。 */
  timeoutMs?: number;
  /** spawn 的工作目录（默认继承当前进程）。 */
  cwd?: string;
  /** 为 true 且 target 提供了 codexConversationId 时，用 `codex exec resume <id>` 续会话。 */
  resume?: boolean;
  /** 测试注入的 spawn 替身；默认 node:child_process 的 spawn。 */
  spawnFn?: typeof nodeSpawn;
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * 可执行文件解析顺序：options.executable → ACB_CODEX_EXECUTABLE →
 * config.agents.codex.executable。全部缺失时抛 CONFIG 错误 —— 探测到的安装路径
 * 属于部署环境事实，必须由配置/环境变量提供，不能硬编码进代码，也不默认赌 PATH。
 */
export function resolveCodexExecutable(options: CodexExecDeliveryOptions): string {
  const candidate = options.executable ?? options.env?.ACB_CODEX_EXECUTABLE
    ?? options.config?.agents?.codex?.executable ?? null;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new BridgeError('CONFIG',
      'Codex executable must be configured via options.executable, ACB_CODEX_EXECUTABLE, or config.agents.codex.executable');
  }
  return candidate.trim();
}

export interface CodexExecReceipt { threadId: string | null; turnId: string | null; completed: boolean; failed: boolean }

function asIdentifier(value: unknown): string | null {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : null;
}

/**
 * 解析 `codex exec --json` 的 JSONL 事件流，提取稳定的会话标识：
 * - `thread.started` / `thread.completed` 事件的 thread_id（新版，UUID）；
 * - 旧版事件的 session_id；turn 级 turn_id / turn.id 作为兜底。
 * 找不到任何标识时由调用方 fail-closed。
 */
export function parseCodexExecReceipt(stdout: string): CodexExecReceipt {
  let threadId: string | null = null;
  let turnId: string | null = null;
  let completed = false, failed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch { continue; }
    completed ||= event['type'] === 'turn.completed';
    failed ||= event['type'] === 'turn.failed' || event['type'] === 'error';
    threadId ??= asIdentifier(event['thread_id']) ?? asIdentifier(event['session_id']);
    const turn = event['turn'];
    turnId ??= asIdentifier(event['turn_id'])
      ?? (turn && typeof turn === 'object' && !Array.isArray(turn)
        ? asIdentifier((turn as Record<string, unknown>)['id']) : null);
  }
  return { threadId, turnId, completed, failed };
}

function runCodexExec(
  spawnFn: typeof nodeSpawn,
  executable: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string; signal: AbortSignal; content: string; onEvent?: (event: Record<string, unknown>) => void },
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    if (options.signal.aborted) { rejectPromise(new BridgeError('TIMEOUT', 'Codex execution was aborted before launch')); return; }
    try {
      child = spawnFn(executable, args, {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: options.cwd,
      });
    } catch {
      rejectPromise(new BridgeError('DEPENDENCY', 'Codex executable could not be started'));
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let settled = false;
    let deadlineExceeded = false;
    let aborted = false;
    let outputExceeded = false;
    const decoder = new StringDecoder('utf8');
    let eventBuffer = '';
    const kill = () => { try { child.kill(); } catch { /* already exited */ } };
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      kill();
      settle(new BridgeError('TIMEOUT', 'Codex exec deadline exceeded; external outcome uncertain'));
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
      settle(new BridgeError('TIMEOUT', 'Codex exec delivery was aborted; external outcome uncertain'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const settle = (error: BridgeError | null, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      if (error) rejectPromise(error); else resolvePromise(output ?? '');
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) { outputExceeded = true; kill(); settle(new BridgeError('EXECUTION', 'Codex exec output exceeded the receipt bound; outcome discarded')); return; }
      const text = decoder.write(chunk);
      stdout += text;
      if (options.onEvent) {
        eventBuffer += text;
        let newline: number;
        while ((newline = eventBuffer.indexOf('\n')) >= 0) {
          const line = eventBuffer.slice(0, newline); eventBuffer = eventBuffer.slice(newline + 1);
          let event: unknown;
          try { event = JSON.parse(safeText(line)); } catch { continue; }
          if (event && typeof event === 'object' && !Array.isArray(event)) {
            try { options.onEvent(event as Record<string, unknown>); }
            catch { kill(); settle(new BridgeError('EXECUTION', 'Codex event persistence failed; outcome requires reconciliation')); return; }
          }
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      // Drain private diagnostics without retaining or returning their contents.
      void chunk;
    });
    child.once('error', () => settle(new BridgeError('DEPENDENCY', 'Codex executable could not be started')));
    child.once('close', (code) => {
      stdout += decoder.end();
      if (deadlineExceeded) {
        settle(new BridgeError('TIMEOUT', 'Codex exec deadline exceeded; external outcome uncertain'));
        return;
      }
      if (aborted) {
        settle(new BridgeError('TIMEOUT', 'Codex exec delivery was aborted; external outcome uncertain'));
        return;
      }
      if (outputExceeded) {
        settle(new BridgeError('EXECUTION', 'Codex exec output exceeded the receipt bound; outcome discarded'));
        return;
      }
      if (code !== 0) {
        settle(new BridgeError('EXECUTION', `Codex exec failed with exit code ${code}; external outcome requires reconciliation`));
        return;
      }
      settle(null, stdout);
    });
    child.stdin?.once('error', () => { kill(); settle(new BridgeError('EXECUTION', 'Codex prompt input failed; external outcome uncertain')); });
    if (!child.stdin) { kill(); settle(new BridgeError('DEPENDENCY', 'Codex stdin transport is unavailable')); return; }
    child.stdin.end(options.content, 'utf8');
  });
}

/**
 * CodexDelivery 适配器：通过 codex CLI 后台执行投递，不操控真实窗口。
 * executionId 取 codex 回执中的稳定标识（thread id，缺失时 turn id）。
 */
export function createCodexExecDelivery(options: CodexExecDeliveryOptions = {}): CodexDelivery {
  const executable = resolveCodexExecutable(options);
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new BridgeError('CONFIG', 'Invalid codex exec timeout');
  }
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const resume = options.resume === true;
  return {
    async deliver(content, key, signal, target) {
      if (typeof content !== 'string' || !content.trim() || content.length > MAX_PROMPT_LENGTH) {
        throw new BridgeError('INPUT', 'Invalid prompt for codex exec delivery');
      }
      if (typeof key !== 'string' || !key.trim()) throw new BridgeError('INPUT', 'Codex exec delivery requires a stable prompt key');
      const workspace = (target as DeliveryTarget | null)?.workspacePath;
      if (typeof workspace !== 'string' || !workspace.trim()) {
        throw new BridgeError('INPUT', 'Codex exec delivery requires a resolved workspace path');
      }
      const resumeId = resume ? (target as DeliveryTarget).codexConversationId : null;
      if (resume && (typeof resumeId !== 'string' || !IDENTIFIER_PATTERN.test(resumeId))) {
        throw new BridgeError('INPUT', 'Resume delivery requires a codex conversation id');
      }
      // Workspace is a global option; the complete prompt is never in argv.
      const args = [
        '-C', workspace,
        'exec',
        ...(resumeId ? ['resume', resumeId] : []),
        '--json', '-',
      ];
      const stdout = await runCodexExec(spawnFn, executable, args, { timeoutMs, cwd: workspace, signal, content, onEvent: options.onEvent });
      const receipt = parseCodexExecReceipt(stdout);
      const executionId = receipt.threadId ?? receipt.turnId;
      if (!executionId) {
        throw new BridgeError('EXECUTION', 'Codex exec returned no stable thread or turn identifier');
      }
      if (receipt.failed || !receipt.completed) throw new BridgeError('EXECUTION', 'Codex did not report a completed turn; execution is not a delivery receipt');
      if (resumeId && receipt.threadId && receipt.threadId !== resumeId) throw new BridgeError('PROVENANCE', 'Codex resumed a different conversation');
      return {
        executionId,
        codexConversationId: receipt.threadId ?? undefined,
        workspacePath: workspace,
      };
    },
  };
}
