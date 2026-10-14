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
export interface ProjectHost {
  authorizeInitialization?(name:string,path:string,signal:AbortSignal):Promise<void>;
  inspect(signal: AbortSignal): Promise<ProjectHostCapabilities>;
  createWorkspace(name: string, path: string, signal: AbortSignal): Promise<{ appProjectId: string; workspacePath: string }>;
  // appProjectId correlates this creation operation; ordinary GPT is not moved
  // into a Codex native project. verifyBundle must independently read its title.
  createOrdinaryChat(appProjectId: string, exactName: string, signal: AbortSignal, operationKey?: string): Promise<{ conversationId: string }>;
  /** index > 0 names an additional conversation of the same workspace. */
  createCodexConversation(appProjectId: string, workspacePath: string, signal: AbortSignal, operationKey?: string, index?: number): Promise<{ conversationId: string }>;
  /** Read-only: native workspaces registered for this directory, whatever their name. */
  nativeWorkspaces?(workspacePath: string, signal: AbortSignal): Promise<{ projectId: string; label: string }[]>;
  observePartial?(resources: Partial<ProjectResources>, phase: string, signal: AbortSignal): Promise<Partial<ProjectResources>>;
  /** Read-only native ownership check for a legacy mapping with recorded IDs. */
  verifyExisting?(input: { name: string; workspacePath: string; chatgptConversationId: string; codexConversationIds: string[] }, signal: AbortSignal): Promise<{ appProjectId: string }>;
  verifyBundle(resources: ProjectResources, signal: AbortSignal): Promise<ProjectBundleEvidence>;
}
export interface ProjectResources { initializationKey?: string; appProjectId: string; workspacePath: string; name: string; chatgptConversationId: string; codexConversationId: string; codexConversations?: number; extraCodexConversationIds?: string[] }
/** Directory creation and native registration are separate facts; only receipts count. */
export interface ProjectStages { directoryCreated: boolean; nativeWorkspace: boolean; gptConversation: boolean; codexConversations: number; codexRequested: number }
export interface ProjectOperation { id: string; projectId: string; name: string; workspacePath: string; state: string; errorCode: string | null; phase?: string | null; resources: Partial<ProjectResources> | null; stages?: ProjectStages }
const MAX_CODEX_CONVERSATIONS = 4, MAX_WORKSPACE_RESTARTS = 2;

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
    const resources: Partial<ProjectResources> | null = row.resources === null ? null : JSON.parse(String(row.resources));
    const stages: ProjectStages = { directoryCreated: !!resources?.workspacePath, nativeWorkspace: !!resources?.appProjectId, gptConversation: !!resources?.chatgptConversationId,
      codexConversations: (resources?.codexConversationId ? 1 : 0) + (resources?.extraCodexConversationIds?.length ?? 0), codexRequested: resources?.codexConversations ?? 1 };
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
    if(row.phase==='codex.extra')throw new BridgeError('UNSUPPORTED','An additional Codex creation has no durable receipt; do not infer an ID or resend');
    if(row.phase && !['workspace.done','gpt.done','codex.done','codex.extra.done','verify'].includes(String(row.phase))) {
      if(!this.host.observePartial)throw new BridgeError('PROVENANCE','Incomplete resources cannot be recreated during reconciliation');
      resources=await withDeadline(signal=>this.host!.observePartial!(resources,String(row.phase),signal),this.timeoutMs);
      const acknowledged=String(row.phase)==='workspace'?resources.appProjectId:String(row.phase)==='gpt'?resources.chatgptConversationId:resources.codexConversationId;
      if(!acknowledged)throw new BridgeError('PROVENANCE','The original creation has no exact receipt; do not create replacements');
    }
    if(!resources?.appProjectId || resources.name!==operation.name || (process.platform==='win32'?resolve(resources.workspacePath!).toLowerCase():resolve(resources.workspacePath!))!==(process.platform==='win32'?resolve(operation.workspacePath).toLowerCase():resolve(operation.workspacePath)))throw new BridgeError('PROVENANCE','Incomplete resources cannot be recreated during reconciliation');
    transaction(this.db,()=>{
      this.assertGuiFree(id);
      this.db.prepare("UPDATE project_operations SET state='PROVISIONING',owner_token=?,resources=?,updated_at=? WHERE id=? AND state='UNCERTAIN'").run(processOwner(),JSON.stringify(resources),now(),id);
    });
    try {await this.complete(id,resources,context);}
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
    await withDeadline(signal => this.host!.authorizeInitialization!(operation.name, path, signal), this.timeoutMs);
    transaction(this.db, () => {
      this.assertGuiFree(id);
      if (this.db.prepare("UPDATE project_operations SET state='PROVISIONING',owner_token=?,error_code=NULL,updated_at=? WHERE id=? AND state='UNCERTAIN' AND phase='workspace'").run(processOwner(), now(), id).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), caller.principal, 'project_workspace_restart', `operation=${id}`);
    });
    try { await this.createWorkspaceAndComplete(id, operation.name, path, resources.codexConversations ?? 1, context); }
    catch (error) { this.recordFailure(id, caller.principal, error, 'UNCERTAIN', 'Reconcile recorded resources before retry'); }
    return this.get(id, context);
  }
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
      // Refuse before any directory/UI effect when Codex conversations cannot be created.
      if (capabilities.createCodexConversation === false) throw new BridgeError('UNSUPPORTED', 'A formal native Codex creation callback is required before creating the bundle');
      for (let current = this.root; ; current = dirname(current)) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new BridgeError('CONFIG', 'Workspace parent cannot be a symbolic link');
        if (dirname(current) === current) break;
      }
      if (existsSync(path)) throw new BridgeError('CONFLICT', 'Existing workspace ownership is unknown; refusing to reuse it');
      if(!this.host.authorizeInitialization)throw new BridgeError('AUTH','Target-bound host approval is required before creating local resources');
      await withDeadline(signal=>this.host!.authorizeInitialization!(name,path,signal),this.timeoutMs);
      effectsStarted = true;
      // An existing root (including a drive root such as D:\) is used as is;
      // mkdir on a Windows drive root fails with EPERM even with recursive.
      if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
      else if (!lstatSync(this.root).isDirectory()) throw new BridgeError('CONFIG', 'Workspace root is not a directory');
      mkdirSync(path);
      this.saveResources(id, { workspacePath: path, name, codexConversations });
      await this.createWorkspaceAndComplete(id, name, path, codexConversations, context);
    } catch (error) {
      this.recordFailure(id, caller.principal, error, effectsStarted ? 'UNCERTAIN' : 'BLOCKED', effectsStarted ? 'Reconcile recorded resources before retry' : 'Install and verify authorized host capabilities');
    }
    return this.get(id, context);
  }
  private async createWorkspaceAndComplete(id: string, name: string, path: string, codexConversations: number, context: CallerContext): Promise<void> {
    this.db.prepare("UPDATE project_operations SET phase='workspace' WHERE id=?").run(id);
    const workspace = await withDeadline(signal => this.host!.createWorkspace(name, path, signal), this.timeoutMs);
    requireNoSecrets(JSON.stringify(workspace));
    if (!workspace.appProjectId || resolve(workspace.workspacePath) !== path) throw new BridgeError('PROVENANCE', 'Host created a different workspace');
    const resources = { ...workspace, name, initializationKey: id, codexConversations };
    this.saveResources(id, resources, 'workspace.done');
    await this.complete(id, resources, context);
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
  private async complete(id: string, input: Partial<ProjectResources>, context: CallerContext): Promise<void> {
    let resources={...input};
    if(!resources.chatgptConversationId) {
      this.db.prepare("UPDATE project_operations SET phase='gpt' WHERE id=?").run(id);
      const chat=await withDeadline(signal=>this.host!.createOrdinaryChat(resources.appProjectId!,resources.name!,signal,resources.initializationKey),this.timeoutMs);
      resources.chatgptConversationId=chat.conversationId;this.saveResources(id,resources,'gpt.done');
    }
    if(!resources.codexConversationId) {
      if((await withDeadline(signal=>this.host!.inspect(signal),this.timeoutMs)).createCodexConversation===false)throw new BridgeError('UNSUPPORTED','Native Codex creation host is missing; the recorded GPT is preserved');
      this.db.prepare("UPDATE project_operations SET phase='codex' WHERE id=?").run(id);
      const codex=await withDeadline(signal=>this.host!.createCodexConversation(resources.appProjectId!,resources.workspacePath!,signal,resources.initializationKey),this.timeoutMs);
      resources.codexConversationId=codex.conversationId;this.saveResources(id,resources,'codex.done');
    }
    // Additional conversations are created one at a time; each formal receipt is saved before the next.
    for(let index=1+(resources.extraCodexConversationIds?.length ?? 0);index<(resources.codexConversations ?? 1);index++) {
      this.db.prepare("UPDATE project_operations SET phase='codex.extra' WHERE id=?").run(id);
      const codex=await withDeadline(signal=>this.host!.createCodexConversation(resources.appProjectId!,resources.workspacePath!,signal,resources.initializationKey,index),this.timeoutMs);
      if([resources.codexConversationId,resources.chatgptConversationId,...(resources.extraCodexConversationIds ?? [])].includes(codex.conversationId))throw new BridgeError('PROVENANCE','Codex receipt repeats an existing conversation');
      resources.extraCodexConversationIds=[...(resources.extraCodexConversationIds ?? []),codex.conversationId];this.saveResources(id,resources,'codex.extra.done');
    }
    this.db.prepare("UPDATE project_operations SET phase='verify' WHERE id=?").run(id);
    const observed=await withDeadline(signal=>this.host!.verifyBundle(resources as ProjectResources,signal),this.timeoutMs);
    this.assertBundle(resources as ProjectResources,observed);this.registerBundle(id,resources as ProjectResources,context);
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
