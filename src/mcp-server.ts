import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { DatabaseSync } from 'node:sqlite';
import { BackgroundBridge } from './background.ts';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { TaskStore } from './tasks.ts';
import { BridgeError, classifyError } from './errors.ts';
import { enqueueNotification } from './outbox.ts';
import { transaction, now } from './db.ts';

const identifier = z.string().min(1).max(4096);
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
export function createBridgeMcpServer(options: { bridge: BackgroundBridge; db: DatabaseSync; authority: CallerAuthority; context: CallerContext; notificationLeaseMs: number; version: string }): McpServer {
  const { bridge, db, authority, context } = options;
  bridge.assertCallerContext(context);
  const server = new McpServer({ name: 'agent-control-bridge', version: options.version });
  const execute = async (operation: () => unknown | Promise<unknown>) => {
    try { return result(await operation()); }
    catch (error) { const failure = classifyError(error); return { ...result({ ok: false, code: failure.code, message: failure.message }), isError: true }; }
  };
  server.registerTool('acb_capabilities', { description: 'Report installed host capabilities and unresolved full-workflow blockers.', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => execute(() => bridge.capabilities()));
  server.registerTool('acb_codex_target_check', { description: 'Read this controller’s registered Codex thread through the official app-server. Reports actual workspace and canonical assignment checks; never resumes a thread, starts a model turn or authorizes execution.', inputSchema: z.object({ projectId: identifier, conversationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.inspectCodexTarget(args.projectId, args.conversationId)));
  server.registerTool('acb_native_target_check', { description: 'Read this controller/project’s registered Codex carrier and paired GPT through the Windows desktop interface. Reports identity/title readback only; cannot send messages, create chats, prove generation parameters or authorize execution.', inputSchema: z.object({ projectId: identifier, conversationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.inspectNativeTarget(args.projectId, args.conversationId)));
  server.registerTool('acb_project_prepare', { description: 'Provision an isolated workspace, same-name ordinary GPT and Codex chat through an authorized host. Missing host returns BLOCKED; never opens a browser.', inputSchema: z.object({ name: z.string().min(1).max(100), eventKey: identifier }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.projects.prepare(args.name, args.eventKey, context)));
  server.registerTool('acb_project_get', { description: 'Read this controller’s project operation.', inputSchema: z.object({ operationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.projects.get(args.operationId, context)));
  server.registerTool('acb_project_reconcile', { description: 'Read back a complete recorded uncertain bundle and register it only after host verification. Never creates replacement resources or accepts caller-supplied IDs.', inputSchema: z.object({ operationId: identifier }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.projects.reconcile(args.operationId, context)));
  server.registerTool('acb_request_submit', { description: 'Queue a requirement for the project’s ordinary GPT. This input never authorizes engineering execution as a Prompt.', inputSchema: z.object({ eventKey: identifier, projectId: identifier, title: z.string().min(1).max(4096), requirement: z.string().min(1).max(65536), priority: z.number().int().safe().optional() }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.submit(args)));
  server.registerTool('acb_request_get', { description: 'Read this controller’s request, actual task state and attempt.', inputSchema: z.object({ requestId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.get(args.requestId)));
  server.registerTool('acb_request_retry', { description: 'Explicitly requeue a blocked request with no uncertain external operation. Unknown outcomes cannot be retried.', inputSchema: z.object({ requestId: identifier }).strict() }, args => execute(() => bridge.retryBlocked(args.requestId)));
  server.registerTool('acb_notifications_pull', { description: 'Lease pending notifications for this controller. Pulling does not mean Feishu delivery.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(), annotations: { readOnlyHint: false } }, args => execute(() => bridge.outbox.pull(context, args.limit, options.notificationLeaseMs)));
  server.registerTool('acb_notifications_status', { description: 'Read notification counts and fenced delivery IDs; unknown sends require reconciliation and are not replayed.', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => execute(() => bridge.outbox.status(context)));
  server.registerTool('acb_notifications_ack', { description: 'Confirm external delivery using the actual Feishu message receipt; only the current notification holder can acknowledge.', inputSchema: z.object({ notificationId: identifier, receiptId: identifier }).strict() }, args => execute(() => { bridge.outbox.acknowledge(args.notificationId, args.receiptId, context); return { acknowledged: true }; }));
  server.registerTool('acb_review_submit', { description: 'Submit independent acceptance. Role text cannot grant authorization; the executor cannot review itself.', inputSchema: z.object({ taskId: identifier, expectedVersion: z.number().int().min(0), pass: z.boolean(), reason: z.string().max(65536).optional() }).strict() }, args => execute(() => transaction(db, () => {
    const review = new TaskStore(db, authority).verify(args.taskId, context, args.pass, args.reason, args.expectedVersion);
    if (!review.ok) throw new BridgeError(review.code as import('./errors.ts').ErrorCode, review.error);
    const request = db.prepare('SELECT id,principal FROM background_requests WHERE task_id=?').get(args.taskId);
    if (request) enqueueNotification(db, String(request.principal), `review:${args.taskId}:${review.task.version}`, { requestId: request.id, taskId: args.taskId, state: review.task.status, observedAt: now() });
    return { taskId: args.taskId, status: review.task.status, version: review.task.version };
  })));
  return server;
}
