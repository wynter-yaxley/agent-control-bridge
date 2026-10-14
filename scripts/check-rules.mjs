// Content rules shared by scripts/check.mjs and its regression test. They must
// not depend on the account running the check, so one commit yields one result.
export const patterns={
 privateKey:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
 githubToken:/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
 providerKey:/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
 jwt:/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
 localIdentifier:/\b(?:LAPTOP|DESKTOP)-[A-Z0-9]+\b/,
};
// Any concrete account directory under /home or \Users is a local user path.
// Bracketed/variable placeholders cannot match; generic documentation names are listed.
const userPath=/[\\/](?:Users|home)[\\/]([^\\/\s"'<>|:*?[\]{}$%`]+)(?=[\\/"'])/gi;
const placeholders=new Set(['user','username','name','example','you','me','public','default','runner','runneradmin']);
export function scanText(path,text){
 const kinds=Object.entries(patterns).filter(([,pattern])=>pattern.test(text)).map(([kind])=>kind);
 if([...text.matchAll(userPath)].some(match=>!placeholders.has(match[1].toLowerCase())))kinds.push('localUserPath');
 if(/^(data|node_modules|dist|coverage|exports?|tmp|temp|profiles|browser-profile)\//.test(path)||/\.(db|sqlite3?)(-wal|-shm)?$|\.log$|(?:^|\/)\.env(?:$|\.(?!example$))|(?:^|\/)caller-policy\.json$|(?:^|\/)\.bridge\.config\.json$/.test(path))kinds.push('privatePath');
 return kinds;
}

// This pins the already published import, not a policy approval. Changes to
// these rules still require independent review; a mutable JSON list cannot
// enroll arbitrary findings or exempt later reuse of an original blob.
const initialImport='75db1e443c1853f99d642ee0e0f56f6ce5fdce61';
const historicalPaths=['src/hermes.ts','src/pi.ts'];
const split=text=>text.split('\0').filter(Boolean);
export function scanHistory(git,baseline){
 const originals=new Map(historicalPaths.map(path=>[path,git('rev-parse',`${initialImport}:${path}`).trim()]));
 if(!Array.isArray(baseline)||baseline.length!==historicalPaths.length||new Set(baseline.map(entry=>entry?.path)).size!==historicalPaths.length||
    baseline.some(entry=>!entry||entry.kind!=='localUserPath'||!originals.has(entry.path)||entry.blob!==originals.get(entry.path)))throw Error('Historical baseline differs from the two pinned initial-import findings');
 const headBlobs=new Set(split(git('ls-tree','-r','-z','HEAD')).map(row=>/^\d+ blob ([a-f0-9]+)\t/.exec(row)?.[1]));
 const violations=[],acknowledgedHistory=[],seen=new Set(),blobs=new Map();
 for(const commit of git('rev-list','HEAD').trim().split('\n').filter(Boolean)){
  for(const row of split(git('ls-tree','-r','-z',commit))){
   const match=/^\d+ blob ([a-f0-9]+)\t(.*)$/s.exec(row);if(!match)continue;
   const [,blob,path]=match,key=JSON.stringify([blob,path,commit===initialImport]);
   if(seen.has(key))continue;seen.add(key);
   if(!blobs.has(blob))blobs.set(blob,git('show',blob));
   for(const kind of scanText(path,blobs.get(blob))){
    const known=commit===initialImport&&!headBlobs.has(blob)&&baseline.some(entry=>entry.blob===blob&&entry.path===path&&entry.kind===kind);
    (known?acknowledgedHistory:violations).push({path,kind,scope:'history',blob,commit});
   }
  }
 }
 return {violations,acknowledgedHistory,historyBlobs:blobs.size};
}
