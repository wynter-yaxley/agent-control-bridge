import type { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { now, transaction, uuid, processOwner, ownerAlive } from './db.ts';
import { BridgeError, classifyError } from './errors.ts';
import { withDeadline } from './deadline.ts';
import { promptHash } from './prompts.ts';
import { ConversationRegistry } from './topology.ts';
import { assertOrdinaryChatCapabilities, type OrdinaryChatCapabilities } from './ordinary-chat.ts';
import { enqueueNotification } from './outbox.ts';
import { requireNoSecrets } from './security.ts';

export interface ProjectHostCapabilities extends OrdinaryChatCapabilities {
  /** Observed by trusted host code; independent App Server projects are insufficient. */
  createCodexConversation?: boolean;
  workspaceSurface: 'native-desktop' | 'isolated-app-server' | 'unknown';
}
export interface ProjectBundleEvidence extends ProjectResources {
  source: 'application-host';
  kind: 'ordinary-chat';
  workspaceSurface: 'native-desktop';
  /** Independently read from this Codex conversation's native desktop membership. */
  codexNativeProjectId: string;
}
export type InitializationEffect = 'native-workspace' | 'ordinary-gpt' | 'codex-thread';
/** One approval covers one attempt (prepare, restart, reconcile or one added
 * Codex) of one operation, and only the effects listed for that attempt. */
export interface InitializationScope { operationId: string; attempt: string; effects: InitializationEffect[] }
export interface ProjectHost {
  authorizeInitialization?(name:string,path:string,signal:AbortSignal,scope:InitializationScope):Promise<void>;
  inspect(signal: AbortSignal): Promise<ProjectHostCapabilities>;
  /** Read-only: the native workspace entry is present, unique, visible and invokable now. */
  probeWorkspaceEntry?(signal: AbortSignal): Promise<void>;
  createWorkspace(name: string, path: string, signal: AbortSignal, scope?: InitializationScope): Promise<{ appProjectId: string; workspacePath: string }>;
  // appProjectId correlates this creation operation; ordinary GPT is not moved
  // into a Codex native project. verifyBundle must independently read its title.
  createOrdinaryChat(appProjectId: string, exactName: string, signal: AbortSignal, operationKey?: string, scope?: InitializationScope): Promise<{ conversationId: string }>;
  /** index > 0 names an additional conversation of the same workspace. AUTH and
   * UNSUPPORTED are thrown only when no native effect was started. */
  createCodexConversation(appProjectId: string, workspacePath: string, signal: AbortSignal, operationKey?: string, index?: number, scope?: InitializationScope): Promise<{ conversationId: string }>;
  /** Read-only: the conversation created for operationKey/index, found by its initialization receipt. */
  observeCodexCreation?(input: { appProjectId: string; workspacePath: string; operationKey: string; index: number }, signal: AbortSignal): Promise<string | undefined>;
  /** Read-only: a Codex conversation is a member of this native workspace and directory. */
  verifyCodexMember?(input: { appProjectId: string; workspacePath: string; conversationId: string; name?: string }, signal: AbortSignal): Promise<void>;
  /** Read-only: native workspaces registered for this directory, whatever their name. */
  nativeWorkspaces?(workspacePath: string, signal: AbortSignal): Promise<{ projectId: string; label: string }[]>;
  observePartial?(resources: Partial<ProjectResources>, phase: string, signal: AbortSignal): Promise<Partial<ProjectResources>>;
  /** Read-only native ownership check for a legacy mapping with recorded IDs. */
  verifyExisting?(input: { name: string; workspacePath: string; chatgptConversationId: string; codexConversationIds: string[] }, signal: AbortSignal): Promise<{ appProjectId: string }>;
  verifyBundle(resources: ProjectResources, signal: AbortSignal): Promise<ProjectBundleEvidence>;
}
export interface ProjectResources { initializationKey?: string; appProjectId: string; workspacePath: string; name: string; chatgptConversationId: string; codexConversationId: string; codexConversations?: number; extraCodexConversationIds?: string[] }
/** A formal Codex creation for a READY project whose receipt is not yet recorded. */
interface PendingCodex { index: number; owner: string }
type OperationResources = Partial<ProjectResources> & { pendingCodex?: PendingCodex; codexCreateIndex?: number };
/** Directory creation and native registration are separate facts; only receipts count. */
export interface ProjectStages { directoryCreated: boolean; nativeWorkspace: boolean; gptConversation: boolean; codexConversations: number; codexRequested: number; codexPending: number | null }
export interface ProjectOperation { id: string; projectId: string; name: string; workspacePath: string; state: string; errorCode: string | null; phase?: string | null; resources: Partial<ProjectResources> | null; stages?: ProjectStages }
const MAX_CODEX_CONVERSATIONS = 4, MAX_WORKSPACE_RESTARTS = 2;
const refusedBeforeEffect = (error: unknown) => error instanceof BridgeError && (error.code === 'AUTH' || error.code === 'UNSUPPORTED');

export class ProjectProvisioner {
  private readonly db: DatabaseSync;
  private readonly authority: CallerAuthority;
  private readonly host?: ProjectHost;
  private readonly root: string;
  private readonly timeoutMs: number;
  constructor(db: DatabaseSync, authority: CallerAuthority, options: { root: string; timeoutMs: number; host?: ProjectHost }) {
    this.db = db; this.authority = authority; this.host = options.host; this.root = resolve(options.root); this.timeoutMs = options.timeoutMs;
  }
  get(id: string, context: CallerContext): ProjectOperation {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted controller required');
    const row = this.db.prepare('SELECT * FROM project_operations WHERE id=? AND principal=?').get(id, caller.principal);
    if (!row) throw new BridgeError('NOT_FOUND', 'Project operation not found');
    const resources: OperationResources | null = row.resources === null ? null : JSON.parse(String(row.resources));
    const stages: ProjectStages = { directoryCreated: !!resources?.workspacePath, nativeWorkspace: !!resources?.appProjectId, gptConversation: !!resources?.chatgptConversationId,
      codexConversations: (resources?.codexConversationId ? 1 : 0) + (resources?.extraCodexConversationIds?.length ?? 0), codexRequested: resources?.codexConversations ?? 1, codexPending: resources?.pendingCodex?.index ?? null };
    return { id: String(row.id), projectId: String(row.project_id), name: String(row.name), workspacePath: String(row.root_path), state: String(row.state), phase:row.phase as string | null,errorCode: row.error_code === null ? null : String(row.error_code), resources, stages };
  }
  async reconcile(id: string, context: CallerContext): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    const operation = this.get(id, context);
    if (operation.state === 'READY') return operation;
    if (operation.state !== 'UNCERTAIN' || !this.host) throw new BridgeError('STATE', 'Recorded uncertain resources and an authorized host are required');
    let resources:Partial<ProjectResources>={...operation.resources,initializationKey:operation.resources?.initializationKey ?? id};
    const row=this.db.prepare('SELECT owner_token,phase FROM project_operations WHERE id=?').get(id)!;
    if(ownerAlive(row.owner_token as string | null)===true && row.owner_token!==processOwner())throw new BridgeError('CONFLICT','The original project holder is still alive');
    // Resources are saved before any native effect, so none means none started.
    // A directory without a saved receipt has unknown ownership and stays uncertain.
    if(operation.resources===null && row.phase===null) {
      if(existsSync(operation.workspacePath))throw new BridgeError('PROVENANCE','Workspace directory exists without a recorded creation receipt');
      if(this.db.prepare("UPDATE project_operations SET state='BLOCKED',updated_at=? WHERE id=? AND state='UNCERTAIN' AND resources IS NULL AND phase IS NULL").run(now(),id).changes!==1)throw new BridgeError('CONFLICT','Project operation changed');
      return this.get(id, context);
    }
    if(row.phase && !['workspace.done','gpt.done','codex.done','codex.extra.done','codex.attach','verify'].includes(String(row.phase))) {
      if(!this.host.observePartial)throw new BridgeError('PROVENANCE','Incomplete resources cannot be recreated during reconciliation');
      const phase=String(row.phase),extras=resources.extraCodexConversationIds?.length ?? 0;
      resources=await withDeadline(signal=>this.host!.observePartial!(resources,phase,signal),this.timeoutMs);
      // codex.extra is acknowledged only by one more recorded conversation than before.
      const acknowledged=phase==='workspace'?resources.appProjectId:phase==='gpt'?resources.chatgptConversationId:phase==='codex.extra'?(resources.extraCodexConversationIds?.length ?? 0)===extras+1:resources.codexConversationId;
      if(!acknowledged)throw new BridgeError('PROVENANCE','The original creation has no exact receipt; do not create replacements');
    }
    if(!resources?.appProjectId || resources.name!==operation.name || (process.platform==='win32'?resolve(resources.workspacePath!).toLowerCase():resolve(resources.workspacePath!))!==(process.platform==='win32'?resolve(operation.workspacePath).toLowerCase():resolve(operation.workspacePath)))throw new BridgeError('PROVENANCE','Incomplete resources cannot be recreated during reconciliation');
    transaction(this.db,()=>{
      this.assertGuiFree(id);
      this.db.prepare("UPDATE project_operations SET state='PROVISIONING',owner_token=?,resources=?,updated_at=? WHERE id=? AND state='UNCERTAIN'").run(processOwner(),JSON.stringify(resources),now(),id);
    });
    // A reconcile is a new attempt: any creation it still needs requires a fresh approval.
    try {const scope=this.scope(id,resources,await this.formalCreator());await this.complete(id,resources,context,scope);}
    catch(error){const failure=classifyError(error);this.db.prepare("UPDATE project_operations SET state='UNCERTAIN',error_code=?,updated_at=? WHERE id=?").run(failure.code,now(),id);enqueueNotification(this.db,caller.principal,`project:${id}:reconcile:${failure.code}:${promptHash(failure.message).slice(0,12)}`,{operationId:id,state:'UNCERTAIN',errorCode:failure.code,detail:failure.message.slice(0,300)});}
    return this.get(id, context);
  }
  /** Re-binds a migrated project whose mapping has no controller access. Access
   * and the native workspace ID are granted only after native readback of the
   * recorded GPT/Codex IDs; schema migration alone grants nothing. */
  async adopt(projectId: string, context: CallerContext): Promise<{ projectId: string; appProjectId: string; adopted: boolean }> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted controller required');
    const mapping = this.db.prepare('SELECT w.*,p.name FROM conversation_workspaces w JOIN projects p ON p.id=w.project_id WHERE w.project_id=?').get(projectId);
    if (!mapping) throw new BridgeError('NOT_FOUND', 'Legacy project mapping not found');
    const access = () => this.db.prepare('SELECT principal FROM project_access WHERE project_id=?').all(projectId).map(row => String(row.principal));
    const before = access();
    if (before.some(principal => principal !== caller.principal)) throw new BridgeError('AUTH', 'Project belongs to another controller');
    if (before.length && mapping.app_project_id !== null) return { projectId, appProjectId: String(mapping.app_project_id), adopted: false };
    if (mapping.chatgpt_conversation_name !== mapping.name) throw new BridgeError('PROVENANCE', 'GPT conversation name must exactly match the project name');
    const codexConversationIds = this.db.prepare('SELECT conversation_id FROM codex_conversations WHERE project_id=? ORDER BY conversation_id').all(projectId).map(row => String(row.conversation_id));
    if (!codexConversationIds.length) throw new BridgeError('PROVENANCE', 'A recorded Codex conversation is required');
    if (!this.host?.verifyExisting) throw new BridgeError('UNSUPPORTED', 'A native project host is required to verify legacy ownership');
    const observed = await withDeadline(signal => this.host!.verifyExisting!({ name: String(mapping.name), workspacePath: String(mapping.workspace_path), chatgptConversationId: String(mapping.chatgpt_conversation_id), codexConversationIds }, signal), this.timeoutMs);
    if (!observed?.appProjectId || (mapping.app_project_id !== null && mapping.app_project_id !== observed.appProjectId)) throw new BridgeError('PROVENANCE', 'Native workspace differs from the recorded mapping');
    transaction(this.db, () => {
      if (JSON.stringify(access()) !== JSON.stringify(before)) throw new BridgeError('CONFLICT', 'Project access changed during verification');
      if (this.db.prepare('SELECT 1 FROM conversation_workspaces WHERE project_id!=? AND app_project_id=?').get(projectId, observed.appProjectId)) throw new BridgeError('CONFLICT', 'Native workspace already belongs to another project');
      this.db.prepare('UPDATE conversation_workspaces SET app_project_id=? WHERE project_id=?').run(observed.appProjectId, projectId);
      this.db.prepare('INSERT OR IGNORE INTO project_access(project_id,principal) VALUES(?,?)').run(projectId, caller.principal);
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), caller.principal, 'project_adopt', `project=${projectId} native=${observed.appProjectId}`);
      enqueueNotification(this.db, caller.principal, `project:${projectId}:adopted`, { projectId, appProjectId: observed.appProjectId, state: 'ADOPTED' });
    });
    return { projectId, appProjectId: observed.appProjectId, adopted: true };
  }
  /** Explicit, audited restart of the native workspace step only. Allowed when the
   * original holder is gone, only the directory exists (phase 'workspace', no
   * native receipt or later resources), the directory is still empty and the
   * native host lists no workspace for it. Never automatic; never reuses foreign
   * directories; the earlier attempt stays recorded in the audit log. */
  async restartWorkspace(id: string, context: CallerContext): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    const operation = this.get(id, context), resources = operation.resources ?? {};
    if (operation.state !== 'UNCERTAIN' || operation.phase !== 'workspace') throw new BridgeError('STATE', 'Only an uncertain native workspace step can be restarted');
    if (!this.host?.nativeWorkspaces || !this.host.authorizeInitialization) throw new BridgeError('UNSUPPORTED', 'A native host that lists workspaces and approves initialization is required');
    if (resources.appProjectId || resources.chatgptConversationId || resources.codexConversationId || resources.extraCodexConversationIds?.length) throw new BridgeError('STATE', 'Later resources exist; reconcile instead of restarting');
    const path = resolve(String(resources.workspacePath ?? '')), key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!resources.workspacePath || key(path) !== key(resolve(operation.workspacePath)) || resources.name !== operation.name) throw new BridgeError('PROVENANCE', 'Recorded directory does not belong to this operation');
    const row = this.db.prepare('SELECT owner_token FROM project_operations WHERE id=?').get(id)!;
    if (ownerAlive(row.owner_token as string | null) === true && row.owner_token !== processOwner()) throw new BridgeError('CONFLICT', 'The original project holder is still alive');
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || readdirSync(path).length) throw new BridgeError('PROVENANCE', 'Recorded workspace directory is missing, not a plain directory or no longer empty');
    const attempts = Number(this.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='project_workspace_restart' AND detail=?").get(`operation=${id}`)!.n);
    if (attempts >= MAX_WORKSPACE_RESTARTS) throw new BridgeError('CONFLICT', 'Workspace restart budget is exhausted; report and stop');
    const listed = await withDeadline(signal => this.host!.nativeWorkspaces!(path, signal), this.timeoutMs);
    if (listed.length) throw new BridgeError('PROVENANCE', 'A native workspace already exists for this directory; reconcile instead of creating');
    // A hidden or ambiguous entry refuses here, before approval or the restart budget.
    await this.probeEntry();
    const scope = this.scope(id, resources, await this.formalCreator());
    await withDeadline(signal => this.host!.authorizeInitialization!(operation.name, path, signal, scope), this.timeoutMs);
    transaction(this.db, () => {
      this.assertGuiFree(id);
      if (this.db.prepare("UPDATE project_operations SET state='PROVISIONING',owner_token=?,error_code=NULL,updated_at=? WHERE id=? AND state='UNCERTAIN' AND phase='workspace'").run(processOwner(), now(), id).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), caller.principal, 'project_workspace_restart', `operation=${id}`);
    });
    try { await this.createWorkspaceAndComplete(id, operation.name, path, resources.codexConversations ?? 1, context, scope); }
    catch (error) { this.recordFailure(id, caller.principal, error, 'UNCERTAIN', 'Reconcile recorded resources before retry'); }
    return this.get(id, context);
  }
  /** Attaches an operator-created Codex conversation to an operation that is
   * waiting for one (BLOCKED/codex.attach) or to a READY project. The thread
   * must be read back from the native host as a member of this operation's own
   * workspace and directory, and may not be known to any other project. */
  async attachCodex(id: string, conversationId: string, context: CallerContext): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    if (typeof conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(conversationId)) throw new BridgeError('INPUT', 'Invalid Codex conversation ID');
    const operation = this.get(id, context), resources = { ...operation.resources } as OperationResources;
    if (operation.state === 'READY') return this.addReadyCodex(operation, caller.principal, context, { conversationId });
    if (operation.state !== 'BLOCKED' || operation.phase !== 'codex.attach' || !resources.appProjectId || !resources.workspacePath || !resources.chatgptConversationId) throw new BridgeError('STATE', 'This operation is not waiting for a Codex conversation');
    const attached = [resources.codexConversationId, ...(resources.extraCodexConversationIds ?? [])].filter((value): value is string => !!value);
    if (attached.includes(conversationId)) return operation;
    this.assertUnclaimed(id, conversationId);
    if (!this.host?.verifyCodexMember) throw new BridgeError('UNSUPPORTED', 'A native host that verifies Codex membership is required');
    await withDeadline(signal => this.host!.verifyCodexMember!({ appProjectId: resources.appProjectId!, workspacePath: resources.workspacePath!, conversationId, name: resources.name }, signal), this.timeoutMs);
    if (resources.codexConversationId) resources.extraCodexConversationIds = [...(resources.extraCodexConversationIds ?? []), conversationId]; else resources.codexConversationId = conversationId;
    const complete = attached.length + 1 >= (resources.codexConversations ?? 1);
    transaction(this.db, () => {
      if (complete) this.assertGuiFree(id);
      if (this.db.prepare(`UPDATE project_operations SET resources=?,state=?,owner_token=?,error_code=?,updated_at=? WHERE id=? AND state='BLOCKED' AND phase='codex.attach' AND resources=?`)
        .run(JSON.stringify(resources), complete ? 'PROVISIONING' : 'BLOCKED', processOwner(), complete ? null : 'CODEX_ATTACH_REQUIRED', now(), id, JSON.stringify(operation.resources)).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), caller.principal, 'project_codex_attach', `operation=${id} conversation=${conversationId}`);
    });
    if (complete) {
      // Verification only: an empty effect list refuses any creation.
      try { await this.complete(id, resources, context, { operationId: id, attempt: uuid(), effects: [] }); }
      catch (error) { this.recordFailure(id, caller.principal, error, 'UNCERTAIN', 'Reconcile recorded resources before retry'); }
    }
    return this.get(id, context);
  }
  /** Formally creates one more Codex conversation in a READY project's native
   * workspace. Each call is one attempt with its own reviewer approval; the
   * pending index is saved before the native call so a lost receipt is later
   * recovered from the conversation's initialization receipt, never resent. */
  async createCodex(id: string, context: CallerContext): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    const operation = this.get(id, context);
    if (operation.state !== 'READY') throw new BridgeError('STATE', 'Only a READY project can add a Codex conversation');
    return this.addReadyCodex(operation, caller.principal, context, {});
  }
  private async addReadyCodex(operation: ProjectOperation, principal: string, context: CallerContext, input: { conversationId?: string }): Promise<ProjectOperation> {
    const id = operation.id, resources = { ...operation.resources } as OperationResources;
    const registered = this.readyMembers(operation, principal);
    if (input.conversationId && registered.includes(input.conversationId)) return operation;
    if (!this.host?.verifyCodexMember) throw new BridgeError('UNSUPPORTED', 'A native host that verifies Codex membership is required');
    const key = resources.initializationKey ?? id;
    let conversationId = input.conversationId, source = 'attach', pending = resources.pendingCodex;
    if (!conversationId && pending) {
      // The earlier attempt may have created a thread: recover only its own receipt.
      if (ownerAlive(pending.owner) === true && pending.owner !== processOwner()) throw new BridgeError('CONFLICT', 'The earlier Codex creation is still running');
      if (!this.host.observeCodexCreation) throw new BridgeError('UNSUPPORTED', 'A native host that reads Codex initialization receipts is required');
      conversationId = await withDeadline(signal => this.host!.observeCodexCreation!({ appProjectId: resources.appProjectId!, workspacePath: resources.workspacePath!, operationKey: key, index: pending!.index }, signal), this.timeoutMs);
      if (!conversationId) throw new BridgeError('PROVENANCE', 'The earlier Codex creation has no readable receipt; do not resend. Attach the conversation if it appears');
      source = 'recovered';
    }
    if (registered.length >= MAX_CODEX_CONVERSATIONS) throw new BridgeError('CONFLICT', `A project has at most ${MAX_CODEX_CONVERSATIONS} Codex conversations`);
    if (!conversationId) {
      if (!this.host.authorizeInitialization || (await withDeadline(signal => this.host!.inspect(signal), this.timeoutMs)).createCodexConversation !== true) throw new BridgeError('UNSUPPORTED', 'No formal native Codex creator is installed; create the conversation in the workspace and attach it');
      const index = Math.max(registered.length, (resources.codexCreateIndex ?? 0) + 1), scope: InitializationScope = { operationId: id, attempt: uuid(), effects: ['codex-thread'] };
      await withDeadline(signal => this.host!.authorizeInitialization!(resources.name!, resources.workspacePath!, signal, scope), this.timeoutMs);
      pending = { index, owner: processOwner() };
      const marked = { ...resources, pendingCodex: pending, codexCreateIndex: index };
      transaction(this.db, () => {
        this.assertGuiFree(id);
        if (this.db.prepare("UPDATE project_operations SET resources=?,updated_at=? WHERE id=? AND state='READY' AND resources=?").run(JSON.stringify(marked), now(), id, JSON.stringify(operation.resources)).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
        this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), principal, 'project_codex_create', `operation=${id} index=${index}`);
      });
      operation = this.get(id, context);
      try {
        conversationId = (await withDeadline(signal => this.host!.createCodexConversation(resources.appProjectId!, resources.workspacePath!, signal, key, index, scope), this.timeoutMs)).conversationId;
      } catch (error) {
        // A refusal before any effect releases the pending index; anything else keeps it for recovery.
        if (refusedBeforeEffect(error)) {
          const released: OperationResources = { ...marked }; delete released.pendingCodex;
          this.db.prepare("UPDATE project_operations SET resources=?,updated_at=? WHERE id=? AND state='READY' AND resources=?").run(JSON.stringify(released), now(), id, JSON.stringify(marked));
          throw error;
        }
        const failure = classifyError(error);
        enqueueNotification(this.db, principal, `project:${id}:codex-create:${index}:${failure.code}:${promptHash(failure.message).slice(0, 12)}`, { operationId: id, state: 'READY', codexPending: index, errorCode: failure.code, detail: failure.message.slice(0, 300),
          action: 'Run acb_project_create_codex again to recover this creation from its receipt; it is never resent' });
        throw error;
      }
      source = 'created';
    }
    this.assertUnclaimed(id, conversationId);
    await withDeadline(signal => this.host!.verifyCodexMember!({ appProjectId: resources.appProjectId!, workspacePath: resources.workspacePath!, conversationId: conversationId!, name: resources.name }, signal), this.timeoutMs);
    const latest = { ...operation.resources } as OperationResources, settled = source === 'attach' ? latest.pendingCodex : undefined;
    const next: OperationResources = { ...latest, extraCodexConversationIds: [...(latest.extraCodexConversationIds ?? []), conversationId!] };
    if (settled) next.pendingCodex = settled; else delete next.pendingCodex;
    transaction(this.db, () => {
      if (this.db.prepare("UPDATE project_operations SET resources=?,updated_at=? WHERE id=? AND state='READY' AND resources=?").run(JSON.stringify(next), now(), id, JSON.stringify(operation.resources)).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
      new ConversationRegistry(this.db, this.authority).register({ projectId: operation.projectId, workspacePath: resources.workspacePath!, appProjectId: resources.appProjectId!, chatgptConversationId: resources.chatgptConversationId!, chatgptConversationName: resources.name!, codexConversationId: conversationId! }, context);
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), principal, 'project_codex_add', `operation=${id} conversation=${conversationId} source=${source}`);
      enqueueNotification(this.db, principal, `project:${id}:codex-added:${conversationId}`, { operationId: id, projectId: operation.projectId, state: 'READY', codexConversationId: conversationId, source });
    });
    return this.get(id, context);
  }
  /** A READY project's registered Codex conversations, after checking that the
   * mapping, access and recorded resources still agree for this controller. */
  private readyMembers(operation: ProjectOperation, principal: string): string[] {
    const resources = operation.resources ?? {}, key = (value: string) => { const path = resolve(value); return process.platform === 'win32' ? path.toLowerCase() : path; };
    const access = this.db.prepare('SELECT principal FROM project_access WHERE project_id=?').all(operation.projectId).map(row => String(row.principal));
    if (access.length !== 1 || access[0] !== principal) throw new BridgeError('AUTH', 'Project belongs to another controller');
    const mapping = this.db.prepare('SELECT * FROM conversation_workspaces WHERE project_id=?').get(operation.projectId);
    if (!mapping || !resources.appProjectId || !resources.workspacePath || !resources.chatgptConversationId || !resources.codexConversationId || mapping.app_project_id !== resources.appProjectId ||
        mapping.chatgpt_conversation_id !== resources.chatgptConversationId || mapping.workspace_key !== key(resources.workspacePath)) throw new BridgeError('PROVENANCE', 'READY project mapping differs from its verified resources');
    const recorded = [resources.codexConversationId, ...(resources.extraCodexConversationIds ?? [])];
    const listed = this.db.prepare('SELECT conversation_id FROM codex_conversations WHERE project_id=?').all(operation.projectId).map(row => String(row.conversation_id));
    if (listed.length !== recorded.length || recorded.some(item => !listed.includes(item))) throw new BridgeError('PROVENANCE', 'Registered Codex conversations differ from the verified resources');
    return recorded;
  }
  /** A conversation known to any other project or operation, or used as a GPT conversation, is never attached. */
  private assertUnclaimed(id: string, conversationId: string): void {
    if (this.db.prepare('SELECT 1 FROM codex_conversations WHERE conversation_id=?').get(conversationId) || this.db.prepare('SELECT 1 FROM conversation_workspaces WHERE chatgpt_conversation_id=?').get(conversationId)) throw new BridgeError('CONFLICT', 'Conversation is a GPT conversation or already registered');
    for (const row of this.db.prepare('SELECT id,resources FROM project_operations WHERE resources IS NOT NULL').all()) {
      const other: OperationResources = JSON.parse(String(row.resources));
      const claimed = [other.chatgptConversationId, ...(row.id === id ? [] : [other.codexConversationId, ...(other.extraCodexConversationIds ?? [])])];
      if (claimed.includes(conversationId)) throw new BridgeError('CONFLICT', 'Conversation is recorded by a project operation');
    }
  }
  private scope(id: string, resources: Partial<ProjectResources>, creator: boolean): InitializationScope {
    const attached = (resources.codexConversationId ? 1 : 0) + (resources.extraCodexConversationIds?.length ?? 0);
    return { operationId: id, attempt: uuid(), effects: [...(resources.appProjectId ? [] : ['native-workspace' as const]), ...(resources.chatgptConversationId ? [] : ['ordinary-gpt' as const]),
      ...(creator && attached < (resources.codexConversations ?? 1) ? ['codex-thread' as const] : [])] };
  }
  private async formalCreator(): Promise<boolean> { return (await withDeadline(signal => this.host!.inspect(signal), this.timeoutMs)).createCodexConversation === true; }
  private async probeEntry(): Promise<void> { if (this.host?.probeWorkspaceEntry) await withDeadline(signal => this.host!.probeWorkspaceEntry!(signal), this.timeoutMs); }
  async prepare(name: string, eventKey: string, context: CallerContext, options: { codexConversations?: number } = {}): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new BridgeError('INPUT', 'Project name is not a valid workspace name');
    if (typeof eventKey !== 'string' || !eventKey.trim() || eventKey.length > 4096) throw new BridgeError('INPUT', 'Invalid project request key');
    requireNoSecrets(name); requireNoSecrets(eventKey);
    const path = resolve(this.root, name);
    if (dirname(path) !== this.root) throw new BridgeError('INPUT', 'Workspace must stay inside the configured root');
    const codexConversations = options.codexConversations ?? 1;
    if (!Number.isInteger(codexConversations) || codexConversations < 1 || codexConversations > MAX_CODEX_CONVERSATIONS) throw new BridgeError('INPUT', 'Invalid Codex conversation count');
    // Single-conversation requests keep their original fingerprint.
    const fingerprint = promptHash(JSON.stringify({ name, path, ...(codexConversations > 1 ? { codexConversations } : {}) }));
    const existing = this.db.prepare('SELECT * FROM project_operations WHERE principal=? AND event_key=?').get(caller.principal, eventKey);
    if (existing && existing.request_hash !== fingerprint) throw new BridgeError('CONFLICT', 'Project request key was reused');
    if (existing && !(existing.state === 'BLOCKED' && existing.resources === null && this.host)) return this.get(String(existing.id), context);
    const id = existing ? String(existing.id) : uuid(), owner = processOwner();
    // The holder is recorded atomically with PROVISIONING so a crash is always attributable.
    transaction(this.db, () => {
      this.assertGuiFree(id);
      if (!existing) {
        const pathKey = process.platform === 'win32' ? path.toLowerCase() : path;
        if (this.db.prepare('SELECT 1 FROM project_operations WHERE root_path=?').get(pathKey)) throw new BridgeError('CONFLICT', 'Workspace is already reserved');
        this.db.prepare("INSERT INTO project_operations(id,principal,event_key,request_hash,project_id,name,root_path,state,owner_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PROVISIONING',?,?,?)").run(id, caller.principal, eventKey, fingerprint, uuid(), name, pathKey, owner, now(), now());
      } else if (this.db.prepare("UPDATE project_operations SET state='PROVISIONING',owner_token=?,error_code=NULL,updated_at=? WHERE id=? AND state='BLOCKED' AND resources IS NULL").run(owner, now(), id).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
    });
    let effectsStarted = false;
    try {
      if (!this.host) throw new BridgeError('UNSUPPORTED', 'No authorized ordinary GPT project host is installed');
      const capabilities = await withDeadline(signal => this.host!.inspect(signal), this.timeoutMs);
      assertOrdinaryChatCapabilities(capabilities, true);
      if (capabilities.workspaceSurface !== 'native-desktop') throw new BridgeError('UNSUPPORTED', 'Native desktop workspace registration is required');
      for (let current = this.root; ; current = dirname(current)) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new BridgeError('CONFIG', 'Workspace parent cannot be a symbolic link');
        if (dirname(current) === current) break;
      }
      if (existsSync(path)) throw new BridgeError('CONFLICT', 'Existing workspace ownership is unknown; refusing to reuse it');
      if(!this.host.authorizeInitialization)throw new BridgeError('AUTH','Target-bound host approval is required before creating local resources');
      // Before any approval or directory: a hidden or ambiguous native entry stays BLOCKED.
      await this.probeEntry();
      const scope=this.scope(id,{codexConversations},capabilities.createCodexConversation===true);
      await withDeadline(signal=>this.host!.authorizeInitialization!(name,path,signal,scope),this.timeoutMs);
      effectsStarted = true;
      // An existing root (including a drive root such as D:\) is used as is;
      // mkdir on a Windows drive root fails with EPERM even with recursive.
      if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
      else if (!lstatSync(this.root).isDirectory()) throw new BridgeError('CONFIG', 'Workspace root is not a directory');
      mkdirSync(path);
      this.saveResources(id, { workspacePath: path, name, codexConversations });
      await this.createWorkspaceAndComplete(id, name, path, codexConversations, context, scope);
    } catch (error) {
      this.recordFailure(id, caller.principal, error, effectsStarted ? 'UNCERTAIN' : 'BLOCKED', effectsStarted ? 'Reconcile recorded resources before retry' : 'Install and verify authorized host capabilities');
    }
    return this.get(id, context);
  }
  private async createWorkspaceAndComplete(id: string, name: string, path: string, codexConversations: number, context: CallerContext, scope: InitializationScope): Promise<void> {
    this.db.prepare("UPDATE project_operations SET phase='workspace' WHERE id=?").run(id);
    const workspace = await withDeadline(signal => this.host!.createWorkspace(name, path, signal, scope), this.timeoutMs);
    requireNoSecrets(JSON.stringify(workspace));
    if (!workspace.appProjectId || resolve(workspace.workspacePath) !== path) throw new BridgeError('PROVENANCE', 'Host created a different workspace');
    const resources = { ...workspace, name, initializationKey: id, codexConversations };
    this.saveResources(id, resources, 'workspace.done');
    await this.complete(id, resources, context, scope);
  }
  private recordFailure(id: string, principal: string, error: unknown, state: 'UNCERTAIN' | 'BLOCKED', action: string): void {
    const failure = classifyError(error);
    transaction(this.db, () => {
      this.db.prepare('UPDATE project_operations SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, failure.code, now(), id);
      // Detail carries the failed stage/control constants for the operator, never UI text.
      // Distinct failures stay distinct notifications; identical repeats deduplicate.
      enqueueNotification(this.db, principal, `project:${id}:${state}:${failure.code}:${promptHash(failure.message).slice(0, 12)}`, { operationId: id, state, errorCode: failure.code, detail: failure.message.slice(0, 300), action });
    });
  }
  private saveResources(id: string, resources: Partial<ProjectResources>, phase: string | null = null): void {
    this.db.prepare('UPDATE project_operations SET resources=?,phase=?,updated_at=? WHERE id=? AND state=\'PROVISIONING\'').run(JSON.stringify(resources),phase, now(), id);
  }
  private assertGuiFree(id: string): void {
    if(this.db.prepare("SELECT 1 FROM project_operations WHERE state='PROVISIONING' AND id!=?").get(id) ||
       this.db.prepare("SELECT 1 FROM background_requests WHERE gui=1 AND state IN ('GENERATING','RUNNING')").get() ||
       this.db.prepare("SELECT 1 FROM execution_runs WHERE feedback_state='SENDING'").get())throw new BridgeError('CONFLICT','The GUI is currently occupied');
  }
  private async complete(id: string, input: Partial<ProjectResources>, context: CallerContext, scope: InitializationScope): Promise<void> {
    let resources={...input};
    if(!resources.chatgptConversationId) {
      this.db.prepare("UPDATE project_operations SET phase='gpt' WHERE id=?").run(id);
      const chat=await withDeadline(signal=>this.host!.createOrdinaryChat(resources.appProjectId!,resources.name!,signal,resources.initializationKey,scope),this.timeoutMs);
      resources.chatgptConversationId=chat.conversationId;this.saveResources(id,resources,'gpt.done');
    }
    const attached=(resources.codexConversationId ? 1 : 0)+(resources.extraCodexConversationIds?.length ?? 0);
    if(attached<(resources.codexConversations ?? 1) && (await withDeadline(signal=>this.host!.inspect(signal),this.timeoutMs)).createCodexConversation===false)return this.awaitAttach(id,resources,context);
    if(!resources.codexConversationId) {
      this.db.prepare("UPDATE project_operations SET phase='codex' WHERE id=?").run(id);
      let codex;
      try {codex=await withDeadline(signal=>this.host!.createCodexConversation(resources.appProjectId!,resources.workspacePath!,signal,resources.initializationKey,0,scope),this.timeoutMs);}
      catch(error){if(refusedBeforeEffect(error))return this.awaitAttach(id,resources,context,error);throw error;}
      resources.codexConversationId=codex.conversationId;this.saveResources(id,resources,'codex.done');
    }
    // Additional conversations are created one at a time; each formal receipt is saved before the next.
    for(let index=1+(resources.extraCodexConversationIds?.length ?? 0);index<(resources.codexConversations ?? 1);index++) {
      this.db.prepare("UPDATE project_operations SET phase='codex.extra' WHERE id=?").run(id);
      let codex;
      try {codex=await withDeadline(signal=>this.host!.createCodexConversation(resources.appProjectId!,resources.workspacePath!,signal,resources.initializationKey,index,scope),this.timeoutMs);}
      catch(error){if(refusedBeforeEffect(error))return this.awaitAttach(id,resources,context,error);throw error;}
      if([resources.codexConversationId,resources.chatgptConversationId,...(resources.extraCodexConversationIds ?? [])].includes(codex.conversationId))throw new BridgeError('PROVENANCE','Codex receipt repeats an existing conversation');
      resources.extraCodexConversationIds=[...(resources.extraCodexConversationIds ?? []),codex.conversationId];this.saveResources(id,resources,'codex.extra.done');
    }
    this.db.prepare("UPDATE project_operations SET phase='verify' WHERE id=?").run(id);
    const observed=await withDeadline(signal=>this.host!.verifyBundle(resources as ProjectResources,signal),this.timeoutMs);
    this.assertBundle(resources as ProjectResources,observed);this.registerBundle(id,resources as ProjectResources,context);
  }
  /** No formal creator, or one that refused before any effect: wait for the operator
   * to create conversations in this workspace and attach them; nothing is inferred. */
  private awaitAttach(id: string, resources: Partial<ProjectResources>, context: CallerContext, refusal?: unknown): void {
    const attached=(resources.codexConversationId ? 1 : 0)+(resources.extraCodexConversationIds?.length ?? 0);
    this.saveResources(id,resources,'codex.attach');
    transaction(this.db,()=>{
      this.db.prepare("UPDATE project_operations SET state='BLOCKED',error_code='CODEX_ATTACH_REQUIRED',updated_at=? WHERE id=? AND state='PROVISIONING'").run(now(),id);
      enqueueNotification(this.db,this.authority.resolve(context)!.principal,`project:${id}:codex-attach:${attached}`,{operationId:id,state:'BLOCKED',errorCode:'CODEX_ATTACH_REQUIRED',missing:(resources.codexConversations ?? 1)-attached,
        ...(refusal?{detail:classifyError(refusal).message.slice(0,300)}:{}),action:`Create the missing Codex conversation(s) in native workspace "${resources.name}" and attach each with acb_project_attach_codex`});
    });
  }
  private assertBundle(resources: ProjectResources, observed: Awaited<ReturnType<ProjectHost['verifyBundle']>>): void {
    if (!observed || observed.source !== 'application-host' || observed.kind !== 'ordinary-chat' || observed.workspaceSurface !== 'native-desktop' ||
        observed.codexNativeProjectId !== resources.appProjectId || Object.entries(resources).some(([key, value]) => JSON.stringify(observed[key as keyof ProjectResources]) !== JSON.stringify(value))) throw new BridgeError('PROVENANCE', 'Native project bundle and Codex membership could not be independently read back');
  }
  private registerBundle(id: string, resources: ProjectResources, context: CallerContext): void {
    const caller = this.authority.resolve(context)!;
    transaction(this.db, () => {
      const projectId = this.get(id, context).projectId, registry = new ConversationRegistry(this.db, this.authority);
      if (this.db.prepare('SELECT state FROM project_operations WHERE id=?').get(id)?.state !== 'PROVISIONING') throw new BridgeError('CONFLICT', 'Project operation changed');
      registry.registerProject(projectId, resources.name, resources.workspacePath, context);
      for (const codexConversationId of [resources.codexConversationId, ...(resources.extraCodexConversationIds ?? [])])
        registry.register({ projectId, workspacePath: resources.workspacePath, appProjectId: resources.appProjectId, chatgptConversationId: resources.chatgptConversationId, chatgptConversationName: resources.name, codexConversationId }, context);
      this.db.prepare("UPDATE project_operations SET state='READY',error_code=NULL,updated_at=? WHERE id=? AND state='PROVISIONING'").run(now(), id);
      enqueueNotification(this.db, caller.principal, `project:${id}:ready`, { operationId: id, projectId, state: 'READY' });
    });
  }
}
