import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, resolve, win32, join, dirname, basename } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BridgeError } from './errors.ts';
import { controlledProcessEnv } from './silent-process.ts';
import { requireNoSecrets } from './security.ts';
import type { DeliveryTarget } from './prompts.ts';
import type { BackgroundExecutor } from './background-runner.ts';

const ID = /^[a-zA-Z0-9_-]{1,200}$/;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new BridgeError('PROVENANCE', 'App-server returned an invalid identity');
  return value;
}
function pathKey(value: string): string {
  if (!isAbsolute(value) && !win32.isAbsolute(value)) throw new BridgeError('PROVENANCE', 'App-server workspace must be absolute');
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(value) ? win32.normalize(value).toLowerCase() : resolve(value);
}
function assertResumeSandbox(result: Row, workspace: string): void {
  const sandbox = row(result.sandbox), base = pathKey(workspace);
  const separator = /^[a-zA-Z]:[\\/]|^\\\\/.test(workspace) ? '\\' : '/';
  const prefix = base.endsWith(separator) ? base : base + separator;
  const roots = sandbox?.writableRoots;
  if (result.approvalPolicy !== 'untrusted' || sandbox?.type !== 'workspaceWrite' || sandbox.networkAccess !== false || !Array.isArray(roots) ||
      !roots.some(value => typeof value === 'string' && pathKey(value) === base) ||
      roots.some(value => typeof value !== 'string' || (pathKey(value) !== base && !pathKey(value).startsWith(prefix)))) {
    throw new BridgeError('PROVENANCE', 'App-server returned a broader sandbox or approval policy');
  }
}
export interface CodexThreadSummary {
  conversationId: string; appProjectId: string | null; workspacePath: string;
  status: 'notLoaded' | 'idle' | 'active' | 'systemError'; local: boolean;
}
interface ClientOptions { executable: string; timeoutMs: number; spawnFn?: typeof nodeSpawn; disabledServerName?: string }
interface IsolatedClientOptions extends ClientOptions { ownedHome?: string; ownedCwd?: string; metadataOnly?: boolean }
interface Pending { resolve: (value: Row) => void; reject: (error: BridgeError) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void }
class AppServerRpcError extends BridgeError {
  readonly rpcCode: number | null;
  constructor(error: unknown) {
    super('EXECUTION', 'App-server rejected the request; private diagnostics omitted');
    const code = row(error)?.code;
    this.rpcCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
  }
}

/** A private, owned stdio process. It never connects to the live desktop process,
 * opens a browser, reads auth files, or grants interactive server requests. */
