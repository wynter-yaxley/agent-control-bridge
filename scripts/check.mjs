import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanText, scanHistory } from './check-rules.mjs';
const git=(...args)=>{const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});if(r.status!==0)throw Error('Git check failed');return r.stdout;};
const split=text=>text.split('\0').filter(Boolean);
const files=split(git('ls-files','--cached','--others','--exclude-standard','-z')).filter(file=>existsSync(file));
const violations=[];
// Published history is preserved. Technical acknowledgement is not approval.
const baseline=JSON.parse(readFileSync(new URL('./check-history-baseline.json',import.meta.url),'utf8'));
for(const file of files){const data=readFileSync(file);if(data.includes(0))throw Error('Unexpected binary source file');for(const kind of scanText(file,data.toString('utf8')))violations.push({path:file,kind,scope:'working-tree'});}
// Deduplication includes path and original-import scope, so new private paths
// and later reintroductions are scanned even if their bytes already occurred.
const history=scanHistory(git,baseline),{historyBlobs,acknowledgedHistory:acknowledged}=history;
violations.push(...history.violations);
if(violations.length){console.error(JSON.stringify({ok:false,violations}));process.exit(1);}
for(const file of ['data/check.db','data/check.db-wal','data/check.db-shm','local.sqlite3','local.sqlite3-wal','local.sqlite3-shm','.env','.env.local','.bridge.config.json','node_modules/x','dist/x','coverage/x','tools/desktop/__pycache__/x.pyc','tools/desktop/.venv/x','profiles/x','exports/x','x.log'])if(!git('check-ignore','--no-index',file).trim())throw Error('Ignore protection missing');
for(const file of ['config.example.json','.env.example','LICENSE','test/fixtures/legacy-schema.sql']){
 const r=spawnSync('git',['check-ignore','--no-index',file],{encoding:'utf8',windowsHide:true});if(r.status===0)throw Error('Required example/fixture ignored');
}
const example=JSON.parse(readFileSync('config.example.json','utf8'));if(example.watcher.intervalMs!==60000)throw Error('Incorrect watcher default');
for(const file of files.filter(f=>f.endsWith('.md'))){
 const text=readFileSync(file,'utf8');for(const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){
  let link=match[1].replace(/^<|>$/g,'');if(/^[a-z]+:|^#|^\//i.test(link))continue;link=link.split('#')[0];if(link&&!existsSync(resolve(dirname(file),decodeURIComponent(link))))throw Error('Broken local Markdown link: '+file+' -> '+link);
 }
}
const python=process.env.ACB_CHECK_PYTHON??'python';const xml=spawnSync(python,['scripts/check_svg.py'],{encoding:'utf8',windowsHide:true});if(xml.status!==0)throw Error('SVG XML validation failed; Python 3.10+ required on PATH or via ACB_CHECK_PYTHON');
console.log(JSON.stringify({ok:true,sourceFiles:files.length,historyBlobs,acknowledgedHistory:acknowledged,historyPolicyStatus:'PENDING_HERMES_POLICY_REVIEW',secretCandidates:0,markdownLinks:'PASS',svgXml:'PASS',ignore:'PASS',configurationExample:'PASS',limits:'Pattern scan does not prove absence of unknown credentials'}));
if(process.env.npm_execpath) {
 const result=spawnSync(process.execPath,[process.env.npm_execpath,'pack','--dry-run','--json','--ignore-scripts'],{encoding:'utf8',maxBuffer:4*1024*1024,windowsHide:true});
 if(result.status!==0)throw Error('Package manifest check failed');
 const paths=JSON.parse(result.stdout)[0].files.map(file=>file.path);
 if(paths.some(path=>/(?:^data\/|caller-policy\.json$|\.env|__pycache__|\.pyc$|\.bridge\.config)/.test(path)))throw Error('Private runtime file in package');
 console.log(JSON.stringify({packageManifest:'PASS',packageFiles:paths.length,privatePaths:0}));
}
