import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDb, DEFAULT_DB_PATH, now, uuid, transaction } from './db.ts';
import { TaskStore, type TaskResult } from './tasks.ts';
import { CallerAuthority, localCaller, type CallerContext } from './caller.ts';
import { EXECUTORS, TASK_STATUSES, type Executor, type TaskStatus } from './types.ts';
import { readCodexState, syncCodexToBridge } from './codex.ts';
import { readPiStatus } from './pi.ts';
import { readChatgptStatus, importChatgptExport, fetchChatgptServiceStatus, readChatgptAppStatus } from './chatgpt.ts';
import { readHermesStatus } from './hermes.ts';
import { codexAvailable, codexContentReadLimitation } from './codex-ops.ts';

const HELP = `Agent Control Bridge CLI
  init                          Initialize schema only; no Agent actions
  projects | status | audit | sweep
  task-create -t <title> [-k <kind>] [-e codex|pi|chatgpt|hermes] [-p <projectId>]
  task-list [--status QUEUED|RUNNING|WAITING_APPROVAL|BLOCKED|SUCCEEDED|FAILED|CANCELLED|UNKNOWN]
  task-show <id>
  task-claim <id> --version <n> [-e <executor>] [--lease <seconds>]
  task-finish <id> --version <n> [-e <executor>] [--note <text>]
  task-renew <id> --version <n> [--lease <seconds>]
  task-resume <id> --version <n>
  task-verify <id> --version <n> --pass|--fail [--by <authenticated principal/executor>] [--reason <text>]
  task-cancel <id> --version <n> [--by <label>] [--reason <text>]
  approval-request <taskId> --action <name>
  approval-decide <id> --decision approved|rejected [--reason <text>]
  codex-status | codex-sync | codex-limits | pi-status | hermes-status | chatgpt-status
  chatgpt-import <conversations.json> [--output <new.md>]
  markdown-import <file.md> [--task <id>] [--kind <name>]
  codex-fork-request <threadId>     Record request only; never executes fork
Identity comes from OS principal + protected config/caller-policy.json.
--by/-e do not grant permissions. Default CLI caller is pi, no reviewer rights.
Errors go to stderr; exit 2=input, 3=auth/owner, 4=state/conflict, 1=I/O.
`;
type Option = { type: 'string' | 'boolean'; short?: string };
const str = (short?: string): Option => ({ type: 'string', ...(short ? { short } : {}) });
const version = { version: str() };
const definitions: Record<string, { args: number; write?: boolean; options?: Record<string, Option> }> = {
  init: { args: 0, write: true }, projects: { args: 0 }, status: { args: 0 }, audit: { args: 0 }, sweep: { args: 0, write: true },
  'task-create': { args: 0, write: true, options: { title: str('t'), kind: str('k'), executor: str('e'), project: str('p') } },
  'task-list': { args: 0, options: { status: str(), executor: str('e') } }, 'task-show': { args: 1 },
  'task-claim': { args: 1, write: true, options: { ...version, executor: str('e'), lease: str() } },
  'task-finish': { args: 1, write: true, options: { ...version, executor: str('e'), note: str() } },
  'task-renew': { args: 1, write: true, options: { ...version, lease: str() } },
  'task-resume': { args: 1, write: true, options: version },
  'task-verify': { args: 1, write: true, options: { ...version, pass: { type: 'boolean' }, fail: { type: 'boolean' }, by: str(), reason: str() } },
  'task-cancel': { args: 1, write: true, options: { ...version, by: str(), reason: str() } },
  'approval-request': { args: 1, write: true, options: { action: str() } },
  'approval-decide': { args: 1, write: true, options: { decision: str(), reason: str() } },
  'codex-status': { args: 0 }, 'codex-sync': { args: 0, write: true }, 'codex-limits': { args: 0 },
  'pi-status': { args: 0 }, 'hermes-status': { args: 0 }, 'chatgpt-status': { args: 0 },
  'chatgpt-import': { args: 1, write: true, options: { output: str() } },
  'markdown-import': { args: 1, write: true, options: { task: str(), kind: str() } },
  'codex-fork-request': { args: 1, write: true },
};
class CliError extends Error { exit: number; constructor(message: string, exit: number) { super(message); this.exit = exit; } }
function number(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError(`INPUT: invalid ${name}`, 2);
  return Number(value);
}
function checkResult(result: TaskResult): void {
  if (!result.ok) throw new CliError(`${result.code}: ${result.error}`, ['AUTH','OWNER'].includes(result.code) ? 3 : result.code === 'INPUT' ? 2 : 4);
}
export interface CliDependencies {
  // Trusted host injection, never populated from argv or process.env.
  db?: DatabaseSync; authority?: CallerAuthority; context?: CallerContext;
  stdout?: (text: string) => void; stderr?: (text: string) => void;
}

