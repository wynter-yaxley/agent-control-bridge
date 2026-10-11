import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BridgeError, type ErrorCode } from './errors.ts';
import type { CodexDelivery, DeliveryTarget, ExecutionEvidence } from './prompts.ts';

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'INPUT', 'CONFIG', 'IPC_CONFIG', 'AUTH', 'OWNER', 'PROVENANCE', 'STATE', 'CONFLICT',
  'LEASE', 'NOT_FOUND', 'REVIEW', 'DB', 'SCHEMA', 'AGENT', 'DEPENDENCY', 'UNSUPPORTED',
  'TIMEOUT', 'EXECUTION', 'IO',
]);

function toErrorCode(code: string | undefined): ErrorCode {
  return code && KNOWN_ERROR_CODES.has(code) ? (code as ErrorCode) : 'EXECUTION';
}

/**
 * Authenticated desktop IPC (Node -> Windows Python Worker).
 *
 * 信任边界：一次性能力凭证只能由可信宿主（本模块，用 ACB_IPC_SECRET 共享密钥）
 * 签发。凭证不落日志、命令行或持久化配置。Python Worker 只验证签名、过期、
 * operation/binding 匹配与一次性 nonce，绝不信任调用者自报身份。
 */

export interface CapabilityPayload {
  operation: string;
  binding: string;
  taskId?: string;
  conversationId?: string;
  workspace?: string;
  promptHash?: string;
  forceClear?: boolean;
}

// 与 Python capability.py 的 canonical JSON 完全一致：key 按字母序、紧凑分隔、UTF-8。
function canonicalJson(body: Record<string, unknown>): string {
  const parts = Object.keys(body).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(body[k])}`);
  return `{${parts.join(',')}}`;
}

export function issueCapability(payload: CapabilityPayload, secret: string, ttlSeconds = 60): string {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new BridgeError('IPC_CONFIG', 'ACB_IPC_SECRET must be a >=32 char shared secret');
  }
  const body: Record<string, unknown> = {
    operation: payload.operation,
    binding: payload.binding,
    taskId: payload.taskId ?? null,
    conversationId: payload.conversationId ?? null,
    workspace: payload.workspace ?? null,
    promptHash: payload.promptHash ?? null,
    forceClear: payload.forceClear ?? false,
    nonce: randomUUID().replace(/-/g, ''),
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const data = canonicalJson(body);
  const sig = createHmac('sha256', secret).update(data, 'utf8').digest('hex');
  const b64 = Buffer.from(data, 'utf8').toString('base64url').replace(/=+$/, '');
  return `${b64}.${sig}`;
}

export interface WorkerRequest {
  requestId: string;
  operation: string;
  capability: string;
  binding: string;
  prompt?: string;
  targetContext?: Record<string, unknown>;
  forceClear?: boolean;
}

export interface WorkerResponse {
  status: 'success' | 'error';
  code?: string;
  message?: string;
  requestId?: string;
  [key: string]: unknown;
}

function callWorker(
  python: string,
  request: WorkerRequest,
  timeoutMs: number,
  cwd: string,
): Promise<WorkerResponse> {
  const script = resolve(cwd, 'tools', 'desktop', 'worker_ipc.py');
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(python, [script], { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new BridgeError('DEPENDENCY', 'Windows desktop worker could not be started'));
      return;
    }
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', () => { /* private worker diagnostics are not surfaced */ });
    child.once('error', () => { clearTimeout(timer); reject(new BridgeError('DEPENDENCY', 'Windows desktop worker could not be started')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new BridgeError('TIMEOUT', 'Desktop worker deadline exceeded; external outcome uncertain')); return; }
      if (code !== 0) { reject(new BridgeError('EXECUTION', 'Desktop worker failed closed')); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { reject(new BridgeError('EXECUTION', 'Desktop worker returned an unreadable response')); return; }
      resolvePromise(parsed as WorkerResponse);
    });
    child.stdin.on('error', () => { /* worker may have exited before reading */ });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

export function desktopWorkerSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.ACB_IPC_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new BridgeError('IPC_CONFIG', 'ACB_IPC_SECRET must be a >=32 char shared secret');
  }
  return secret;
}

export interface CodexDeliveryOptions {
  python: string;
  cwd: string;
  timeoutMs?: number;
  secret?: string;
  target?: (signal: AbortSignal) => Promise<DeliveryTarget>;
  preflight?: (target: DeliveryTarget, signal: AbortSignal) => Promise<ExecutionEvidence>;
  resolveTargetContext?: (target: DeliveryTarget) => Record<string, unknown>;
}

/**
 * CodexDelivery 适配器：通过受控 IPC 调用 Windows Python Worker 完成 codex_send。
 * 每个 deliver 调用签发一个一次性能力凭证，绑定 promptHash 与目标会话/workspace。
 */
export function createCodexDelivery(options: CodexDeliveryOptions): CodexDelivery {
  const timeoutMs = options.timeoutMs ?? 30000;
  const secret = options.secret ?? desktopWorkerSecret();
  return {
    target: options.target,
    preflight: options.preflight,
    async deliver(content, key, _signal, target) {
      if (!content.trim() || content.length > 65536) throw new BridgeError('INPUT', 'Invalid prompt for desktop delivery');
      const promptHash = createHash('sha256').update(content, 'utf8').digest('hex');
      const targetContext = options.resolveTargetContext ? options.resolveTargetContext(target as DeliveryTarget) : {};
      const binding = JSON.stringify({
        key,
        conversationId: (target as DeliveryTarget | null)?.codexConversationId ?? null,
        workspace: (target as DeliveryTarget | null)?.workspacePath ?? null,
        promptHash,
      });
      const capability = issueCapability({
        operation: 'codex_send',
        binding,
        promptHash,
        conversationId: (target as DeliveryTarget | null)?.codexConversationId ?? undefined,
        workspace: (target as DeliveryTarget | null)?.workspacePath ?? undefined,
      }, secret);
      const response = await callWorker(options.python, {
        requestId: randomUUID(),
        operation: 'codex_send',
        capability,
        binding,
        prompt: content,
        targetContext,
      }, timeoutMs, options.cwd);
      if (response.status !== 'success') {
        throw new BridgeError(toErrorCode(response.code), response.message ?? 'Desktop worker refused the operation');
      }
      return {
        executionId: String(response.requestId),
        codexConversationId: (target as DeliveryTarget | null)?.codexConversationId,
        workspacePath: (target as DeliveryTarget | null)?.workspacePath,
      };
    },
  };
}
