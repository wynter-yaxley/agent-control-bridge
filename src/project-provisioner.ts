import type { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { now, transaction, uuid } from './db.ts';
import { BridgeError, classifyError } from './errors.ts';
import { withDeadline } from './deadline.ts';
import { promptHash } from './prompts.ts';
import { ConversationRegistry } from './topology.ts';
import { assertOrdinaryChatCapabilities, type OrdinaryChatCapabilities } from './ordinary-chat.ts';
import { enqueueNotification } from './outbox.ts';
import { requireNoSecrets } from './security.ts';

export interface ProjectHostCapabilities extends OrdinaryChatCapabilities {
  /** Observed by trusted host code; independent App Server projects are insufficient. */
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
  inspect(signal: AbortSignal): Promise<ProjectHostCapabilities>;
  createWorkspace(name: string, path: string, signal: AbortSignal): Promise<{ appProjectId: string; workspacePath: string }>;
  // appProjectId correlates this creation operation; ordinary GPT is not moved
  // into a Codex native project. verifyBundle must independently read its title.
  createOrdinaryChat(appProjectId: string, exactName: string, signal: AbortSignal): Promise<{ conversationId: string }>;
  createCodexConversation(appProjectId: string, workspacePath: string, signal: AbortSignal): Promise<{ conversationId: string }>;
  verifyBundle(resources: ProjectResources, signal: AbortSignal): Promise<ProjectBundleEvidence>;
}
export interface ProjectResources { appProjectId: string; workspacePath: string; name: string; chatgptConversationId: string; codexConversationId: string }
export interface ProjectOperation { id: string; projectId: string; name: string; workspacePath: string; state: string; errorCode: string | null }

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
    return { id: String(row.id), projectId: String(row.project_id), name: String(row.name), workspacePath: String(row.root_path), state: String(row.state), errorCode: row.error_code === null ? null : String(row.error_code) };
  }
  async reconcile(id: string, context: CallerContext): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller || caller.executor !== 'hermes') throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    const operation = this.get(id, context);
    if (operation.state === 'READY') return operation;
    if (operation.state !== 'UNCERTAIN' || !this.host) throw new BridgeError('STATE', 'Recorded uncertain resources and an authorized host are required');
    const record = this.db.prepare('SELECT resources FROM project_operations WHERE id=?').get(id)!;
    let resources: ProjectResources;
    try { resources = JSON.parse(String(record.resources)); } catch { throw new BridgeError('PROVENANCE', 'Project resources are invalid'); }
    if (!resources || ['appProjectId', 'workspacePath', 'name', 'chatgptConversationId', 'codexConversationId'].some(key => typeof resources[key as keyof ProjectResources] !== 'string' || !resources[key as keyof ProjectResources].trim()) ||
        resources.name !== operation.name || (process.platform === 'win32' ? resolve(resources.workspacePath).toLowerCase() !== resolve(operation.workspacePath).toLowerCase() : resolve(resources.workspacePath) !== resolve(operation.workspacePath))) throw new BridgeError('PROVENANCE', 'Incomplete resources cannot be recreated during reconciliation');
    requireNoSecrets(JSON.stringify(resources));
    transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM project_operations WHERE state IN ('PROVISIONING','UNCERTAIN') AND id!=?").get(id) ||
          this.db.prepare("SELECT 1 FROM background_requests WHERE state IN ('GENERATING','RUNNING','UNCERTAIN')").get() || this.db.prepare("SELECT 1 FROM execution_runs WHERE state IN ('RUNNING','UNCERTAIN')").get()) throw new BridgeError('CONFLICT', 'Shared host is occupied');
      if (this.db.prepare("UPDATE project_operations SET state='PROVISIONING',updated_at=? WHERE id=? AND state='UNCERTAIN'").run(now(), id).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
    });
    try {
      const observed = await withDeadline(signal => this.host!.verifyBundle(resources, signal), this.timeoutMs);
      this.assertBundle(resources, observed);
      this.registerBundle(id, resources, context);
    } catch (error) {
      transaction(this.db, () => {
        const code = classifyError(error).code;
        this.db.prepare("UPDATE project_operations SET state='UNCERTAIN',error_code=?,updated_at=? WHERE id=? AND state='PROVISIONING'").run(code, now(), id);
        enqueueNotification(this.db, caller.principal, `project:${id}:reconcile:${code}`, { operationId: id, state: 'UNCERTAIN', errorCode: code });
      });
    }
    return this.get(id, context);
  }
  async prepare(name: string, eventKey: string, context: CallerContext): Promise<ProjectOperation> {
    const caller = this.authority.resolve(context);
    if (!caller?.controller || caller.executor !== 'hermes') throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new BridgeError('INPUT', 'Project name is not a valid workspace name');
    if (typeof eventKey !== 'string' || !eventKey.trim() || eventKey.length > 4096) throw new BridgeError('INPUT', 'Invalid project request key');
    requireNoSecrets(name); requireNoSecrets(eventKey);
    const path = resolve(this.root, name);
    if (dirname(path) !== this.root) throw new BridgeError('INPUT', 'Workspace must stay inside the configured root');
    const fingerprint = promptHash(JSON.stringify({ name, path }));
    const existing = this.db.prepare('SELECT * FROM project_operations WHERE principal=? AND event_key=?').get(caller.principal, eventKey);
    if (existing && existing.request_hash !== fingerprint) throw new BridgeError('CONFLICT', 'Project request key was reused');
    if (existing && !(existing.state === 'BLOCKED' && existing.resources === null && this.host)) return this.get(String(existing.id), context);
    const id = existing ? String(existing.id) : uuid();
    transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM background_requests WHERE state IN ('GENERATING','RUNNING','UNCERTAIN')").get() || this.db.prepare("SELECT 1 FROM execution_runs WHERE state IN ('RUNNING','UNCERTAIN')").get()) throw new BridgeError('CONFLICT', 'Background host is occupied or awaiting reconciliation');
      if (this.db.prepare("SELECT 1 FROM project_operations WHERE state IN ('PROVISIONING','UNCERTAIN') AND id!=?").get(id)) throw new BridgeError('CONFLICT', 'Another native project operation is active or awaiting reconciliation');
      if (!existing) {
        const pathKey = process.platform === 'win32' ? path.toLowerCase() : path;
        if (this.db.prepare('SELECT 1 FROM project_operations WHERE root_path=?').get(pathKey)) throw new BridgeError('CONFLICT', 'Workspace is already reserved');
        this.db.prepare("INSERT INTO project_operations(id,principal,event_key,request_hash,project_id,name,root_path,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PROVISIONING',?,?)").run(id, caller.principal, eventKey, fingerprint, uuid(), name, pathKey, now(), now());
      } else if (this.db.prepare("UPDATE project_operations SET state='PROVISIONING',error_code=NULL,updated_at=? WHERE id=? AND state='BLOCKED' AND resources IS NULL").run(now(), id).changes !== 1) throw new BridgeError('CONFLICT', 'Project operation changed');
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
      effectsStarted = true;
      mkdirSync(this.root, { recursive: true }); mkdirSync(path);
      this.saveResources(id, { workspacePath: path, name });
      const workspace = await withDeadline(signal => this.host!.createWorkspace(name, path, signal), this.timeoutMs);
      requireNoSecrets(JSON.stringify(workspace));
      if (!workspace.appProjectId || resolve(workspace.workspacePath) !== path) throw new BridgeError('PROVENANCE', 'Host created a different workspace');
      this.saveResources(id, { ...workspace, name });
      const chat = await withDeadline(signal => this.host!.createOrdinaryChat(workspace.appProjectId, name, signal), this.timeoutMs);
      requireNoSecrets(JSON.stringify(chat));
      this.saveResources(id, { ...workspace, name, chatgptConversationId: chat.conversationId });
      const codex = await withDeadline(signal => this.host!.createCodexConversation(workspace.appProjectId, path, signal), this.timeoutMs);
      requireNoSecrets(JSON.stringify(codex));
      const resources: ProjectResources = { ...workspace, name, chatgptConversationId: chat.conversationId, codexConversationId: codex.conversationId };
      this.saveResources(id, resources);
      const observed = await withDeadline(signal => this.host!.verifyBundle(resources, signal), this.timeoutMs);
      this.assertBundle(resources, observed);
      this.registerBundle(id, resources, context);
    } catch (error) {
      const code = classifyError(error).code, state = effectsStarted ? 'UNCERTAIN' : 'BLOCKED';
      transaction(this.db, () => {
        this.db.prepare('UPDATE project_operations SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, code, now(), id);
        enqueueNotification(this.db, caller.principal, `project:${id}:${state}:${code}`, { operationId: id, state, errorCode: code, action: effectsStarted ? 'Reconcile recorded resources before retry' : 'Install and verify authorized host capabilities' });
      });
    }
    return this.get(id, context);
  }
  private saveResources(id: string, resources: Partial<ProjectResources>): void {
    this.db.prepare('UPDATE project_operations SET resources=?,updated_at=? WHERE id=? AND state=\'PROVISIONING\'').run(JSON.stringify(resources), now(), id);
  }
  private assertBundle(resources: ProjectResources, observed: Awaited<ReturnType<ProjectHost['verifyBundle']>>): void {
    if (!observed || observed.source !== 'application-host' || observed.kind !== 'ordinary-chat' || observed.workspaceSurface !== 'native-desktop' ||
        observed.codexNativeProjectId !== resources.appProjectId || Object.entries(resources).some(([key, value]) => observed[key as keyof ProjectResources] !== value)) throw new BridgeError('PROVENANCE', 'Native project bundle and Codex membership could not be independently read back');
  }
  private registerBundle(id: string, resources: ProjectResources, context: CallerContext): void {
    const caller = this.authority.resolve(context)!;
    transaction(this.db, () => {
      const projectId = this.get(id, context).projectId, registry = new ConversationRegistry(this.db, this.authority);
      if (this.db.prepare('SELECT state FROM project_operations WHERE id=?').get(id)?.state !== 'PROVISIONING') throw new BridgeError('CONFLICT', 'Project operation changed');
      registry.registerProject(projectId, resources.name, resources.workspacePath, context);
      registry.register({ projectId, workspacePath: resources.workspacePath, appProjectId: resources.appProjectId, chatgptConversationId: resources.chatgptConversationId, chatgptConversationName: resources.name, codexConversationId: resources.codexConversationId }, context);
      this.db.prepare("UPDATE project_operations SET state='READY',error_code=NULL,updated_at=? WHERE id=? AND state='PROVISIONING'").run(now(), id);
      enqueueNotification(this.db, caller.principal, `project:${id}:ready`, { operationId: id, projectId, state: 'READY' });
    });
  }
}
