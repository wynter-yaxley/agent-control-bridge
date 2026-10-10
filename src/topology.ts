import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { transaction, now } from './db.ts';
import { BridgeError } from './errors.ts';
import { requireNoSecrets } from './security.ts';

export class ConversationRegistry {
  private db: DatabaseSync;
  private authority: CallerAuthority;
  constructor(db: DatabaseSync, authority: CallerAuthority) { this.db = db; this.authority = authority; }
  private controller(context: CallerContext) {
    const caller = this.authority.resolve(context);
    if (!caller?.reviewer || caller.executor !== 'hermes') throw new BridgeError('AUTH', 'Trusted Hermes context required for conversation mappings');
    return caller;
  }
  registerProject(id: string, name: string, root: string, context: CallerContext): void {
    const caller = this.controller(context);
    for (const value of [id,name,root]) { if (!value.trim() || value.length>4096) throw new BridgeError('INPUT','Invalid project'); requireNoSecrets(value); }
    transaction(this.db,()=>{
      if (this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) throw new BridgeError('CONFLICT','Project already registered; refusing overwrite');
      this.db.prepare('INSERT INTO projects(id,name,root_path,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,name,resolve(root),'bridge',now(),now());
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(),caller.principal,'project_register',`project=${id}`);
    });
  }
  register(input: { projectId: string; workspacePath: string; chatgptConversationId: string; chatgptConversationName: string; codexConversationId: string }, context: CallerContext): void {
    const caller = this.controller(context);
    for (const value of Object.values(input)) {
      if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new BridgeError('INPUT', 'Invalid conversation mapping');
      requireNoSecrets(value);
    }
    const workspace = resolve(input.workspacePath);
    const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
    transaction(this.db, () => {
      const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(input.projectId);
      if (!project) throw new BridgeError('NOT_FOUND', 'Register the project before its conversations');
      if(input.chatgptConversationName!==project.name) throw new BridgeError('PROVENANCE','GPT conversation name must exactly match the workspace project name');
      const rootKey=resolve(String(project.root_path));
      if ((process.platform==='win32'?rootKey.toLowerCase():rootKey)!==key) throw new BridgeError('CONFLICT','Workspace must match the registered project root');
      const existing = this.db.prepare('SELECT * FROM conversation_workspaces WHERE project_id=?').get(input.projectId);
      if (existing && (existing.workspace_key !== key || existing.chatgpt_conversation_id !== input.chatgptConversationId || existing.chatgpt_conversation_name!==input.chatgptConversationName)) throw new BridgeError('CONFLICT', 'A project has exactly one workspace and one GPT conversation; mappings are immutable');
      const other = this.db.prepare('SELECT project_id FROM codex_conversations WHERE conversation_id=?').get(input.codexConversationId);
      if (other && other.project_id !== input.projectId) throw new BridgeError('CONFLICT', 'Codex conversation already belongs to another project');
      this.db.prepare('INSERT OR IGNORE INTO conversation_workspaces(project_id,workspace_path,workspace_key,chatgpt_conversation_id,chatgpt_conversation_name,registered_at) VALUES(?,?,?,?,?,?)').run(input.projectId, workspace, key, input.chatgptConversationId, input.chatgptConversationName, now());
      this.db.prepare('INSERT OR IGNORE INTO codex_conversations(conversation_id,project_id) VALUES(?,?)').run(input.codexConversationId, input.projectId);
      this.db.prepare('INSERT INTO audit_log(at,actor,action,detail) VALUES(?,?,?,?)').run(now(), caller.principal, 'conversation_mapping', `project=${input.projectId}`);
    });
  }
  forTask(taskId: string) {
    const mapping = this.db.prepare('SELECT w.*,p.name AS project_name FROM conversation_workspaces w JOIN tasks t ON t.project_id=w.project_id JOIN projects p ON p.id=w.project_id WHERE t.id=?').get(taskId);
    if (!mapping) throw new BridgeError('PROVENANCE', 'Production tasks require a registered project/workspace/GPT conversation');
    return mapping;
  }
  assertExecution(taskId: string, conversationId: string | undefined, workspacePath: string | undefined): void {
    const mapping = this.forTask(taskId);
    const key = workspacePath ? resolve(workspacePath) : '';
    if ((process.platform === 'win32' ? key.toLowerCase() : key) !== mapping.workspace_key || !conversationId ||
        !this.db.prepare('SELECT 1 FROM codex_conversations WHERE conversation_id=? AND project_id=?').get(conversationId, mapping.project_id)) throw new BridgeError('PROVENANCE', 'Execution receipt does not match the registered Codex workspace/conversation');
  }
}
