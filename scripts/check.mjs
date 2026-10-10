import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
const git=(...args)=>{const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});if(r.status!==0)throw Error('Git check failed');return r.stdout;};
const split=text=>text.split('\0').filter(Boolean);
const files=split(git('ls-files','--cached','--others','--exclude-standard','-z'));
const patterns={
 privateKey:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
 githubToken:/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
 providerKey:/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
 jwt:/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
 localIdentifier:/\b(?:LAPTOP|DESKTOP)-[A-Z0-9]+\b/i,
};
const username=homedir().split(/[\\/]/).at(-1);
const violations=[];
function scan(path,text,scope){
 for(const [kind,pattern]of Object.entries(patterns))if(pattern.test(text))violations.push({path,kind,scope});
 const userPath=username?.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 if(userPath && new RegExp(`(?:[\\\\/]Users[\\\\/]|[\\\\/]home[\\\\/])${userPath}(?:[\\\\/]|["'])`,'i').test(text))violations.push({path,kind:'localUserPath',scope});
 if(/^(data|node_modules|dist|coverage|exports?|tmp|temp|profiles|browser-profile)\//.test(path)||/\.(db|sqlite3?)(-wal|-shm)?$|\.log$|(?:^|\/)\.env(?:$|\.(?!example$))|(?:^|\/)caller-policy\.json$|(?:^|\/)\.bridge\.config\.json$/.test(path))violations.push({path,kind:'privatePath',scope});
}
for(const file of files){if(!existsSync(file))continue;const data=readFileSync(file);if(data.includes(0))throw Error('Unexpected binary source file');scan(file,data.toString('utf8'),'working-tree');}
let historyBlobs=0;const seen=new Set();
for(const commit of git('rev-list','--all').trim().split('\n').filter(Boolean)){
 for(const row of split(git('ls-tree','-r','-z',commit))){const match=/^\d+ blob ([a-f0-9]+)\t(.*)$/s.exec(row);if(!match||seen.has(match[1]))continue;seen.add(match[1]);historyBlobs++;scan(match[2],git('show',match[1]),'history');}
}
if(violations.length){console.error(JSON.stringify({ok:false,violations}));process.exit(1);}
for(const file of ['data/check.db','data/check.db-wal','data/check.db-shm','local.sqlite3','local.sqlite3-wal','local.sqlite3-shm','.env','.env.local','.bridge.config.json','node_modules/x','dist/x','coverage/x','tools/desktop/__pycache__/x.pyc','tools/desktop/.venv/x','profiles/x','exports/x','x.log'])if(!git('check-ignore','--no-index',file).trim())throw Error('Ignore protection missing');
for(const file of ['config.example.json','.env.example','LICENSE','test/fixtures/legacy-schema.sql']){
 const r=spawnSync('git',['check-ignore','--no-index',file],{encoding:'utf8',windowsHide:true});if(r.status===0)throw Error('Required example/fixture ignored');
}
const example=JSON.parse(readFileSync('config.example.json','utf8'));if(example.watcher.intervalMs!==60000)throw Error('Incorrect watcher default');
const commands=['project-register','help','init','migrate','schema-version','config-show','demo','watch','task-create','task-claim','task-progress','task-finish','task-renew','task-verify','task-cancel','task-resume','task-requeue','task-recover','task-list','task-show','approval-request','approval-decide','mapping-register','mapping-show','projects','status','audit','sweep','codex-status','codex-sync','codex-limits','pi-status','hermes-status','chatgpt-status','chatgpt-import','markdown-import','codex-fork-request'];
for(const command of commands){const r=spawnSync(process.execPath,['src/cli.ts',command,'--help'],{encoding:'utf8',windowsHide:true});if(r.status!==0||!r.stdout.trim()||r.stderr)throw Error('CLI help contract failed: '+command);}
for(const file of files.filter(f=>f.endsWith('.md'))){
 const text=readFileSync(file,'utf8');for(const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){
  let link=match[1].replace(/^<|>$/g,'');if(/^[a-z]+:|^#|^\//i.test(link))continue;link=link.split('#')[0];if(link&&!existsSync(resolve(dirname(file),decodeURIComponent(link))))throw Error('Broken local Markdown link: '+file+' -> '+link);
 }
}
const python=process.env.ACB_CHECK_PYTHON??'python';const xml=spawnSync(python,['scripts/check_svg.py'],{encoding:'utf8',windowsHide:true});if(xml.status!==0)throw Error('SVG XML validation failed; Python 3.11+ required');
console.log(JSON.stringify({ok:true,sourceFiles:files.length,historyBlobs,secretCandidates:0,cliHelpCommands:commands.length,markdownLinks:'PASS',svgXml:'PASS',ignore:'PASS',configurationExample:'PASS',limits:'Pattern scan does not prove absence of unknown credentials'}));
if(process.env.npm_execpath) {
 const result=spawnSync(process.execPath,[process.env.npm_execpath,'pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
 if(result.status!==0)throw Error('Package manifest check failed');
 const paths=JSON.parse(result.stdout)[0].files.map(file=>file.path);
 if(paths.some(path=>/(?:^data\/|caller-policy\.json$|\.env|__pycache__|\.pyc$|\.bridge\.config)/.test(path)))throw Error('Private runtime file in package');
 console.log(JSON.stringify({packageManifest:'PASS',packageFiles:paths.length,privatePaths:0}));
}
