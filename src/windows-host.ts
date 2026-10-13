#!/usr/bin/env node
import type {DeliveryTarget} from './prompts.ts';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {CallerAuthority,localCaller} from './caller.ts';
import {loadConfig} from './config.ts';
import {createDb} from './db.ts';
import {BackgroundBridge,type BackgroundHostBindings} from './background.ts';
import {runMcp} from './mcp.ts';
import {createCodexAppServerExecutor} from './codex-app-server.ts';
import {createWindowsNativeReadTools,closeWindowsNativeUiWorkers,type WindowsNativeTools} from './windows-native-host.ts';
import {closeNativeReadWorker} from './native-readonly.ts';
import {BridgeError,classifyError,EXIT_CODES} from './errors.ts';

/** The protected embedding supplies real approval/delegation callbacks. Nothing
 * in CLI/config/MCP JSON can load code or manufacture these capabilities. */
export async function runWindowsHost(args:string[],trusted?: (services:Parameters<NonNullable<Parameters<typeof runMcp>[1]>>[0] & {native?:WindowsNativeTools})=>Promise<BackgroundHostBindings> | BackgroundHostBindings):Promise<void> {
  const parsed=parseArgs({args,options:{config:{type:'string'},db:{type:'string'},'carrier-thread':{type:'string'},worker:{type:'boolean'},write:{type:'boolean'},help:{type:'boolean'}},strict:true});
  if(parsed.values.help){process.stdout.write('Windows Bridge: [--write | --worker] --config <file> --db <file> [--carrier-thread <existing Codex ID>]\nDefault: read-only MCP. --write: ledger controller, no automatic queue. --worker: one independent runtime. GUI approval and executor delegation require a trusted embedding.\n');return;}
  if(process.platform!=='win32')throw new BridgeError('UNSUPPORTED','Windows host requires the logged-in Windows user session');
  const mcpArgs:string[]=[];
  for(const key of ['config','db'] as const)if(parsed.values[key])mcpArgs.push('--'+key,parsed.values[key]!);
  const build:NonNullable<Parameters<typeof runMcp>[1]>=async services=>{
    const native=parsed.values['carrier-thread']?createWindowsNativeReadTools(services.config,parsed.values['carrier-thread']):undefined;
    const bindings=trusted?await trusted({...services,native}):{};
    // An executable path is not execution authority. Use only the executor
    // context issued by the real trusted delegation host, never a synthetic SID.
    if(!bindings.executor && native && bindings.executorContext && services.config.agents.codex.executable && services.config.agents.codex.model && services.config.agents.codex.reasoningEffort) {
      const inspect=async(target:DeliveryTarget,signal:AbortSignal)=>{
        const item=(await native.listThreads(signal)).threads.find(t=>t.id===target.codexConversationId);
        const project=(await native.listProjects(signal)).projects.find(p=>p.projectId===item?.projectId);
        if(!item || item.kind!=='codex' || !project || project.projectKind!=='local' || project.hostId!=='local' || !item.cwd || win32.normalize(item.cwd).toLowerCase()!==win32.normalize(target.workspacePath).toLowerCase() || win32.normalize(project.path).toLowerCase()!==win32.normalize(target.workspacePath).toLowerCase())throw new BridgeError('PROVENANCE','Native Codex thread/project/directory membership differs');
        return {source:'codex-app-state' as const,local:true,conversationId:item.id,appProjectId:project.projectId,workspacePath:project.path};
      };
      bindings.executor=createCodexAppServerExecutor({executable:services.config.agents.codex.executable,timeoutMs:services.config.background.timeoutMs,interruptTimeoutMs:10000,model:services.config.agents.codex.model,reasoningEffort:services.config.agents.codex.reasoningEffort,selfMcpServerName:'acb',inspect,approve:bindings.approveCodex,
        assertExclusive:async(target,signal)=>{const page=await native.readThread(target.codexConversationId,signal);if(!['idle','notLoaded'].includes(page.thread.status.type))throw new BridgeError('CONFLICT','Native Codex thread is already active');}});
    }
    return {...bindings,manageQueue:false};
  };
  if(!parsed.values.worker){await runMcp(mcpArgs,parsed.values.write?build:undefined);return;}
  const config=loadConfig({configPath:parsed.values.config,dbPath:parsed.values.db}),authority=new CallerAuthority();
  const caller=localCaller(authority,fileURLToPath(new URL('../config/caller-policy.json',import.meta.url)));
  if(!authority.resolve(caller.context)?.controller)throw new BridgeError('AUTH','Independent runtime requires a protected controller identity');
  const db=createDb({dbPath:config.database.path,busyTimeoutMs:config.database.busyTimeoutMs,authorizedSids:caller.authorizedSids});
  const bindings=await build({config,authority,context:caller.context});
  if(!bindings.executor || !bindings.executorContext){db.close();throw new BridgeError('UNSUPPORTED','CODEX_EXECUTOR_HOST_MISSING: install a real delegation host before starting the worker');}
  const bridge=new BackgroundBridge(db,authority,caller.context,config,bindings,code=>process.stderr.write(`ACB ${code}\n`));
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await bridge.shutdown();closeNativeReadWorker();closeWindowsNativeUiWorkers();db.close();};
  process.once('SIGINT',()=>{void stop();});process.once('SIGTERM',()=>{void stop();});
  bridge.start();
}
if(import.meta.main)void runWindowsHost(process.argv.slice(2)).catch(error=>{const failure=classifyError(error);process.stderr.write(`${failure.code}: ${failure.message}\n`);process.exitCode=EXIT_CODES[failure.code];});
