import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';
import type { BridgeConfig } from './config.ts';
import { BridgeError, ERROR_CODES, controlledProcessEnv, type ErrorCode } from './errors.ts';

export interface WindowsUiSnapshot { title: string; text: string; ordinaryComposer: boolean; pid: number; conversationId: string | null }
export interface UiResult { ok: boolean; code?: string; stage?: string; errorType?: string; line?: number; snapshot?: WindowsUiSnapshot; body?: string; conversationId?: string | null; completionVerified?: boolean; identity?: 'uuid' | 'titleOnly' }
const UI_REPORT_GRACE_MS = 5000;

/** Fixed UIA operations on the existing ChatGPT window (windows-native-worker.ps1). */
const uiWorkers = new Set<WindowsNativeUi>();
export const closeUiWorkers = () => { for (const worker of uiWorkers) worker.close(); };
export class WindowsNativeUi {
  private readonly config: BridgeConfig;
  private child?: ReturnType<typeof spawn>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStage = '';
  constructor(config: BridgeConfig) { this.config = config; }
  close(): void { this.child?.kill(); this.child=undefined; uiWorkers.delete(this); }
  call(operation: 'snapshot' | 'chat-send' | 'chat-read-reply', fields: { name: string; conversationId?: string; prompt?: string }, signal: AbortSignal): Promise<UiResult> {
    const pending=this.queue.then(()=>this.request(operation,fields,signal));
    // A failed operation is returned to its caller; subsequent requests are not replayed.
    this.queue=pending.then(()=>undefined,()=>undefined);
    return pending;
  }
  private async request(operation: string, fields: Record<string,unknown>, signal: AbortSignal): Promise<UiResult> {
    if (process.platform !== 'win32') throw new BridgeError('UNSUPPORTED', 'Native UI controls require Windows');
    if (signal.aborted) throw new BridgeError('TIMEOUT','Native UI request cancelled before dispatch');
    if (!this.child) {
      const helper=fileURLToPath(new URL('./windows-native-worker.ps1',import.meta.url));
      const script="& ([scriptblock]::Create([System.IO.File]::ReadAllText('"+helper.replaceAll("'","''")+"')))";
      const executable=win32.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      this.child=spawn(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,env:controlledProcessEnv(),stdio:['pipe','pipe','pipe']});
      this.child.stdout!.setEncoding('utf8');
      const started=this.child;
      started.once('close',()=>{if(this.child===started){this.child=undefined;uiWorkers.delete(this);}});
      // Forward only the worker's own stage/diagnostic lines; remember the last stage.
      started.stderr!.setEncoding('utf8');
      let partial='';
      started.stderr!.on('data',(chunk:string)=>{
        const lines=(partial+chunk).split(/\r?\n/);partial=lines.pop()!.slice(-65536);
        for(const line of lines){if(!line.startsWith('ACB_UI_'))continue;if(line.startsWith('ACB_UI_STAGE='))this.lastStage=line.slice(13,160);process.stderr.write(line+'\n');}
      });
      uiWorkers.add(this);
    }
    const child=this.child;
    this.lastStage='';
    return new Promise((resolve,reject)=>{
      let output='';
      const finish=(error?: BridgeError,result?: UiResult)=>{
        clearTimeout(timer);signal.removeEventListener('abort',abort);
        child.stdout!.removeListener('data',read);child.removeListener('error',failed);child.removeListener('close',closed);child.stdin!.removeListener('error',inputFailed);
        if(error){this.close();reject(error);}else resolve(result!);
      };
      const abort=()=>finish(new BridgeError('TIMEOUT',`Native UI operation interrupted${this.lastStage?` at ${this.lastStage}`:''}; reconcile without resending`));
      const failed=()=>finish(new BridgeError('DEPENDENCY','Windows UI worker could not start'));
      const closed=()=>finish(new BridgeError('IO','Windows UI worker exited; reconcile without resending'));
      const inputFailed=()=>finish(new BridgeError('IO','Windows UI worker input failed'));
      const read=(chunk: Buffer)=>{
        output+=String(chunk);
        if(output.length>1048576){finish(new BridgeError('PROVENANCE','Native UI response exceeds its bound'));return;}
        if(!output.includes('\n'))return;
        try {
          const result=JSON.parse(output) as UiResult;
          if(!result.ok)throw new BridgeError(ERROR_CODES.includes(result.code ?? '')?result.code as ErrorCode:'EXECUTION',`Native UI operation failed at ${result.stage} (${result.errorType}, line ${result.line})`);
          finish(undefined,result);
        }catch(error){finish(error instanceof BridgeError?error:new BridgeError('IO','Windows UI worker returned an unreadable result'));}
      };
      // The worker reports its own stage within a smaller budget; this outer
      // bound only covers a worker that stops answering.
      const timer=setTimeout(abort,this.config.timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      child.stdout!.on('data',read);child.once('error',failed);child.once('close',closed);child.stdin!.on('error',inputFailed);
      // A smaller worker budget lets it report its own stage before outer deadlines fire.
      child.stdin!.write(JSON.stringify({operation,...fields,timeoutMs:Math.max(1000,this.config.timeoutMs-UI_REPORT_GRACE_MS),pollMs:this.config.uiPollMs})+'\n');
    });
  }
}

