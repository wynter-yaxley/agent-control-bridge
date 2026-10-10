import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'acb-clean-install-'));
let checks=[];
try {
 for(const file of ['src','test','scripts','tools','assets','config.example.json','package.json','package-lock.json','tsconfig.json','tsconfig.test.json'])cpSync(file,join(directory,file),{recursive:true,filter:path=>!/(?:^|[\\/])(?:__pycache__|\.venv)(?:[\\/]|$)|\.pyc$/.test(path)});
 mkdirSync(join(directory,'config')); // No local caller policy, credentials, DB, home-state or git history.
 writeFileSync(join(directory,'empty-user.npmrc'),'');writeFileSync(join(directory,'empty-global.npmrc'),'');
 const npm=process.env.npm_execpath;if(!npm)throw Error('Run through npm run test:install');
 const env={};
 for(const key of ['PATH','Path','SystemRoot','WINDIR','ComSpec','TEMP','TMP','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','CI','NO_COLOR'])if(process.env[key]!==undefined)env[key]=process.env[key];
 Object.assign(env,{npm_config_userconfig:join(directory,'empty-user.npmrc'),npm_config_globalconfig:join(directory,'empty-global.npmrc'),npm_config_registry:'https://registry.npmjs.org/'});
 delete env.ACB_CONFIG;delete env.ACB_DB_PATH;delete env.ACB_CDP_URL;delete env.ACB_WATCH_INTERVAL_MS;delete env.ACB_BLOCKED_REPORT_MS;delete env.ACB_CHATGPT_MODEL;delete env.ACB_CHATGPT_REASONING;delete env.ACB_CODEX_HOME;
 for(const args of [['ci','--ignore-scripts','--no-audit','--fund=false'],['run','typecheck'],['run','build'],['test'],['run','test:e2e']]){
  const result=spawnSync(process.execPath,[npm,...args],{cwd:directory,env,encoding:'utf8',maxBuffer:16*1024*1024,timeout:180000,windowsHide:true});
  if(result.status!==0)throw Error('Clean install step failed: '+args.join(' '));
  const count=/# tests (\d+)|ℹ tests (\d+)/.exec(result.stdout??'');checks.push({step:args.join(' '),result:'PASS',...(count?{tests:Number(count[1]??count[2])}:{})});
 }
 const config=spawnSync(process.execPath,['dist/cli.js','config-show','--config','config.example.json'],{cwd:directory,env,encoding:'utf8',windowsHide:true});
 if(config.status!==0||JSON.parse(config.stdout).watcher.intervalMs!==60000)throw Error('Example configuration failed');
 const demo=spawnSync(process.execPath,['dist/cli.js','demo'],{cwd:directory,env,encoding:'utf8',timeout:30000,windowsHide:true});
 if(demo.status!==0)throw Error('Compiled demo failed');const result=JSON.parse(demo.stdout);if(result.realModelInvoked!==false||result.deliveryState!=='DELIVERED_PENDING_ACCEPTANCE')throw Error('Demo honesty contract failed');
 checks.push({step:'compiled config + isolated Mock workflow',result:'PASS'});console.log(JSON.stringify({ok:true,mode:'CLEAN_INSTALL',checks,realAgentInvoked:false}));
}catch(error){console.error(JSON.stringify({ok:false,error:error.message,checks}));process.exitCode=1;}
finally{if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('acb-clean-install-'))throw Error('Unsafe cleanup path');rmSync(directory,{recursive:true,force:true});}
