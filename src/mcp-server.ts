import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { DatabaseSync } from 'node:sqlite';
import { BackgroundBridge } from './background.ts';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { TaskStore } from './tasks.ts';
import { BridgeError, classifyError, EXIT_CODES, type ErrorCode } from './errors.ts';
import { enqueueNotification } from './outbox.ts';
import { transaction, now } from './db.ts';
import { pendingApprovals } from './trusted-host.ts';

const identifier = z.string().min(1).max(4096);
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
export function createBridgeMcpServer(options: { bridge: BackgroundBridge; db: DatabaseSync; authority: CallerAuthority; context: CallerContext; notificationLeaseMs: number; version: string; readOnly?: boolean }): McpServer {
  const { bridge, db, authority, context } = options;
  bridge.assertCallerContext(context);
  const server = new McpServer({ name: 'agent-control-bridge', version: options.version });
  const active=new Set<Promise<unknown>>();
  const closeTransport=server.close.bind(server);
  server.close=async()=>{await closeTransport();await Promise.allSettled([...active]);};
  const execute = (operation: () => unknown | Promise<unknown>) => {
    const pending=(async()=>{
      try { return result(await operation()); }
      catch (error) { const failure = classifyError(error); return { ...result({ ok: false, code: failure.code, message: failure.message }), isError: true }; }
    })();
    active.add(pending);void pending.finally(()=>active.delete(pending));return pending;
  };
  server.registerTool('acb_capabilities', { description: 'Check installed hosts, blockers and UI requirements before starting work.', inputSchema: z.object({projectId:identifier.optional(),conversationId:identifier.optional()}).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.capabilities(args.projectId && args.conversationId ? {projectId:args.projectId,conversationId:args.conversationId}:undefined)));
  server.registerTool('acb_codex_target_check', { description: 'Read registered Codex identity, workspace and project via App Server. No execution.', inputSchema: z.object({ projectId: identifier, conversationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.inspectCodexTarget(args.projectId, args.conversationId)));
  server.registerTool('acb_native_target_check', { description: 'Read registered native Codex/GPT identities. No send or creation.', inputSchema: z.object({ projectId: identifier, conversationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.inspectNativeTarget(args.projectId, args.conversationId)));
  server.registerTool('acb_gpt_read', { description: 'Read existing GPT via CDP; fall back to UIA titleOnly. No navigation or write authority.', inputSchema: z.object({ projectId: identifier, conversationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.readGptMessages(args.projectId, args.conversationId)));
  server.registerTool('acb_project_get', { description: 'Read project state and recorded resource IDs.', inputSchema: z.object({ operationId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.projects.get(args.operationId, context)));
  server.registerTool('acb_request_get', { description: 'Read request state, attempt, version and last event. Prefer notifications over repeated polling.', inputSchema: z.object({ requestId: identifier }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => bridge.get(args.requestId)));
  server.registerTool('acb_execution_result', { description: 'Read saved result/feedback summaries; includeContent returns complete evidence.', inputSchema: z.object({ requestId: identifier, includeContent: z.boolean().optional() }).strict(), annotations: { readOnlyHint: true } }, args => execute(() => {
    const saved = bridge.executionResult(args.requestId);
    if (args.includeContent) return saved;
    return { ...saved,
      output: saved.output ? { messageIds: saved.output.messageIds, hash: saved.output.hash, characters: saved.output.content.length } : null,
      feedback: saved.feedback ? { sourceConversationId: saved.feedback.sourceConversationId, sourceMessageId: saved.feedback.sourceMessageId,
        hash: saved.feedback.hash, characters: saved.feedback.content.length, actualModel: saved.feedback.actualModel, actualReasoningEffort: saved.feedback.actualReasoningEffort } : null };
  }));
  server.registerTool('acb_notifications_status', { description: 'Read notification counts and unresolved deliveries.', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => execute(() => bridge.outbox.status(context)));
  if (!options.readOnly) {
  server.registerTool('acb_project_default_codex',{description:'Select an already registered default Codex conversation for this workspace.',inputSchema:z.object({projectId:identifier,conversationId:identifier}).strict()},args=>execute(()=>{bridge.setDefaultCodex(args.projectId,args.conversationId);return {updated:true};}));
  server.registerTool('acb_project_prepare', { description: 'Create native workspace, same-name GPT and 1-4 Codex conversations with host approval. UIA may change the page.', inputSchema: z.object({ name: z.string().min(1).max(100), eventKey: identifier, codexConversations: z.number().int().min(1).max(4).optional() }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.projects.prepare(args.name, args.eventKey, context, { codexConversations: args.codexConversations })));
  server.registerTool('acb_project_attach_codex', { description: 'Attach an operator-created Codex conversation to an operation waiting in codex.attach after native readback of its workspace, directory and type.', inputSchema: z.object({ operationId: identifier, codexConversationId: identifier }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.projects.attachCodex(args.operationId, args.codexConversationId, context)));
  server.registerTool('acb_project_restart_workspace', { description: 'Explicitly retry only the native workspace step of an uncertain operation after verifying no native workspace exists for its own empty directory. Audited, at most twice.', inputSchema: z.object({ operationId: identifier }).strict(), annotations: { readOnlyHint: false } }, args => execute(() => bridge.projects.restartWorkspace(args.operationId, context)));
  server.registerTool('acb_project_adopt', { description: 'Re-bind a migrated project after native readback of its recorded GPT/Codex IDs. Grants nothing on mismatch.', inputSchema: z.object({ projectId: identifier }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.projects.adopt(args.projectId, context)));
  server.registerTool('acb_approvals_pending', { description: 'List pending Codex command/file approvals with their bound run, thread, turn and scope.', inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, () => execute(() => pendingApprovals(db, authority, context)));
  server.registerTool('acb_approval_decide', { description: 'Independent reviewer decides one pending approval. Requesters and controllers are refused.', inputSchema: z.object({ approvalId: identifier, decision: z.enum(['approved', 'rejected']), reason: z.string().max(4096).optional() }).strict() }, args => execute(() => {
    // TaskStore rejections carry ledger codes; keep them instead of a generic IO failure.
    try { new TaskStore(db, authority).decideApproval(args.approvalId, args.decision, context, args.reason); }
    catch (error) { const code = (error as { code?: unknown }).code; if (error instanceof Error && typeof code === 'string' && Object.hasOwn(EXIT_CODES, code)) throw new BridgeError(code as ErrorCode, error.message); throw error; }
    return { approvalId: args.approvalId, decision: args.decision };
  }));
  server.registerTool('acb_project_reconcile', { description: 'Verify the original uncertain project bundle without creating replacements.', inputSchema: z.object({ operationId: identifier }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.projects.reconcile(args.operationId, context)));
  server.registerTool('acb_request_submit', { description: 'Queue a requirement for GPT; the bridge verifies and executes its Prompt.', inputSchema: z.object({ eventKey: identifier, projectId: identifier, title: z.string().min(1).max(4096), requirement: z.string().min(1).max(65536), priority: z.number().int().safe().optional(), codexConversationId:identifier.optional() }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.submit(args)));
  server.registerTool('acb_execution_review', { description: 'Send the saved result to registered GPT once with host approval. GPT review is not acceptance.', inputSchema: z.object({ requestId: identifier }).strict(), annotations: { readOnlyHint: false, idempotentHint: true } }, args => execute(() => bridge.reviewExecution(args.requestId)));
  server.registerTool('acb_request_retry', { description: 'Requeue BLOCKED work only when no external outcome is uncertain.', inputSchema: z.object({ requestId: identifier }).strict() }, args => execute(() => bridge.retryBlocked(args.requestId)));
  server.registerTool('acb_request_reconcile_generation', { description: 'Recover the original GPT generation by reading its complete reply; never resend.', inputSchema: z.object({ requestId: identifier }).strict(), annotations: {readOnlyHint:false} }, args=>execute(()=>bridge.reconcileGeneration(args.requestId)));
  server.registerTool('acb_request_reconcile_execution', { description: 'Recover the original Codex receipt, then return it to GPT. Never rerun engineering.', inputSchema: z.object({requestId:identifier}).strict(), annotations:{readOnlyHint:false} },args=>execute(()=>bridge.reconcileExecution(args.requestId)));
  server.registerTool('acb_execution_reconcile_feedback',{description:'Read original pending GPT feedback without resending the result.',inputSchema:z.object({requestId:identifier}).strict(),annotations:{readOnlyHint:false}},args=>execute(()=>bridge.reconcileFeedback(args.requestId)));
  server.registerTool('acb_notifications_pull', { description: 'Lease pending notifications; delivery still needs a real external receipt.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict(), annotations: { readOnlyHint: false } }, args => execute(() => bridge.outbox.pull(context, args.limit, options.notificationLeaseMs)));
  server.registerTool('acb_notifications_ack', { description: 'Acknowledge delivered notification with its actual external message receipt.', inputSchema: z.object({ notificationId: identifier, receiptId: identifier }).strict() }, args => execute(() => { bridge.outbox.acknowledge(args.notificationId, args.receiptId, context); return { acknowledged: true }; }));
  server.registerTool('acb_review_submit', { description: 'Submit independent acceptance with the expected version. Executor self-review is refused.', inputSchema: z.object({ taskId: identifier, expectedVersion: z.number().int().min(0), pass: z.boolean(), reason: z.string().max(65536).optional() }).strict() }, args => execute(() => transaction(db, () => {
    const review = new TaskStore(db, authority).verify(args.taskId, context, args.pass, args.reason, args.expectedVersion);
    if (!review.ok) throw new BridgeError(review.code as import('./errors.ts').ErrorCode, review.error);
    const request = db.prepare('SELECT id,principal FROM background_requests WHERE task_id=?').get(args.taskId);
    if (request) enqueueNotification(db, String(request.principal), `review:${args.taskId}:${review.task.version}`, { requestId: request.id, taskId: args.taskId, state: review.task.status, observedAt: now() });
    return { taskId: args.taskId, status: review.task.status, version: review.task.version };
  })));
  }
  return server;
}
