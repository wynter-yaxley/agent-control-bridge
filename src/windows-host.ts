#!/usr/bin/env node
import type {DeliveryTarget} from './prompts.ts';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {CallerAuthority,localCaller,delegatedExecutor,policySummary,type CallerContext} from './caller.ts';
import {loadConfig} from './config.ts';
import {createDb} from './db.ts';
import {BackgroundBridge,type BackgroundHostBindings} from './background.ts';
import {runMcp} from './mcp.ts';
import {createCodexAppServerExecutor} from './codex-app-server.ts';
import {createWindowsNativeReadTools,closeWindowsNativeUiWorkers,createWindowsNativeProjectHost,findNativeThread,WindowsNativeUi,type WindowsNativeTools} from './windows-native-host.ts';
import {createLedgerCodexApproval,createLedgerInitializationApproval} from './trusted-host.ts';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {connect} from 'node:net';
import {SCHEMA_VERSION} from './migrations.ts';
import type {BridgeConfig} from './config.ts';
import {closeNativeReadWorker,NativeDesktopReadClient} from './native-readonly.ts';
import {BridgeError,classifyError,EXIT_CODES} from './errors.ts';

const POLICY=fileURLToPath(new URL('../config/caller-policy.json',import.meta.url));
type HostServices={config:BridgeConfig;authority:CallerAuthority;context:CallerContext;db:DatabaseSync};

/** Bindings available without an embedding, all from the protected policy:
 * a read-only native project host (creation is refused, reconcile/adopt read
 * back), and for a controller only the executor its policy entry delegates,
 * with ledger approvals decided by an independent reviewer. No GUI approval. */
export function policyBindings(services:HostServices,native?:WindowsNativeTools,policyPath=POLICY):BackgroundHostBindings {
  const bindings:BackgroundHostBindings={},controller=services.authority.resolve(services.context)?.controller===true;
  if(native) {
    // Creation needs desktop.enabled and an independent reviewer's ledger approval;
    // otherwise the host only reads back (reconcile/adopt/attach) and refuses creation.
    const creation=controller && services.config.desktop.enabled;
    const host=createWindowsNativeProjectHost({config:services.config,native,authorizeInitialization:creation?createLedgerInitializationApproval({db:services.db,authority:services.authority,controller:services.context,timeoutMs:services.config.background.timeoutMs}):async()=>false});
    bindings.projects=creation?host:{...host,inspect:async signal=>({...await host.inspect(signal),createWorkspace:false,createOrdinaryChat:false})};
  }
  if(!controller)return bindings;
  const executorContext=delegatedExecutor(services.authority,policyPath,services.context);
  if(executorContext)Object.assign(bindings,{executorContext,approveCodex:createLedgerCodexApproval({db:services.db,authority:services.authority,executor:executorContext,timeoutMs:services.config.background.timeoutMs})});
  return bindings;
}
/** Names every missing worker prerequisite instead of one generic refusal. */
export function executorGaps(config:BridgeConfig,bindings:BackgroundHostBindings,carrierThread?:string):string[] {
  return [...(!bindings.executorContext?['EXECUTOR_DELEGATION_MISSING']:[]),...(!carrierThread?['CARRIER_THREAD_MISSING']:[]),
    ...(!config.agents.codex.executable?['CODEX_EXECUTABLE_MISSING']:[]),...(!config.agents.codex.model || !config.agents.codex.reasoningEffort?['CODEX_MODEL_OR_EFFORT_MISSING']:[])];
}
const listening=(url:string)=>new Promise<boolean>(done=>{
  const target=new URL(url),socket=connect({host:target.hostname,port:Number(target.port || 80)});
  const end=(value:boolean)=>{socket.destroy();done(value);};
  socket.setTimeout(1500,()=>end(false));socket.once('connect',()=>end(true));socket.once('error',()=>end(false));
});
/** Read-only deployment report: identity, policy roles, ledger schema, Codex
 * configuration, CDP listener, bounded UIA survey and native inventory counts. */