class AppServerConnection {
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private failure?: BridgeError;
  private exited = false;
  private buffer = '';
  private bytes = 0;
  private decoder = new StringDecoder('utf8');
  notification?: (method: string, params: Row) => void;
  serverRequest?: () => void;
  disconnected?: (error: BridgeError) => void;
  constructor(options: IsolatedClientOptions) {
    if (typeof options.executable !== 'string' || !options.executable.trim() || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600000) throw new BridgeError('CONFIG', 'Invalid app-server transport configuration');
    if (options.disabledServerName !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(options.disabledServerName)) throw new BridgeError('CONFIG', 'Invalid bridge MCP server name');
    this.timeoutMs = options.timeoutMs;
    try {
      this.child = (options.spawnFn ?? nodeSpawn)(options.executable, [
        // An owned diagnostic home has no user plugin settings. Prevent default
        // catalog clones/background plugin helpers from racing its cleanup.
        ...(options.ownedHome || options.metadataOnly ? ['--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps'] : []),
        ...(options.disabledServerName ? ['-c', `mcp_servers.${options.disabledServerName}.enabled=false`] : []),
        'app-server', '--listen', 'stdio://',
      ], {
        shell: false, windowsHide: true, cwd: options.ownedCwd,
        env: { ...controlledProcessEnv(), ...(options.ownedHome ? { CODEX_HOME: options.ownedHome } : {}) }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { throw new BridgeError('DEPENDENCY', 'Codex app-server could not start'); }
    this.child.once('error', () => this.fail(new BridgeError('DEPENDENCY', 'Codex app-server could not start')));
    this.child.once('exit', () => { this.exited = true; });
    this.child.once('close', () => { this.exited = true; this.fail(new BridgeError('EXECUTION', 'App-server disconnected; external outcome requires reconciliation')); });
    this.child.stdin?.on('error', () => this.fail(new BridgeError('IO', 'App-server input failed; external outcome requires reconciliation')));
    this.child.stderr?.on('data', () => { /* Drain private diagnostics without retaining them. */ });
    this.child.stdout?.on('data', (data: Buffer) => this.receive(data));
  }
  private fail(error: BridgeError): void {
    if (this.failure) return;
    this.failure = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(error); }
    this.pending.clear(); this.buffer = '';
    this.disconnected?.(error);
    try { this.child.stdin?.end(); } catch { /* Owned transport may already be closed. */ }
    try { if (!this.exited && this.child.exitCode == null && this.child.signalCode == null) this.child.kill(); } catch { /* Never terminate any existing application. */ }
    // Close only our transport handles; helper-inherited output handles must not
    // keep the diagnostic parent alive after its owned process has terminated.
    this.child.stdout?.destroy?.(); this.child.stderr?.destroy?.();
  }
  close(): void { this.fail(new BridgeError('IO', 'Owned app-server connection closed')); }
  async closeAndWait(): Promise<boolean> {
    if (this.exited || this.child.exitCode != null || this.child.signalCode != null) { this.close(); return true; }
    return new Promise(resolveClosed => {
      // Inherited helper output handles can delay `close` after this owned
      // process has exited. Wait for its process exit, not private stderr EOF.
      const timer = setTimeout(() => { clearTimeout(force); this.child.removeListener('exit', closed); this.child.removeListener('close', closed); resolveClosed(false); }, 5000);
      const closed = () => { clearTimeout(timer); clearTimeout(force); this.child.removeListener('exit', closed); this.child.removeListener('close', closed); this.close(); resolveClosed(true); };
      // Let the owned server release its SQLite and helper handles on EOF before
      // bounded termination. Never signal an existing desktop process.
      const force = setTimeout(() => this.close(), 250);
      this.child.once('exit', closed); this.child.once('close', closed);
      try { this.child.stdin?.end(); } catch { this.close(); }
    });
  }
  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.child.stdin) throw new BridgeError('DEPENDENCY', 'App-server stdin is unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private receive(data: Buffer): void {
    if (this.failure) return;
    this.bytes += data.length;
    if (this.bytes > 16 * 1024 * 1024) { this.fail(new BridgeError('EXECUTION', 'App-server output exceeded its finite bound')); return; }
    this.buffer += this.decoder.write(data);
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) {
        if (Buffer.byteLength(this.buffer) > 1024 * 1024) this.fail(new BridgeError('EXECUTION', 'App-server frame exceeded its finite bound'));
        return;
      }
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) { this.fail(new BridgeError('EXECUTION', 'App-server frame exceeded its finite bound')); return; }
      let message: Row | null;
      try { message = row(JSON.parse(line)); } catch { message = null; }
      if (!message) { this.fail(new BridgeError('EXECUTION', 'Invalid app-server frame')); return; }
      try {
        if (typeof message.method === 'string') {
          if (message.id !== undefined) {
            // Return an error, never an approval, token refresh, login, or tool result.
            if (typeof message.id !== 'string' && typeof message.id !== 'number') throw new BridgeError('EXECUTION', 'Invalid server request identity');
            this.write({ id: message.id, error: { code: -32601, message: 'Interactive server requests are not installed' } });
            if (this.serverRequest) this.serverRequest(); else this.fail(new BridgeError('AUTH', 'App-server requires an interactive host'));
          } else this.notification?.(message.method, row(message.params) ?? {});
        } else {
          if (typeof message.id !== 'number' || !this.pending.has(message.id)) throw new BridgeError('EXECUTION', 'Unexpected app-server response identity');
          const item = this.pending.get(message.id)!; this.pending.delete(message.id);
          clearTimeout(item.timer); item.cleanup();
          const result = row(message.result);
          if (message.error || !result) item.reject(new AppServerRpcError(message.error));
          else item.resolve(result);
        }
      } catch (error) { this.fail(error instanceof BridgeError ? error : new BridgeError('IO', 'App-server event processing failed')); return; }
      if (this.failure) return;
    }
  }
  // This is intentionally private to this module, not an arbitrary RPC MCP tool.
  request(method: 'initialize' | 'model/list' | 'project/create' | 'project/read' | 'project/list' | 'thread/start' | 'thread/name/set' | 'thread/read' | 'thread/list' | 'thread/resume' | 'turn/start' | 'turn/interrupt', params: Row, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<Row> {
    if (signal?.aborted) return Promise.reject(new BridgeError('TIMEOUT', 'App-server request aborted before dispatch'));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolvePromise, rejectPromise) => {
      const id = ++this.sequence;
      const abort = () => this.fail(new BridgeError('TIMEOUT', 'App-server request aborted; external outcome requires reconciliation'));
      const timer = setTimeout(() => this.fail(new BridgeError('TIMEOUT', 'App-server request deadline exceeded; external outcome requires reconciliation')), timeoutMs);
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.write({ id, method, params }); } catch (error) { this.fail(error instanceof BridgeError ? error : new BridgeError('IO', 'App-server dispatch failed')); }
    });
  }
  async initialize(signal?: AbortSignal, experimentalApi = false): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'agent_control_bridge', title: 'Agent Control Bridge', version: '0.2.0' }, ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}) }, signal);
    this.write({ method: 'initialized', params: {} });
  }
}
function summary(result: Row, expectedId: string): CodexThreadSummary {
  const thread = row(result.thread), status = row(thread?.status)?.type;
  if (!thread || identifier(thread.id) !== expectedId || typeof thread.cwd !== 'string' || !['notLoaded', 'idle', 'active', 'systemError'].includes(String(status))) throw new BridgeError('PROVENANCE', 'App-server thread readback is incomplete or mismatched');
  pathKey(thread.cwd);
  const appProjectId = thread.projectId == null ? null : identifier(thread.projectId);
  return { conversationId: expectedId, appProjectId, workspacePath: thread.cwd, status: status as CodexThreadSummary['status'], local: ['cli', 'vscode', 'exec', 'appServer'].includes(String(thread.source)) };
}
export async function inspectCodexThread(options: ClientOptions & { conversationId: string; signal?: AbortSignal }): Promise<CodexThreadSummary> {
  const id = identifier(options.conversationId);
  if (options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Inspection aborted before process launch');
  const connection = new AppServerConnection({ ...options, metadataOnly: true });
  try {
    // Canonical projectId is an experimental response field in this protocol.
    await connection.initialize(options.signal, true);
    return summary(await connection.request('thread/read', { threadId: id, includeTurns: false }, options.signal), id);
  } finally { connection.close(); }
}

export interface CodexProvisioningCheck {
  ok: boolean; code: string; stage: 'catalog' | 'create' | 'name' | 'readback' | 'stored-readback' | 'stored-listing' | 'complete';
  checks: { model: string; reasoningEffort: string; sameWorkspace: boolean; created: boolean; readback: boolean; settingsMatch: boolean; codexTitleSet: boolean; persisted: boolean; storedSettingsMatch: boolean; storedModel: string | null; storedReasoningEffort: string | null }[];
  listingChecks: { sameWorkspace: boolean; expectedCount: number; observedCount: number; identitiesMatch: boolean; workspaceMatches: boolean }[];
  sourceKinds: string[]; ownedProcessExitConfirmed: boolean; cleanupCode: string | null;
  differentModelsVerified: boolean; differentEffortsVerified: boolean;
  uniqueConversationIds: boolean; crossWorkspaceIsolationVerified: boolean; storedListingIsolationVerified: boolean;
  isolatedHome: true; temporaryResourcesRemoved: boolean;
  retainedTemporaryDirectory: string | null;
  listingsSkipped: boolean;
  modelAccessVerified: false; nativeWorkspaceBindingVerified: false;
  ordinaryGptCreationVerified: false; fullWorkflowReady: false;
  realModelInvoked: false; businessDatabaseOpened: false; credentialsRead: false;
}

/** Creates dormant threads only in a new, owned Codex home. This is a diagnostic,
 * never a production project host; no turn/start, copied login, or desktop write. */
export async function checkCodexProvisioning(options: ClientOptions & { signal?: AbortSignal; nameDormantThreads?: boolean; skipListings?: boolean }): Promise<CodexProvisioningCheck> {
  if (typeof options.executable !== 'string' || !options.executable.trim() || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) throw new BridgeError('CONFIG', 'Invalid provisioning diagnostic configuration');
  if (options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Provisioning diagnostic aborted before resource creation');
  const result: CodexProvisioningCheck = { ok: false, code: 'UNSUPPORTED', stage: 'catalog', checks: [], listingChecks: [], sourceKinds: [], ownedProcessExitConfirmed: false, cleanupCode: null, differentModelsVerified: false, differentEffortsVerified: false,
    uniqueConversationIds: false, crossWorkspaceIsolationVerified: false, storedListingIsolationVerified: false, isolatedHome: true, temporaryResourcesRemoved: false, retainedTemporaryDirectory: null, listingsSkipped: options.skipListings === true,
    modelAccessVerified: false, nativeWorkspaceBindingVerified: false, ordinaryGptCreationVerified: false, fullWorkflowReady: false,
    realModelInvoked: false, businessDatabaseOpened: false, credentialsRead: false };
  const temporaryParent = realpathSync.native(tmpdir()), root = mkdtempSync(join(temporaryParent, 'acb-codex-provision-'));
  const home = join(root, 'codex-home'), firstWorkspace = join(root, 'workspace-a'), secondWorkspace = join(root, 'workspace-b');
  let connection: AppServerConnection | undefined, cleanupSafe = true;
  const deadline = Date.now() + options.timeoutMs, identities = new Set<string>();
  const remaining = () => { const value = deadline - Date.now(); if (value < 1 || options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Provisioning diagnostic deadline exceeded'); return value; };
  const connect = async () => {
    connection = new AppServerConnection({ ...options, timeoutMs: remaining(), ownedHome: home, ownedCwd: root });
    connection.notification = method => { if (method.startsWith('turn/') || method.startsWith('item/')) throw new BridgeError('EXECUTION', 'Unexpected agent activity during dormant-thread diagnostic'); };
    await connection.initialize(options.signal); return connection;
  };
  try {
    writeFileSync(join(root, 'acb-probe-owner.json'), JSON.stringify({ purpose: 'isolated-codex-provisioning-diagnostic', createdAt: new Date().toISOString(), directory: basename(root) }), { flag: 'wx', mode: 0o600 });
    for (const path of [home, firstWorkspace, secondWorkspace]) mkdirSync(path, { mode: 0o700 });
    let client = await connect();
    const catalog = await client.request('model/list', { limit: 100, includeHidden: false }, options.signal, remaining());
    if (!Array.isArray(catalog.data) || catalog.data.length > 100 || catalog.nextCursor != null) throw new BridgeError('UNSUPPORTED', 'A complete bounded model catalog is required');
    const models = catalog.data.map(row).filter((entry): entry is Row => !!entry && typeof entry.model === 'string' && /^gpt-[a-z0-9.-]{1,100}$/i.test(entry.model)).map(entry => ({
      model: String(entry.model), efforts: Array.isArray(entry.supportedReasoningEfforts) ? [...new Set(entry.supportedReasoningEfforts.map(row).flatMap(e => typeof e?.reasoningEffort === 'string' && EFFORTS.includes(e.reasoningEffort) ? [e.reasoningEffort] : []))] : [],
    }));
    const first = models.find(entry => entry.efforts.length >= 2), second = models.find(entry => entry.model !== first?.model && entry.efforts.length >= 1);
    if (!first || !second) throw new BridgeError('UNSUPPORTED', 'Two models and two effort choices are required for this diagnostic');
    const cases = [
      { model: first.model, effort: first.efforts[0]!, workspace: firstWorkspace },
      { model: first.model, effort: first.efforts.at(-1)!, workspace: firstWorkspace },
      { model: second.model, effort: second.efforts[0]!, workspace: firstWorkspace },
      { model: first.model, effort: first.efforts[0]!, workspace: secondWorkspace },
    ];
    const created: { id: string; workspace: string; source?: string }[] = [];
    for (const item of cases) {
      result.stage = 'create';
      const evidence = { model: item.model, reasoningEffort: item.effort, sameWorkspace: item.workspace === firstWorkspace, created: false, readback: false, settingsMatch: false, codexTitleSet: false, persisted: false, storedSettingsMatch: false, storedModel: null as string | null, storedReasoningEffort: null as string | null };
      result.checks.push(evidence);
      const start = await client.request('thread/start', { model: item.model, cwd: item.workspace, approvalPolicy: 'untrusted', sandbox: 'read-only', ephemeral: false,
        config: { model_reasoning_effort: item.effort } }, options.signal, remaining());
      const thread = row(start.thread), id = identifier(thread?.id);
      if (identities.has(id)) throw new BridgeError('PROVENANCE', 'Codex reused a conversation identity');
      identities.add(id); created.push({ id, workspace: item.workspace }); evidence.created = true;
      if (thread?.ephemeral !== false || start.model !== item.model || start.reasoningEffort !== item.effort ||
          typeof start.cwd !== 'string' || pathKey(start.cwd) !== pathKey(item.workspace) || start.approvalPolicy !== 'untrusted' || row(start.sandbox)?.type !== 'readOnly') throw new BridgeError('PROVENANCE', 'Created Codex settings did not match the request');
      evidence.settingsMatch = true;
      if (options.nameDormantThreads) {
        result.stage = 'name';
        await client.request('thread/name/set', { threadId: id, name: `Isolated ACB probe ${created.length}` }, options.signal, remaining());
        evidence.codexTitleSet = true;
      }
      result.stage = 'readback';
      const observed = await client.request('thread/read', { threadId: id, includeTurns: false }, options.signal, remaining());
      const read = summary(observed, id);
      if (pathKey(read.workspacePath) !== pathKey(item.workspace) || read.status !== 'idle' || !read.local) throw new BridgeError('PROVENANCE', 'Created Codex thread readback mismatched');
      evidence.readback = true;
      const source = row(observed.thread)?.source;
      if (typeof source !== 'string' || !['cli', 'vscode', 'exec', 'appServer'].includes(source)) throw new BridgeError('PROVENANCE', 'Created Codex source kind is unknown');
      created.at(-1)!.source = source;
    }
    result.uniqueConversationIds = identities.size === 4; result.crossWorkspaceIsolationVerified = true;
    result.sourceKinds = [...new Set(created.map(item => item.source!))];
    result.differentModelsVerified = true; result.differentEffortsVerified = true;
    // A second connection proves storage/readback independently of the start receipt.
    cleanupSafe = await client.closeAndWait(); connection = undefined;
    if (!cleanupSafe) throw new BridgeError('IO', 'Owned diagnostic process did not confirm exit');
    client = await connect();
    result.stage = 'stored-readback';
    for (let index = 0; index < created.length; index++) {
      const item = created[index]!, read = summary(await client.request('thread/read', { threadId: item.id, includeTurns: false }, options.signal, remaining()), item.id);
      if (pathKey(read.workspacePath) !== pathKey(item.workspace) || !read.local || !['notLoaded', 'idle'].includes(read.status)) throw new BridgeError('PROVENANCE', 'Persisted Codex identity or workspace mismatched');
      result.checks[index]!.persisted = true;
      // Resume without overrides so the receipt describes stored settings,
      // rather than echoing a freshly requested model or effort.
      const resumed = await client.request('thread/resume', { threadId: item.id }, options.signal, remaining());
      const actual = summary(resumed, item.id), expected = result.checks[index]!;
      expected.storedModel = typeof resumed.model === 'string' && /^gpt-[a-z0-9.-]{1,100}$/i.test(resumed.model) ? resumed.model : null;
      expected.storedReasoningEffort = typeof resumed.reasoningEffort === 'string' && EFFORTS.includes(resumed.reasoningEffort) ? resumed.reasoningEffort : null;
      if (actual.status !== 'idle' || pathKey(actual.workspacePath) !== pathKey(item.workspace) || resumed.model !== expected.model || resumed.reasoningEffort !== expected.reasoningEffort) throw new BridgeError('PROVENANCE', 'Persisted Codex model or effort mismatched');
      expected.storedSettingsMatch = true;
    }
    if (options.skipListings) { result.code = 'PARTIAL'; return result; }
    result.stage = 'stored-listing';
    for (const workspace of [firstWorkspace, secondWorkspace]) {
      // Zero-turn named rollouts may exist before their state index is populated.
      // The documented scan/reconcile path operates only in this owned test home.
      const listing = await client.request('thread/list', { cwd: workspace, sourceKinds: [...new Set(created.map(item => item.source!))], useStateDbOnly: false, limit: 10 }, options.signal, remaining());
      if (!Array.isArray(listing.data) || listing.nextCursor != null) throw new BridgeError('PROVENANCE', 'Isolated Codex listing is incomplete');
      const observed = listing.data.map(row), expected = created.filter(item => item.workspace === workspace).map(item => item.id);
      const identitiesMatch = observed.length === expected.length && observed.every(item => !!item && expected.includes(String(item.id))) && new Set(observed.map(item => item?.id)).size === expected.length;
      const workspaceMatches = observed.every(item => !!item && typeof item.cwd === 'string' && pathKey(item.cwd) === pathKey(workspace));
      result.listingChecks.push({ sameWorkspace: workspace === firstWorkspace, expectedCount: expected.length, observedCount: observed.length, identitiesMatch, workspaceMatches });
      if (!identitiesMatch || !workspaceMatches) throw new BridgeError('PROVENANCE', 'Codex listing mixed workspace identities');
    }
    result.storedListingIsolationVerified = true; result.ok = true; result.code = 'OK'; result.stage = 'complete';
  } catch (error) { result.ok = false; result.code = error instanceof BridgeError ? error.code : 'IO'; }
  finally {
    if (connection) cleanupSafe = await connection.closeAndWait() && cleanupSafe;
    result.ownedProcessExitConfirmed = cleanupSafe;
    // Only the exact mkdtemp directory owned by this call, under its checked parent.
    if (cleanupSafe && dirname(root) === temporaryParent && realpathSync.native(root) === root) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); result.temporaryResourcesRemoved = !existsSync(root); }
      catch (error) { const code = row(error)?.code; result.cleanupCode = typeof code === 'string' && /^[A-Z_]{1,30}$/.test(code) ? code : 'IO'; }
    }
    if (!result.temporaryResourcesRemoved) { result.retainedTemporaryDirectory = basename(root); result.ok = false; if (['OK', 'PARTIAL'].includes(result.code)) result.code = 'IO'; }
  }
  return result;
}

export interface CodexProjectProvisioningCheck {
  ok: boolean; code: string; rpcErrorCode: number | null;
  stage: 'initialize' | 'project-create' | 'project-read' | 'thread-create' | 'thread-name' | 'cold-read' | 'listing' | 'complete';
  projects: { created: boolean; idempotent: boolean; readback: boolean; persisted: boolean }[];
  conversations: { sameProject: boolean; created: boolean; projectMatches: boolean; workspaceMatches: boolean; titleMatches: boolean; persisted: boolean }[];
  listingCounts: { expected: number; observed: number; identitiesMatch: boolean }[];
  projectListMatches: boolean; uniqueConversationIds: boolean;
  listingsSkipped: boolean;
  isolatedHome: true; experimentalApi: true; nativeDesktopVerified: false;
  ordinaryGptCreationVerified: false; fullWorkflowReady: false; realModelInvoked: false; credentialsRead: false; businessDatabaseOpened: false;
  temporaryResourcesRemoved: boolean; retainedTemporaryDirectory: string | null; ownedProcessExitConfirmed: boolean; cleanupCode: string | null;
}

/** Real experimental project APIs in an owned test home. A passed diagnostic
 * proves the app-server registry only; it cannot attest desktop registration. */
export async function checkCodexProjectProvisioning(options: ClientOptions & { signal?: AbortSignal; includeListings?: boolean }): Promise<CodexProjectProvisioningCheck> {
  if (!options.executable?.trim() || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000) throw new BridgeError('CONFIG', 'Invalid project diagnostic configuration');
  if (options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Project diagnostic cancelled before resource creation');
  const result: CodexProjectProvisioningCheck = { ok: false, code: 'UNSUPPORTED', rpcErrorCode: null, stage: 'initialize', projects: [], conversations: [], listingCounts: [], projectListMatches: false, uniqueConversationIds: false, listingsSkipped: options.includeListings === false,
    isolatedHome: true, experimentalApi: true, nativeDesktopVerified: false, ordinaryGptCreationVerified: false, fullWorkflowReady: false, realModelInvoked: false, credentialsRead: false, businessDatabaseOpened: false,
    temporaryResourcesRemoved: false, retainedTemporaryDirectory: null, ownedProcessExitConfirmed: false, cleanupCode: null };
  const parent = realpathSync.native(tmpdir()), root = mkdtempSync(join(parent, 'acb-project-api-')), home = join(root, 'codex-home');
  const deadline = Date.now() + options.timeoutMs;
  let client: AppServerConnection | undefined, cleanupSafe = true;
  const remaining = () => { const value = deadline - Date.now(); if (value < 1 || options.signal?.aborted) throw new BridgeError('TIMEOUT', 'Project diagnostic deadline exceeded'); return value; };
  const connect = async () => {
    client = new AppServerConnection({ ...options, timeoutMs: remaining(), ownedHome: home, ownedCwd: root });
    client.notification = method => { if (method.startsWith('turn/') || method.startsWith('item/')) throw new BridgeError('EXECUTION', 'Unexpected agent activity during project diagnostic'); };
    await client.initialize(options.signal, true);
  };
  const request = (method: Parameters<AppServerConnection['request']>[0], params: Row) => client!.request(method, params, options.signal, remaining());
  const projectCheck = (response: Row, expected: { id?: string; name: string; path: string }) => {
    const project = row(response.project), roots = project?.roots;
    const id = identifier(project?.id);
    if ((expected.id && id !== expected.id) || project?.name !== expected.name || !Array.isArray(roots) || roots.length !== 1 || typeof row(roots[0])?.path !== 'string' || pathKey(String(row(roots[0])!.path)) !== pathKey(expected.path)) throw new BridgeError('PROVENANCE', 'Project readback identity, exact name or roots mismatched');
    return id;
  };
  try {
    writeFileSync(join(root, 'acb-probe-owner.json'), JSON.stringify({ purpose: 'isolated-project-api-diagnostic', createdAt: new Date().toISOString(), directory: basename(root) }), { flag: 'wx', mode: 0o600 });
    mkdirSync(home, { mode: 0o700 });
    const projects = [{ name: 'ACB 隔离项目 A', path: join(root, 'workspace-a'), id: '' }, { name: 'ACB 隔离项目 B', path: join(root, 'workspace-b'), id: '' }];
    for (const project of projects) mkdirSync(project.path, { mode: 0o700 });
    await connect();
    for (const [index, project] of projects.entries()) {
      result.stage = 'project-create';
      const check = { created: false, idempotent: false, readback: false, persisted: false }; result.projects.push(check);
      const params = { name: project.name, roots: [{ path: project.path }], idempotencyKey: `acb-${basename(root)}-${index}` };
      project.id = projectCheck(await request('project/create', params), project); check.created = true;
      if (projects.some(other => other !== project && other.id === project.id)) throw new BridgeError('PROVENANCE', 'Projects reused an identity');
      projectCheck(await request('project/create', params), project); check.idempotent = true;
      result.stage = 'project-read'; projectCheck(await request('project/read', { projectId: project.id }), project); check.readback = true;
    }
    const catalog = await request('model/list', { limit: 100, includeHidden: false });
    const model = Array.isArray(catalog.data) ? catalog.data.map(row).find(item => typeof item?.model === 'string' && /^gpt-[a-z0-9.-]{1,100}$/i.test(item.model))?.model : null;
    if (typeof model !== 'string') throw new BridgeError('UNSUPPORTED', 'No bounded model catalog entry');
    const created: { id: string; project: typeof projects[number]; name: string; source: string }[] = [];
    const verifyThread = (response: Row, item: typeof created[number], loaded: boolean) => {
      const observed = summary(response, item.id), thread = row(response.thread);
      if (observed.appProjectId !== item.project.id || pathKey(observed.workspacePath) !== pathKey(item.project.path) || !observed.local || !['idle', ...(loaded ? [] : ['notLoaded'])].includes(observed.status) || thread?.name !== item.name) throw new BridgeError('PROVENANCE', 'Codex project, workspace or exact title readback mismatched');
    };
    for (let index = 0; index < 4; index++) {
      const project = projects[index < 3 ? 0 : 1]!, check = { sameProject: index < 3, created: false, projectMatches: false, workspaceMatches: false, titleMatches: false, persisted: false }; result.conversations.push(check);
      result.stage = 'thread-create';
      const start = await request('thread/start', { projectId: project.id, cwd: project.path, model, ephemeral: false, sandbox: 'read-only', approvalPolicy: 'untrusted' });
      const observed = summary(start, identifier(row(start.thread)?.id));
      if (created.some(item => item.id === observed.conversationId)) throw new BridgeError('PROVENANCE', 'Codex reused a conversation identity');
      check.created = true;
      if (observed.appProjectId !== project.id) throw new BridgeError('PROVENANCE', 'Created Codex project assignment mismatched'); check.projectMatches = true;
      if (pathKey(observed.workspacePath) !== pathKey(project.path) || !observed.local || observed.status !== 'idle' || row(start.thread)?.ephemeral !== false || row(start.sandbox)?.type !== 'readOnly' || start.approvalPolicy !== 'untrusted') throw new BridgeError('PROVENANCE', 'Created Codex workspace or sandbox mismatched'); check.workspaceMatches = true;
      const source = row(start.thread)?.source;
      if (typeof source !== 'string' || !['cli', 'vscode', 'exec', 'appServer'].includes(source)) throw new BridgeError('PROVENANCE', 'Unknown Codex source kind');
      const item = { id: observed.conversationId, project, name: `ACB 精确命名 ${index + 1} · 验证`, source }; created.push(item);
      result.stage = 'thread-name';
      await request('thread/name/set', { threadId: item.id, name: 'ACB 临时名称' });
      await request('thread/name/set', { threadId: item.id, name: item.name });
      verifyThread(await request('thread/read', { threadId: item.id, includeTurns: false }), item, true); check.titleMatches = true;
    }
    result.uniqueConversationIds = new Set(created.map(item => item.id)).size === 4;
    cleanupSafe = await client!.closeAndWait(); client = undefined;
    if (!cleanupSafe) throw new BridgeError('IO', 'Owned project diagnostic process did not confirm exit');
    await connect(); result.stage = 'cold-read';
    for (const [index, project] of projects.entries()) { projectCheck(await request('project/read', { projectId: project.id }), project); result.projects[index]!.persisted = true; }
    for (const [index, item] of created.entries()) { verifyThread(await request('thread/read', { threadId: item.id, includeTurns: false }), item, false); result.conversations[index]!.persisted = true; }
    if (options.includeListings === false) { result.code = 'PARTIAL'; return result; }
    result.stage = 'listing';
    const listed = await request('project/list', { limit: 10 });
    if (!Array.isArray(listed.data) || listed.nextCursor != null || listed.data.length !== 2 || !projects.every(project => listed.data instanceof Array && listed.data.some(value => row(value)?.id === project.id))) throw new BridgeError('PROVENANCE', 'Project inventory mismatched');
    for (const value of listed.data) { const project = projects.find(item => item.id === row(value)?.id)!; projectCheck({ project: value }, project); }
    result.projectListMatches = true;
    let emptyListings = false;
    for (const project of projects) {
      const expected = created.filter(item => item.project === project), listed = await request('thread/list', { projectId: project.id, limit: 10, sourceKinds: [...new Set(created.map(item => item.source))], useStateDbOnly: false });
      const rows = Array.isArray(listed.data) ? listed.data.map(row) : [];
      const match = Array.isArray(listed.data) && listed.nextCursor == null && rows.length === expected.length && new Set(rows.map(item => item?.id)).size === expected.length && rows.every(item => item && expected.some(value => value.id === item.id));
      result.listingCounts.push({ expected: expected.length, observed: rows.length, identitiesMatch: match });
      if (Array.isArray(listed.data) && listed.nextCursor == null && rows.length === 0) { emptyListings = true; continue; }
      if (!match) throw new BridgeError('PROVENANCE', 'Project thread inventory mismatched');
      for (const thread of rows) verifyThread({ thread }, expected.find(item => item.id === thread!.id)!, false);
    }
    if (emptyListings) { result.code = 'PARTIAL'; return result; }
    result.ok = true; result.code = 'OK'; result.stage = 'complete';
  } catch (error) { result.code = error instanceof BridgeError ? error.code : 'IO'; result.rpcErrorCode = error instanceof AppServerRpcError ? error.rpcCode : null; }
  finally {
    if (client) cleanupSafe = await client.closeAndWait() && cleanupSafe;
    result.ownedProcessExitConfirmed = cleanupSafe;
    if (cleanupSafe && dirname(root) === parent && realpathSync.native(root) === root) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); result.temporaryResourcesRemoved = !existsSync(root); }
      catch (error) { const code = row(error)?.code; result.cleanupCode = typeof code === 'string' && /^[A-Z_]{1,30}$/.test(code) ? code : 'IO'; }
    }
    if (!result.temporaryResourcesRemoved) { result.retainedTemporaryDirectory = basename(root); result.ok = false; if (result.code === 'OK') result.code = 'IO'; }
  }
  return result;
}