export function runCli(argv: string[], dependencies: CliDependencies = {}): number {
  const output = dependencies.stdout ?? (text => console.log(text));
  const errorOutput = dependencies.stderr ?? (text => console.error(text));
  let db: DatabaseSync | undefined, ownsDb = false;
  try {
    const [command, ...args] = argv;
    if (!command || ['help','--help','-h'].includes(command)) { output(HELP); return 0; }
    const definition = definitions[command];
    if (!definition) throw new CliError('INPUT: unknown command; use help', 2);
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs({ args, strict: true, allowPositionals: true, options: definition.options ?? {} }); }
    catch { throw new CliError('INPUT: unknown/missing/invalid option; use help', 2); }
    if (parsed.positionals.length !== definition.args || parsed.positionals.some(p => !p.trim())) throw new CliError('INPUT: wrong positional arguments; use help', 2);
    const v = parsed.values, id = parsed.positionals[0];
    // Reject duplicate flags; avoid ambiguous aliases or conflicting decisions.
    const flags = args.filter(a => a.startsWith('-')).map(a => a.split('=')[0]);
    if (new Set(flags).size !== flags.length) throw new CliError('INPUT: duplicate options', 2);
    if (v.executor !== undefined && !EXECUTORS.includes(v.executor as Executor)) throw new CliError('INPUT: invalid executor', 2);
    if (v.status !== undefined && !TASK_STATUSES.includes(v.status as TaskStatus)) throw new CliError('INPUT: invalid status', 2);
    if (command === 'task-verify' && Boolean(v.pass) === Boolean(v.fail)) throw new CliError('INPUT: exactly one of --pass/--fail is required', 2);
    if (command === 'approval-decide' && !['approved','rejected'].includes(String(v.decision))) throw new CliError('INPUT: invalid approval decision', 2);
    if (command === 'approval-request' && (typeof v.action !== 'string' || !v.action.trim())) throw new CliError('INPUT: --action required', 2);
    const expected = definition.options?.version ? number(v.version, 'version') : undefined;
    const seconds = definition.options?.lease ? number(v.lease, 'lease', 600) : 600;
    if (seconds < 1 || seconds > 86400) throw new CliError('INPUT: lease must be 1..86400 seconds', 2);

    const authority = dependencies.authority ?? new CallerAuthority();
    let context = dependencies.context, authorizedSids: string[] = [];
    if (definition.write && !context) {
      const caller = localCaller(authority, fileURLToPath(new URL('../config/caller-policy.json', import.meta.url)));
      context = caller.context; authorizedSids = caller.authorizedSids;
    }
    if (definition.write) {
      const caller = authority.resolve(context);
      if (!caller) throw new CliError('AUTH: authorized caller context required', 3);
      // --by is only an assertion/label. It cannot mint or elevate an identity.
      if (v.by !== undefined && String(v.by) !== caller.principal && String(v.by) !== caller.executor) throw new CliError('AUTH: --by cannot override authenticated caller', 3);
      if (command === 'task-verify' && !caller.reviewer) throw new CliError('AUTH: independent reviewer capability required', 3);
      if (['task-claim','task-finish'].includes(command) && v.executor && v.executor !== caller.executor) throw new CliError('AUTH: executor flag does not match authenticated caller', 3);
    }
    // No DB is opened for help/argument/auth failures or provider-only reads.
    const providerOnly = ['codex-status','codex-limits','pi-status','hermes-status'].includes(command);
    if (!providerOnly) {
      if (dependencies.db) db = dependencies.db;
      else {
        ownsDb = true;
        if (definition.write) db = createDb({ authorizedSids });
        else {
          if (!existsSync(DEFAULT_DB_PATH)) throw new CliError('IO: database absent; run init', 1);
          db = new DatabaseSync(DEFAULT_DB_PATH, { readOnly: true });
          db.exec('PRAGMA busy_timeout=5000; PRAGMA query_only=ON;');
        }
      }
    }
    const store = db ? new TaskStore(db, authority) : undefined;
    const print = (value: unknown) => output(JSON.stringify(value, null, 2));
    switch (command) {
      case 'init': output('Schema initialized; no projects or Agent actions created'); break;
      case 'projects': print(db!.prepare('SELECT * FROM projects').all()); break;
      case 'task-create': print(store!.createTask({ kind: String(v.kind ?? 'dev'), title: String(v.title ?? 'untitled'), executor: v.executor as Executor | undefined, projectId: v.project as string | undefined }, context!)); break;
      case 'task-list': print(store!.listTasks({ status: v.status as TaskStatus | undefined, executor: v.executor as Executor | undefined })); break;
      case 'task-show': {
        const task = store!.getTask(id);
        if (!task) throw new CliError('NOT_FOUND: task not found', 4);
        print({ task, events: db!.prepare('SELECT type,source,observed_at FROM events WHERE task_id=? ORDER BY id').all(id) }); break;
      }
      case 'task-claim': { const r = store!.claim(id, context!, seconds, expected); checkResult(r); print(r); break; }
      case 'task-finish': { const r = store!.executorFinished(id, context!, v.note as string | undefined, expected); checkResult(r); print(r); break; }
      case 'task-renew': { const r = store!.renew(id, context!, seconds, expected); checkResult(r); print(r); break; }
      case 'task-resume': { const r = store!.resume(id, context!, expected); checkResult(r); print(r); break; }
      case 'task-verify': { const r = store!.verify(id, context!, Boolean(v.pass), v.reason as string | undefined, expected); checkResult(r); print(r); break; }
      case 'task-cancel': { const r = store!.cancel(id, context!, v.reason as string | undefined, expected); checkResult(r); print(r); break; }
      case 'approval-request': print({ approvalId: store!.requestApproval(id, String(v.action), context!) }); break;
      case 'approval-decide': store!.decideApproval(id, v.decision as 'approved' | 'rejected', context!, v.reason as string | undefined); output('Approval decision recorded; no control command executed'); break;
      case 'sweep': print(store!.sweepExpiredLeases(context!)); break;
      case 'codex-status': { const state = readCodexState(); if ('error' in state) throw new CliError('IO: Codex state unavailable', 1); print(state); break; }
      case 'codex-sync': {
        const state = readCodexState(); if ('error' in state) throw new CliError('IO: Codex state unavailable', 1);
        print(transaction(db!, () => { const result = syncCodexToBridge(db!, state); store!.recordAudit(context!, 'codex_sync', 'snapshot imported'); return result; })); break;
      }
      case 'pi-status': print(readPiStatus()); break;
      case 'hermes-status': print(readHermesStatus()); break;
      case 'chatgpt-status': print({ sync: readChatgptStatus(db!), app: readChatgptAppStatus(), service: fetchChatgptServiceStatus() }); break;
      case 'status': print({ hermes: readHermesStatus(), pi: readPiStatus(), codex: readCodexState(), chatgpt: readChatgptStatus(db!), service: fetchChatgptServiceStatus(), tasks: db!.prepare('SELECT status,COUNT(*) n FROM tasks GROUP BY status').all() }); break;
      case 'chatgpt-import': { const result = importChatgptExport(db!, id, v.output as string | undefined); if ('error' in result) throw new CliError(`IO: ${result.error}`, 1); print(result); break; }
      case 'markdown-import': {
        const path = resolve(id), content = readFileSync(path);
        const hash = createHash('sha256').update(content).digest('hex');
        transaction(db!, () => {
          db!.prepare('INSERT INTO deliverables(id,task_id,path,kind,hash,produced_at) VALUES(?,?,?,?,?,?)').run(uuid(), v.task as string ?? null, path, v.kind as string ?? 'handoff', hash, now());
          store!.recordAudit(context!, 'markdown_import', `hash=${hash}`);
        }); print({ path, hash }); break;
      }
      case 'codex-fork-request': print(store!.createTaskWithApproval({ kind: 'session_fork', title: `fork Codex ${id}`, executor: 'codex' }, 'fork_session', context!)); break;
      case 'codex-limits': print({ available: codexAvailable(), limitation: codexContentReadLimitation() }); break;
      case 'audit': print(db!.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 20').all()); break;
    }
    return 0;
  } catch (error) {
    if (error instanceof CliError) { errorOutput(error.message); return error.exit; }
    // No raw SQL/JSON/exception dump; it may contain sensitive imported input.
    errorOutput('IO: operation failed and transaction rolled back; check permissions/schema/input'); return 1;
  } finally { if (ownsDb && db) db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = runCli(process.argv.slice(2));