async function preflight(parsed:{config?:string;db?:string;'carrier-thread'?:string}):Promise<void> {
  const config=loadConfig({configPath:parsed.config,dbPath:parsed.db}),authority=new CallerAuthority(),report:Record<string,unknown>={readOnly:true,node:process.version},blockers:string[]=[];
  const step=async(name:string,run:()=>unknown)=>{try{report[name]=await run();}catch(error){const failure=classifyError(error);report[name]={ok:false,code:failure.code,message:failure.message};blockers.push(`${name.toUpperCase()}_${failure.code}`);}};
  let identity:ReturnType<CallerAuthority['resolve']>=null;
  await step('identity',()=>{identity=authority.resolve(localCaller(authority,POLICY).context);return {policyPresent:existsSync(POLICY),instance:identity!.instance,controller:identity!.controller,reviewer:identity!.reviewer,executor:identity!.executor};});
  await step('policy',()=>{const summary=policySummary(POLICY,identity?.principal ?? '');if(!summary.reviewers)blockers.push('REVIEWER_MISSING');if(identity?.controller && !summary.delegatedExecutorInstance)blockers.push('EXECUTOR_DELEGATION_MISSING');return summary;});
  await step('database',()=>{const db=new DatabaseSync(config.database.path,{readOnly:true});try{const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if(version!==SCHEMA_VERSION){blockers.push('DATABASE_MIGRATION_REQUIRED');return {schemaVersion:version,required:SCHEMA_VERSION};}
    return {schemaVersion:version,unownedLegacyProjects:Number(db.prepare('SELECT COUNT(*) n FROM conversation_workspaces w WHERE NOT EXISTS(SELECT 1 FROM project_access a WHERE a.project_id=w.project_id)').get()!.n)};}finally{db.close();}});
  report.codex={executable:!!config.agents.codex.executable,model:config.agents.codex.model ?? null,reasoningEffort:config.agents.codex.reasoningEffort ?? null};
  await step('cdp',async()=>{const open=await listening(config.desktop.cdpUrl);if(!open)blockers.push('CDP_UNAVAILABLE');return {listening:open};});
  await step('uia',async()=>{const ui=new WindowsNativeUi(config);try{return await ui.call('uia-diagnose',{name:''},new AbortController().signal);}finally{ui.close();}});
  if(parsed['carrier-thread'])await step('native',async()=>{const tools=createWindowsNativeReadTools(config,parsed['carrier-thread']!),signal=new AbortController().signal;
    // Tool names only: shows whether the host advertises any formal creation tool.
    try{const catalogTools=(await new NativeDesktopReadClient({carrierThreadId:parsed['carrier-thread']!,...config.nativeInterface,signal}).catalog()).map(tool=>tool.name);
      const projects=await tools.listProjects(signal),threads=await tools.listThreads(signal);return {catalogTools,projects:projects.projects.length,threads:threads.threads.length+threads.pinnedThreads.length,recentThreadWindow:30};}finally{closeNativeReadWorker();}});
  else blockers.push('CARRIER_THREAD_MISSING');
  process.stdout.write(JSON.stringify({...report,blockers})+'\n');
}

/** The protected embedding supplies real approval/delegation callbacks. Nothing
 * in CLI/config/MCP JSON can load code or manufacture these capabilities. */
