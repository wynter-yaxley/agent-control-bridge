import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { controlledProcessEnv } from './silent-process.ts';
import { BridgeError } from './errors.ts';

export interface CodexReadiness {
  ok: boolean; code: 'OK'|'AUTH_UNAVAILABLE'|'TIMEOUT'|'DEPENDENCY'|'PROTOCOL';
  initialized: boolean; accountConfigured: boolean; authMode: 'chatgpt'|'apiKey'|'other'|'none';
  models: { model: string; reasoningEfforts: string[] }[];
  realModelInvoked: false; ordinaryChatVerified: false;
}

// Exactly three documented read-only requests. The official process owns its
// existing authentication; this probe never reads auth files or starts a turn.
export async function checkCodexReadiness(options: { executable: string; timeoutMs: number; spawnFn?: typeof nodeSpawn }): Promise<CodexReadiness> {
  if (!options.executable.trim() || !Number.isInteger(options.timeoutMs) || options.timeoutMs<1 || options.timeoutMs>120000) throw new BridgeError('CONFIG','Invalid Codex diagnostic configuration');
  const facts:CodexReadiness={ok:false,code:'PROTOCOL',initialized:false,accountConfigured:false,authMode:'none',models:[],realModelInvoked:false,ordinaryChatVerified:false};
  return new Promise(resolve=>{
    const child=(options.spawnFn??nodeSpawn)(options.executable,['app-server','--listen','stdio://'],{shell:false,windowsHide:true,env:controlledProcessEnv(),stdio:['pipe','pipe','pipe']});
    let finished=false,bytes=0,pending='',expected=1;
    const decoder=new StringDecoder('utf8');
    const finish=(code:CodexReadiness['code'])=>{if(finished)return;finished=true;clearTimeout(timer);facts.code=code;facts.ok=code==='OK';child.stdin?.end();child.kill();resolve(facts);};
    const timer=setTimeout(()=>finish('TIMEOUT'),options.timeoutMs);
    const send=(request:unknown)=>{child.stdin?.write(JSON.stringify(request)+'\n');};
    child.stdin?.on('error',()=>finish('PROTOCOL'));
    child.once('error',()=>finish('DEPENDENCY'));
    child.once('close',()=>finish('PROTOCOL'));
    child.stderr?.on('data',()=>{});
    child.stdout?.on('data',(data:Buffer)=>{
      if(finished)return;bytes+=data.byteLength;if(bytes>2097152){finish('PROTOCOL');return;}
      pending+=decoder.write(data);
      for(;;){
        const index=pending.indexOf('\n');if(index<0)break;
        const line=pending.slice(0,index);pending=pending.slice(index+1);
        let response:Record<string,unknown>;
        try{response=JSON.parse(line);}catch{finish('PROTOCOL');return;}
        if(!response||typeof response!=='object'||Array.isArray(response)){finish('PROTOCOL');return;}
        // Ignore notifications; reject server requests rather than granting
        // approvals, credential refresh, or attestation capabilities.
        if(response.method){if(response.id!==undefined){finish('PROTOCOL');return;}continue;}
        if(response.id!==expected || response.error || !response.result || typeof response.result!=='object'){finish('PROTOCOL');return;}
        const result=response.result as Record<string,unknown>;
        if(expected===1){
          facts.initialized=true;expected=2;send({method:'initialized',params:{}});send({id:2,method:'account/read',params:{refreshToken:false}});
        }else if(expected===2){
          const account=result.account as Record<string,unknown>|null;
          facts.accountConfigured=!!account&&typeof account==='object';
          facts.authMode=account?.type==='chatgpt'?'chatgpt':account?.type==='apiKey'?'apiKey':account?'other':'none';
          if(!facts.accountConfigured){finish('AUTH_UNAVAILABLE');return;}
          expected=3;send({id:3,method:'model/list',params:{limit:100}});
        }else{
          if(!Array.isArray(result.data)){finish('PROTOCOL');return;}
          facts.models=result.data.flatMap(value=>{
            if(!value||typeof value!=='object')return [];
            const row=value as Record<string,unknown>;
            if(typeof row.model!=='string'||!/^gpt-[a-z0-9.-]{1,100}$/i.test(row.model))return [];
            const efforts=Array.isArray(row.supportedReasoningEfforts)?row.supportedReasoningEfforts.flatMap(e=>{
              const value=e&&typeof e==='object'?(e as Record<string,unknown>).reasoningEffort:null;
              return typeof value==='string'&&['none','minimal','low','medium','high','xhigh','max','ultra'].includes(value)?[value]:[];
            }):[];
            return [{model:row.model,reasoningEfforts:efforts}];
          });
          finish('OK');return;
        }
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'agent_control_bridge_diagnostic',title:'Agent Control Bridge Diagnostic',version:'0.2.0'}}});
  });
}
