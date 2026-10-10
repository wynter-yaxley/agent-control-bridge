import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { redact } from '../src/security.ts';
// Canonical paths avoid Windows short-name aliases changing module entry identity.
const temporaryRoot=realpathSync.native(tmpdir());
const directory=mkdtempSync(join(temporaryRoot,'acb-clean-install-'));
let checks=[];
function run(executable,args,env,timeout=180000){
 return new Promise(resolveResult=>{
  const child=spawn(executable,args,{cwd:directory,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',value=>{stdout=(stdout+value.toString()).slice(-65536);});
  child.stderr.on('data',value=>{stderr=(stderr+value.toString()).slice(-65536);});
  const timer=setTimeout(()=>{
   timedOut=true;
   // Only this newly spawned install/test subtree; never an existing Agent.
   if(process.platform==='win32'&&child.exitCode===null&&child.pid)spawnSync('C:\\Windows\\System32\\taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});
   else if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}
   if(child.exitCode===null)child.kill('SIGKILL');
  },timeout);
  child.once('error',()=>{clearTimeout(timer);resolveResult({status:null,stdout,stderr:'Dependency could not start',timedOut:false});});
  child.once('close',status=>{clearTimeout(timer);resolveResult({status,stdout,stderr,timedOut});});
 });
}
function diagnostic(result){
 const lines=result.stdout.split('\n');const first=lines.findIndex(line=>/^not ok/.test(line));
 const selected=first>=0?lines.slice(Math.max(0,first-1),first+35).join('\n'):lines.slice(-18).join('\n');
 return redact((result.stderr.slice(-3000)+'\n'+selected).slice(-7000));
}
try {
 for(const file of ['src','test','scripts','tools','assets','config.example.json','package.json','package-lock.json','tsconfig.json','tsconfig.test.json'])cpSync(file,join(directory,file),{recursive:true,filter:path=>!/(?:^|[\\/])(?:__pycache__|\.venv)(?:[\\/]|$)|\.pyc$/.test(path)});
 mkdirSync(join(directory,'config'));
 writeFileSync(join(directory,'empty-user.npmrc'),'');writeFileSync(join(directory,'empty-global.npmrc'),'');
 const npm=process.env.npm_execpath;if(!npm)throw Error('Run through npm run test:install');
 const env={};
 for(const key of ['PATH','Path','SystemRoot','WINDIR','ComSpec','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','CI','NO_COLOR'])if(process.env[key]!==undefined)env[key]=process.env[key];
 Object.assign(env,{TEMP:temporaryRoot,TMP:temporaryRoot,npm_config_userconfig:join(directory,'empty-user.npmrc'),npm_config_globalconfig:join(directory,'empty-global.npmrc'),npm_config_registry:'https://registry.npmjs.org/'});
 for(const args of [['ci','--ignore-scripts','--no-audit','--fund=false'],['run','typecheck'],['run','build'],['test'],['run','test:e2e']]){
  const result=await run(process.execPath,[npm,...args],env);
  if(result.status!==0||result.timedOut){checks.push({step:args.join(' '),result:result.timedOut?'TIMEOUT':'FAIL',diagnostic:diagnostic(result)});throw Error('Clean install step failed: '+args.join(' '));}
  const count=/# tests (\d+)|ℹ tests (\d+)/.exec(result.stdout??'');
  const totals={};if(count){totals.tests=Number(count[1]??count[2]);for(const field of ['pass','fail','skipped']){const match=new RegExp('(?:#|ℹ) '+field+' (\\d+)').exec(result.stdout);if(match)totals[field]=Number(match[1]);}}
  checks.push({step:args.join(' '),result:'PASS',...totals});
 }
 const config=await run(process.execPath,['dist/cli.js','config-show','--config','config.example.json'],env,30000);
 if(config.status!==0||JSON.parse(config.stdout).watcher.intervalMs!==60000)throw Error('Example configuration failed');
 const demo=await run(process.execPath,['dist/cli.js','demo'],env,30000);
 if(demo.status!==0)throw Error('Compiled demo failed');const result=JSON.parse(demo.stdout);if(result.realModelInvoked!==false||result.deliveryState!=='DELIVERED_PENDING_ACCEPTANCE')throw Error('Demo honesty contract failed');
 checks.push({step:'compiled config + isolated Mock workflow',result:'PASS'});console.log(JSON.stringify({ok:true,mode:'CLEAN_INSTALL',checks,realAgentInvoked:false}));
}catch(error){console.error(JSON.stringify({ok:false,error:redact(error.message),checks}));process.exitCode=1;}
finally{
 if(dirname(resolve(directory))!==resolve(temporaryRoot)||!basename(directory).startsWith('acb-clean-install-'))throw Error('Unsafe cleanup path');
 try{rmSync(directory,{recursive:true,force:true,maxRetries:6,retryDelay:500});}
 catch{console.error(JSON.stringify({ok:false,code:'IO',error:'Own temporary install directory could not be cleaned'}));process.exitCode=1;}
}