export async function runWindowsHost(args:string[],trusted?: (services:Parameters<NonNullable<Parameters<typeof runMcp>[1]>>[0] & {native?:WindowsNativeTools})=>Promise<BackgroundHostBindings> | BackgroundHostBindings):Promise<void> {
  const parsed=parseArgs({args,options:{config:{type:'string'},db:{type:'string'},'carrier-thread':{type:'string'},worker:{type:'boolean'},write:{type:'boolean'},preflight:{type:'boolean'},help:{type:'boolean'}},strict:true});
  if(parsed.values.help){process.stdout.write('Windows Bridge: [--write | --worker | --preflight] --config <file> --db <file> [--carrier-thread <existing Codex ID>]\nDefault: read-only MCP. --write: ledger tools for the caller policy role, no automatic queue. --worker: one independent runtime. --preflight: read-only deployment report.\nWithout an embedding the executor comes only from a policy delegation and approvals from an independent reviewer; GUI approval requires a trusted embedding.\n');return;}
  if(process.platform!=='win32')throw new BridgeError('UNSUPPORTED','Windows host requires the logged-in Windows user session');
  const mcpArgs:string[]=[];
  for(const key of ['config','db'] as const)if(parsed.values[key])mcpArgs.push('--'+key,parsed.values[key]!);
  const build:NonNullable<Parameters<typeof runMcp>[1]>=async services=>{
    const native=parsed.values['carrier-thread']?createWindowsNativeReadTools(services.config,parsed.values['carrier-thread']):undefined;
    const bindings=trusted?await trusted({...services,native}):policyBindings(services,native);
    // An executable path is not execution authority. Use only the executor
    // context issued by the real trusted delegation host, never a synthetic SID.
    if(!bindings.executor && native && bindings.executorContext && services.config.agents.codex.executable && services.config.agents.codex.model && services.config.agents.codex.reasoningEffort) {
      const inspect=async(target:DeliveryTarget,signal:AbortSignal)=>{
        const item=await findNativeThread(native,target.codexConversationId,signal);
        const project=(await native.listProjects(signal)).projects.find(p=>p.projectId===item?.projectId);
        if(!item || item.kind!=='codex' || !project || project.projectKind!=='local' || project.hostId!=='local' || !item.cwd || win32.normalize(item.cwd).toLowerCase()!==win32.normalize(target.workspacePath).toLowerCase() || win32.normalize(project.path).toLowerCase()!==win32.normalize(target.workspacePath).toLowerCase())throw new BridgeError('PROVENANCE','Native Codex thread/project/directory membership differs');
        return {source:'codex-app-state' as const,local:true,conversationId:item.id,appProjectId:project.projectId,workspacePath:project.path};
      };
      bindings.executor=createCodexAppServerExecutor({executable:services.config.agents.codex.executable,timeoutMs:services.config.background.timeoutMs,interruptTimeoutMs:10000,model:services.config.agents.codex.model,reasoningEffort:services.config.agents.codex.reasoningEffort,selfMcpServerName:'acb',inspect,approve:bindings.approveCodex,
        assertExclusive:async(target,signal)=>{const page=await native.readThread(target.codexConversationId,signal);if(!['idle','notLoaded'].includes(page.thread.status.type))throw new BridgeError('CONFLICT','Native Codex thread is already active');}});
    }
    return {...bindings,manageQueue:false};
  };
  if(parsed.values.preflight){await preflight(parsed.values);return;}
  if(!parsed.values.worker){await runMcp(mcpArgs,parsed.values.write?build:undefined);return;}
  const config=loadConfig({configPath:parsed.values.config,dbPath:parsed.values.db}),authority=new CallerAuthority();
  const caller=localCaller(authority,POLICY);
  if(!authority.resolve(caller.context)?.controller)throw new BridgeError('AUTH','Independent runtime requires a protected controller identity');
  const db=createDb({dbPath:config.database.path,busyTimeoutMs:config.database.busyTimeoutMs,authorizedSids:caller.authorizedSids});
  const bindings=await build({config,authority,context:caller.context,db});
  if(!bindings.executor || !bindings.executorContext){db.close();throw new BridgeError('UNSUPPORTED',`CODEX_EXECUTOR_HOST_MISSING: ${executorGaps(config,bindings,parsed.values['carrier-thread']).join(',') || 'trusted embedding returned no executor'}`);}
  const bridge=new BackgroundBridge(db,authority,caller.context,config,bindings,code=>process.stderr.write(`ACB ${code}\n`));
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await bridge.shutdown();closeNativeReadWorker();closeWindowsNativeUiWorkers();db.close();};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
  bridge.start();
}
if(import.meta.main)void runWindowsHost(process.argv.slice(2)).catch(error=>{const failure=classifyError(error);process.stderr.write(`${failure.code}: ${failure.message}\n`);process.exitCode=EXIT_CODES[failure.code];});
