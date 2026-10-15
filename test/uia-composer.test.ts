import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The real FindComposer runs against a mock UIA tree; no desktop is touched.
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true }).status === 0;
const source = readFileSync(new URL('../src/windows-native-worker.ps1', import.meta.url), 'utf8');
// A long thread precedes the composer.
const fn = (name: string) => new RegExp(`\\n function ${name}\\([\\s\\S]*?\\n }\\n`).exec(source)![0];
const composer = ['ComposerUsable', 'FindComposer', 'ElementKey'].map(fn).join('');
function findComposer(tree: string, deadline = '[DateTime]::UtcNow.AddMinutes(1)'): { found: string | null; calls: number; error: string | null } {
  const script = `Add-Type -AssemblyName UIAutomationClient
$ErrorActionPreference='Stop'
$deadline=${deadline}
${composer}
$nodes=@{};$kids=@{};$parent=@{};$script:calls=0
function Node([string]$id,[string]$type,[string]$name,[string]$under) {
 $script:nodes[$id]=[pscustomobject]@{Id=$id;Current=[pscustomobject]@{ControlType=[pscustomobject]@{ProgrammaticName="ControlType.$type"};Name=$name;IsEnabled=$true;IsOffscreen=$false;IsKeyboardFocusable=$true;BoundingRectangle=@{IsEmpty=$false}}}
 Add-Member -InputObject $script:nodes[$id] -MemberType ScriptMethod -Name GetRuntimeId -Value {return ,@($this.Id)}
 Add-Member -InputObject $script:nodes[$id] -MemberType ScriptMethod -Name FindAll -Value {param($scope,$condition) @($script:nodes.Values | Where-Object {$_.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit'})}
 $script:kids[$id]=[System.Collections.Generic.List[string]]::new()
 if ($under) {$script:kids[$under].Add($id);$script:parent[$id]=$under}
}
$walker=[pscustomobject]@{}
Add-Member -InputObject $walker -MemberType ScriptMethod -Name GetLastChild -Value {param($e) $script:calls++;$c=$script:kids[$e.Id];if ($c.Count) {$script:nodes[$c[$c.Count-1]]} else {$null}}
Add-Member -InputObject $walker -MemberType ScriptMethod -Name GetPreviousSibling -Value {param($e) $script:calls++;$p=$script:parent[$e.Id];if (-not $p) {return $null};$s=$script:kids[$p];$i=$s.IndexOf($e.Id);if ($i -gt 0) {$script:nodes[$s[$i-1]]} else {$null}}
${tree}
try {$hit=FindComposer $nodes['doc'] $walker;@{found=$(if ($hit) {$hit.Id} else {$null});calls=$script:calls;error=$null} | ConvertTo-Json -Compress}
catch {@{found=$null;calls=$script:calls;error=$_.Exception.Message} | ConvertTo-Json -Compress}`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const thread = "Node 'doc' 'Document' '' ''; Node 'side' 'Group' '' 'doc'; for ($i=0;$i -lt 300;$i++) {Node \"s$i\" 'Button' '' 'side'}; Node 'main' 'Group' '' 'doc'; Node 'thread' 'Group' '' 'main'; for ($i=0;$i -lt 3000;$i++) {Node \"m$i\" 'Text' '[TEST] message' 'thread'}";

test('UIA composer lookup: found from the end of a long thread without walking it', { skip: !available }, () => {
  const result = findComposer(`${thread}; Node 'footer' 'Group' '' 'main'; Node 'form' 'Group' '' 'footer'; Node 'composer' 'Edit' '询问 ChatGPT' 'form'; Node 'send' 'Button' '发送' 'form'`);
  assert.equal(result.found, 'composer'); assert.ok(result.calls < 20, String(result.calls));
  // A blank new chat names its composer by its own placeholder.
  assert.equal(findComposer(`${thread}; Node 'footer' 'Group' '' 'main'; Node 'composer' 'Edit' '使用 ChatGPT Work' 'footer'`).found, 'composer');
});

test('UIA composer lookup: the blank page filters hidden edits and finds the mid-document composer', { skip: !available }, () => {
  const landing = "Node 'doc' 'Document' '' ''; Node 'side' 'Group' '' 'doc'; for ($i=0;$i -lt 500;$i++) {Node \"s$i\" 'Button' '' 'side'}; Node 'main' 'Group' '' 'doc'; Node 'composer' 'Edit' '使用 ChatGPT Work' 'main'; Node 'tail' 'Group' '' 'doc'; for ($i=0;$i -lt 500;$i++) {Node \"t$i\" 'Text' '' 'tail'}";
  // The reverse walk alone stops in the trailing nodes; the landing flag searches forward.
  assert.equal(findComposer(landing).found, null);
  const forward = "$script:landing=$true; Node 'hidden' 'Edit' '询问 ChatGPT' 'tail';$nodes['hidden'].Current.IsOffscreen=$true";
  assert.equal(findComposer(`${landing}; ${forward}`).found, 'composer');
});

test('UIA composer lookup: hidden and disabled duplicates cannot replace the visible composer', { skip: !available }, () => {
  const base = "Node 'doc' 'Document' '' '';Node 'live' 'Edit' '询问 ChatGPT' 'doc';Node 'hidden' 'Edit' '询问 ChatGPT' 'doc';$nodes['hidden'].Current.IsOffscreen=$true;Node 'disabled' 'Edit' '询问 ChatGPT' 'doc';$nodes['disabled'].Current.IsEnabled=$false";
  assert.equal(findComposer(base).found, 'live');
  assert.equal(findComposer(`${base};$nodes['hidden'].Current.IsOffscreen=$false`).error, 'STATE');
});

test('UIA composer lookup: a missing composer or an expired deadline stops within its bound', { skip: !available }, () => {
  const missing = findComposer(thread);
  assert.equal(missing.found, null); assert.equal(missing.error, null); assert.ok(missing.calls <= 1 + 2 * 400, String(missing.calls));
  assert.equal(findComposer(thread, '[DateTime]::UtcNow.AddMinutes(-1)').error, 'TIMEOUT');
});

const helpers = ['Normalize', 'ComposerText', 'Within'].map(name => new RegExp(`\\n function ${name}\\([\\s\\S]*?\\n(?= function )`).exec(source)![0]).join('');
test('UIA composer text: the placeholder reads as empty; a write that never reads back stops within its bound', { skip: !available }, () => {
  const script = `Add-Type -AssemblyName UIAutomationClient
$ErrorActionPreference='Stop'
${helpers}
function Value($e) {$e.V}
$request=[pscustomobject]@{timeoutMs=300000;pollMs=100}
$edit=[pscustomobject]@{Current=@{Name='询问 ChatGPT'};V=''}
Add-Member -InputObject $edit -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {param($p,$v) $false}
$cases=@(\"询问 ChatGPT\`n\",'询问 ChatGPT',\"询问 ChatGPT\`n[TEST] prompt\",\"[TEST] prompt\`r\`n\",'') | ForEach-Object {$edit.V=$_;ComposerText $edit}
$clock=[Diagnostics.Stopwatch]::StartNew();$miss=Within 1500 {$null}
@{texts=$cases;miss=$miss;ms=$clock.ElapsedMilliseconds} | ConvertTo-Json -Compress`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.texts, ['', '', '[TEST] prompt', '[TEST] prompt', '']);
  assert.equal(parsed.miss, null); assert.ok(parsed.ms >= 1400 && parsed.ms < 5000, String(parsed.ms));
});