interface TurnEvent { method: string; threadId: string; turnId: string | null; status?: string; failed?: boolean; reroutedTo?: string }
function eventSummary(method: string, params: Row, target: string): TurnEvent | null {
  if (params.threadId !== target || !/^[a-zA-Z][a-zA-Z0-9/]{1,100}$/.test(method)) return null;
  const turn = row(params.turn), id = method === 'turn/completed' ? turn?.id : params.turnId ?? turn?.id;
  if (method === 'turn/completed' && params.turnId !== undefined && params.turnId !== id) return null;
  return { method, threadId: target, turnId: typeof id === 'string' && ID.test(id) ? id : null,
    ...(method === 'turn/completed' ? { status: String(turn?.status), failed: turn?.error != null } : {}),
    ...(method === 'model/rerouted' ? { reroutedTo: typeof params.toModel === 'string' ? params.toModel : '' } : {}) };
}
async function executeTurn(connection: AppServerConnection, options: { target: DeliveryTarget; model: string; reasoningEffort: string; content: string; key: string; timeoutMs: number; interruptTimeoutMs: number; signal: AbortSignal; onEvent?: (event: Row) => void }): Promise<string> {
  let turnId: string | null = null, finished = false, stopping = false;
  let pendingStop: BridgeError | undefined;
  const early: TurnEvent[] = [];
  let resolveTurn!: (id: string) => void, rejectTurn!: (error: BridgeError) => void;
  const outcome = new Promise<string>((resolvePromise, rejectPromise) => { resolveTurn = resolvePromise; rejectTurn = rejectPromise; });
  // A notification may arrive before turn/start responds. Attach a rejection
  // observer immediately, and buffer only bounded, content-free event summaries.
  void outcome.catch(() => {});
  const finish = (error?: BridgeError) => {
    if (finished) return; finished = true;
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    if (error) rejectTurn(error); else resolveTurn(turnId!);
  };
  const stop = async (error: BridgeError) => {
    if (finished || stopping) return; stopping = true;
    pendingStop = error;
    if (turnId) {
      try { await connection.request('turn/interrupt', { threadId: options.target.codexConversationId, turnId }, undefined, options.interruptTimeoutMs); }
      catch { /* No interrupt acknowledgement is treated as success. */ }
    }
    finish(error);
  };
  const abort = () => { void stop(new BridgeError('TIMEOUT', 'Turn aborted; external outcome requires reconciliation')); };
  const timer = setTimeout(() => { void stop(new BridgeError('TIMEOUT', 'Turn deadline exceeded; external outcome requires reconciliation')); }, options.timeoutMs);
  connection.disconnected = error => finish(error);
  connection.serverRequest = () => { void stop(new BridgeError('AUTH', 'Interactive approval or authentication requires a trusted host')); };
  const consume = (event: TurnEvent) => {
    if (finished || stopping || event.turnId !== turnId) return;
    try { options.onEvent?.({ type: event.method.replaceAll('/', '.').toLowerCase(), threadId: event.threadId, turnId }); }
    catch { void stop(new BridgeError('IO', 'Event persistence failed; external outcome requires reconciliation')); return; }
    if (event.method === 'model/rerouted' && event.reroutedTo !== options.model) { void stop(new BridgeError('PROVENANCE', 'Codex model rerouted; requested model cannot be assumed')); return; }
    if (event.method === 'turn/completed') {
      if (event.status !== 'completed' || event.failed) finish(new BridgeError('EXECUTION', 'Codex turn failed or was interrupted; no completed delivery'));
      else finish();
    }
  };
  connection.notification = (method, params) => {
    const event = eventSummary(method, params, options.target.codexConversationId);
    if (!event) return;
    if (turnId) consume(event);
    else {
      if (early.length >= 128) { finish(new BridgeError('EXECUTION', 'Too many events preceded the turn receipt')); return; }
      early.push(event);
    }
  };
  try {
    const result = await connection.request('turn/start', {
      threadId: options.target.codexConversationId, input: [{ type: 'text', text: options.content }],
      clientUserMessageId: options.key, model: options.model, effort: options.reasoningEffort,
      approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [options.target.workspacePath], networkAccess: false },
    }, options.signal);
    const turn = row(result.turn);
    turnId = identifier(turn?.id);
    if (pendingStop) {
      // A refusal/deadline can precede the start acknowledgement. Once the
      // actual turn ID arrives, interrupt that turn once; never invent an ID.
      try { await connection.request('turn/interrupt', { threadId: options.target.codexConversationId, turnId }, undefined, options.interruptTimeoutMs); } catch { /* Unknown remains fenced. */ }
    }
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    for (const event of early) consume(event);
    // Some transports can return an already terminal turn without a notification.
    if (turn?.status !== 'inProgress') consume({ method: 'turn/completed', threadId: options.target.codexConversationId, turnId, status: String(turn?.status), failed: turn?.error != null });
    return await outcome;
  } catch (error) {
    finish(error instanceof BridgeError ? error : new BridgeError('IO', 'Turn receipt could not be verified'));
    throw error;
  } finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    connection.notification = undefined; connection.disconnected = undefined; connection.serverRequest = undefined;
  }
}

