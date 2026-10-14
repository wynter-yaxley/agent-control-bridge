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