export interface CodexAppServerExecutorOptions extends ClientOptions {
  model: string; reasoningEffort: string; interruptTimeoutMs: number; selfMcpServerName: string;
  inspect: BackgroundExecutor['inspect'];
  // App-server readback alone cannot prove that another desktop/CLI process
  // isn't already executing this thread. The trusted host owns this exclusion.
  assertExclusive: (target: DeliveryTarget, signal: AbortSignal) => Promise<void>;
}
export function createCodexAppServerExecutor(options: CodexAppServerExecutorOptions): BackgroundExecutor {
  if (!/^gpt-[a-zA-Z0-9.-]{1,100}$/.test(options.model) || !EFFORTS.includes(options.reasoningEffort) || !Number.isInteger(options.interruptTimeoutMs) || options.interruptTimeoutMs < 1 || options.interruptTimeoutMs > 30000 || typeof options.selfMcpServerName !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.selfMcpServerName) || typeof options.inspect !== 'function' || typeof options.assertExclusive !== 'function') throw new BridgeError('CONFIG', 'App-server executor requires explicit model, effort, own MCP name and trusted target/exclusion adapters');
  const check = (actual: CodexThreadSummary, expected: Awaited<ReturnType<BackgroundExecutor['inspect']>>, target: DeliveryTarget) => {
    identifier(expected.appProjectId);
    // Older desktop assignments can live outside app-server's canonical project
    // field. Null is never evidence of ownership: the independent trusted
    // desktop inspector must still supply ownership. A conflicting non-null
    // canonical assignment is always rejected.
    if (!expected.local || expected.source !== 'codex-app-state' || expected.conversationId !== target.codexConversationId || !actual.local || (actual.appProjectId !== null && actual.appProjectId !== expected.appProjectId) || pathKey(actual.workspacePath) !== pathKey(target.workspacePath) || pathKey(actual.workspacePath) !== pathKey(expected.workspacePath)) throw new BridgeError('PROVENANCE', 'Native project, Codex thread and workspace readback do not match');
  };
  return {
    mode: 'codex-app-server',
    async inspect(target, signal) {
      const expected = await options.inspect(target, signal);
      check(await inspectCodexThread({ ...options, conversationId: target.codexConversationId, signal }), expected, target);
      return expected;
    },
    async execute(content, key, target, signal, onEvent) {
      if (signal.aborted) throw new BridgeError('TIMEOUT', 'Execution aborted before launch');
      if (typeof content !== 'string' || !content.trim() || content.length > 65536 || typeof key !== 'string' || !ID.test(key)) throw new BridgeError('INPUT', 'Invalid app-server prompt or dispatch identity');
      requireNoSecrets(content); identifier(target.codexConversationId); pathKey(target.workspacePath);
      const expected = await options.inspect(target, signal);
      await options.assertExclusive(target, signal);
      if (signal.aborted) throw new BridgeError('TIMEOUT', 'Execution aborted before launch');
      const connection = new AppServerConnection({ ...options, disabledServerName: options.selfMcpServerName });
      try {
        await connection.initialize(signal, true);
        const before = summary(await connection.request('thread/read', { threadId: target.codexConversationId, includeTurns: false }, signal), target.codexConversationId);
        check(before, expected, target);
        if (before.status === 'active' || before.status === 'systemError') throw new BridgeError('CONFLICT', 'Native thread is active or unavailable');
        const resumed = await connection.request('thread/resume', { threadId: target.codexConversationId, model: options.model, config: { model_reasoning_effort: options.reasoningEffort, sandbox_workspace_write: { network_access: false, writable_roots: [target.workspacePath] } }, approvalPolicy: 'untrusted', sandbox: 'workspace-write' }, signal);
        check(summary(resumed, target.codexConversationId), expected, target);
        if (resumed.model !== options.model || resumed.reasoningEffort !== options.reasoningEffort || typeof resumed.cwd !== 'string' || pathKey(resumed.cwd) !== pathKey(target.workspacePath)) throw new BridgeError('PROVENANCE', 'App-server selected configuration does not match the explicit request');
        assertResumeSandbox(resumed, target.workspacePath);
        await options.assertExclusive(target, signal);
        const executionId = await executeTurn(connection, { ...options, target, content, key, signal, onEvent });
        return { executionId, codexConversationId: target.codexConversationId, workspacePath: target.workspacePath };
      } finally { connection.close(); }
    },
  };
}
