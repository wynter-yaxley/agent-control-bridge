import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Window choice, the GPT new-chat check and the project selection run as the real worker
// functions against mocks; no desktop is touched.
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true }).status === 0;
const raw = readFileSync(new URL('../src/windows-native-worker.ps1', import.meta.url));
const source = raw.toString('utf8');
const fn = (name: string) => new RegExp(`\\n function ${name}[ (][\\s\\S]*?\\n }\\n`).exec(source)![0];
function pwsh(script: string): any {
  // Windows PowerShell 5.1 writes stdout in the OEM code page unless told otherwise; the
  // worker itself sets UTF-8 the same way, so Chinese results read back unchanged.
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const attempt = (expression: string) => `$(try {${expression}} catch {'ERR:'+$_.Exception.Message})`;

test('PS 5.1: worker scripts carry a UTF-8 BOM, so their Chinese control names are read as written', () => {
  for (const name of ['windows-native-worker.ps1', 'native-pipe-worker.ps1']) {
    const bytes = readFileSync(new URL(`../src/${name}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], name);
  }
  // The control names are not ASCII, so without the BOM PS 5.1 would decode them as ANSI.
  assert.ok(source.includes("Buttons '新聊天'") && /[^\x00-\x7f]/.test(source));
});

test('window: with a ChatGPT and a Codex window (both with 「新聊天」) only the known ChatGPT window is used', { skip: !available }, () => {
  const result = pwsh(`${fn('PickGptWindow')}
function WindowKind($w) {$w.Kind}
function W([string]$id,$kind) {[pscustomobject]@{Id=$id;Kind=$kind;Buttons=@('新聊天')}}
@{
 both=${attempt("(PickGptWindow @((W 'codex' 'Codex'),(W 'gpt' 'ChatGPT')) -strict).Id")}
 codexOnly=${attempt("(PickGptWindow @(W 'codex' 'Codex')).Id")}
 codexAndUnknown=${attempt("(PickGptWindow @((W 'codex' 'Codex'),(W 'x' $null))).Id")}
 twoGpt=${attempt("(PickGptWindow @((W 'a' 'ChatGPT'),(W 'b' 'ChatGPT'))).Id")}
 soleUnknown=${attempt("(PickGptWindow @(W 'x' $null)).Id")}
 soleUnknownStrict=${attempt("(PickGptWindow @(W 'x' $null) -strict).Id")}
} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { both: 'gpt', codexOnly: 'ERR:OWNER', codexAndUnknown: 'ERR:OWNER', twoGpt: 'ERR:OWNER', soleUnknown: 'ERR:OWNER', soleUnknownStrict: 'ERR:OWNER' });
});

test('window: the identity marker is typed and sent only on a blank GPT new-chat page', { skip: !available }, () => {
  const result = pwsh(`${fn('GptLanding')}
$script:root=$null;$script:gptProven=$true
function WindowMode($w) {$script:mode}
function Document {[pscustomobject]@{}}
function FindComposer($d) {if ($script:composer) {'edit'} else {$null}}
function Find($s,$t,$n) {if ($script:messages -contains $n) {'node'} else {$null}}
function Case($mode,$composer,$messages,[switch]$strict) {$script:mode=$mode;$script:composer=$composer;$script:messages=$messages;[bool](GptLanding -strict:$strict)}
@{
 gpt=(Case 'ChatGPT' $true @() -strict)
 codex=(Case 'Codex' $true @())
 noSwitchStrict=(Case $null $true @() -strict)
 noSwitchBeforeSend=(Case $null $true @())
 hasMessage=(Case 'ChatGPT' $true @('您说：') -strict)
 hasReply=(Case 'ChatGPT' $true @('ChatGPT 说：'))
 noComposer=(Case 'ChatGPT' $false @() -strict)
} | ConvertTo-Json -Compress`);
  // The mode switch may disappear after sidebar navigation; the window was
  // already proven to be ChatGPT before navigation, so this is still a blank page.
  assert.deepEqual(result, { gpt: true, codex: false, noSwitchStrict: true, noSwitchBeforeSend: true, hasMessage: false, hasReply: false, noComposer: false });
});

test('project: only the menu item that appeared is chosen, and success needs the button to read the project back', { skip: !available }, () => {
  const result = pwsh(`${fn('Within')}${fn('ChooseProject')}
$request=[pscustomobject]@{timeoutMs=300;pollMs=50}
function Prefixed($scope,[string]$prefix) {@($script:button)}
function ProjectItems([string]$name) {@($script:items | Where-Object {$_.Name -eq $name -and ($_.Sidebar -or $script:open)})}
function ElementKey($e) {$e.Key}
function Expand($b) {$script:expanded++;$script:open=$true}
function Choose($i) {$script:chosen+=$i.Key;if ($script:selects) {$script:button.Current.Name="更改项目：$($i.Name)"}}
function Item([string]$key,[string]$name,[switch]$sidebar) {[pscustomobject]@{Key=$key;Name=$name;Sidebar=[bool]$sidebar}}
function Case([string]$current,$items,[bool]$selects) {
 $script:button=[pscustomobject]@{Current=[pscustomobject]@{Name="更改项目：$current"}};$script:items=$items;$script:selects=$selects;$script:open=$false;$script:expanded=0;$script:chosen=@()
 $outcome=${attempt("ChooseProject 'ACB项目';'ok'")}
 @{outcome=$outcome;chosen=($script:chosen -join ',');expanded=$script:expanded;label=$script:button.Current.Name}
}
@{
 picked=(Case '无' @((Item 'side' 'ACB项目' -sidebar),(Item 'menu' 'ACB项目'),(Item 'other' '别的')) $true)
 notReadBack=(Case '无' @((Item 'menu' 'ACB项目')) $false)
 onlySidebar=(Case '无' @((Item 'side' 'ACB项目' -sidebar)) $true)
 twoInMenu=(Case '无' @((Item 'm1' 'ACB项目'),(Item 'm2' 'ACB项目')) $true)
 already=(Case 'ACB项目' @() $true)
} | ConvertTo-Json -Compress -Depth 4`);
  assert.deepEqual(result.picked, { outcome: 'ok', chosen: 'menu', expanded: 1, label: '更改项目：ACB项目' });
  assert.equal(result.notReadBack.outcome, 'ERR:PROVENANCE'); assert.equal(result.notReadBack.chosen, 'menu');
  assert.deepEqual([result.onlySidebar.outcome, result.onlySidebar.chosen], ['ERR:PROVENANCE', '']);
  assert.deepEqual([result.twoInMenu.outcome, result.twoInMenu.chosen], ['ERR:PROVENANCE', '']);
  assert.deepEqual([result.already.outcome, result.already.expanded], ['ok', 0]);
});

test('foreground: authorization gates restore/activation; denial and a later user switch never retry activation', { skip: !available }, () => {
  const result = pwsh(`Add-Type -TypeDefinition @'
using System;
public static class AcbInput {
 public static IntPtr Foreground=new IntPtr(2); public static bool Allow=false; public static int Attempts=0, Restores=0;
 public static IntPtr GetForegroundWindow(){return Foreground;}
 public static bool SetForegroundWindow(IntPtr w){Attempts++;if(Allow)Foreground=w;return Allow;}
 public static bool IsIconic(IntPtr w){return true;}
 public static bool ShowWindowAsync(IntPtr w,int c){Restores++;return true;}
}
'@
${fn('Within')}${fn('AssertForeground')}${fn('EnsureForeground')}
$request=[pscustomobject]@{timeoutMs=20;pollMs=1;foregroundInput=$false}
$script:handle=[IntPtr]1;$script:gptProven=$true;$script:focusLost=$false;$script:foregroundChecked=$false
$unauthorized=${attempt("EnsureForeground;'ok'")};$before=[AcbInput]::Attempts
$request.foregroundInput=$true
$denied=${attempt("EnsureForeground;'ok'")};$deniedCount=[AcbInput]::Attempts
[AcbInput]::Allow=$true
$activated=${attempt("EnsureForeground;'ok'")}
$again=${attempt("EnsureForeground;'ok'")};$successCount=[AcbInput]::Attempts
[AcbInput]::Foreground=[IntPtr]2
$switched=${attempt("EnsureForeground;'ok'")}
@{unauthorized=$unauthorized;before=$before;denied=$denied;deniedCount=$deniedCount;activated=$activated;again=$again;successCount=$successCount;switched=$switched;finalCount=[AcbInput]::Attempts} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { unauthorized: 'ERR:FOCUS_REQUIRED', before: 0, denied: 'ERR:FOCUS_REQUIRED', deniedCount: 1, activated: 'ok', again: 'ok', successCount: 2, switched: 'ERR:FOCUS_REQUIRED', finalCount: 2 });
});

test('composer binding: a refreshed RuntimeId needs the same page, focus and exact prior text', { skip: !available }, () => {
  const result = pwsh(`${fn('CurrentComposer')}
function AssertForeground {}
function Document {[pscustomobject]@{Current=@{Name=$script:title}}}
function FindComposer($doc) {$script:edit}
function ElementKey($edit) {$edit.Key}
function Focused($edit) {$script:focused}
function ComposerText($edit) {$edit.Text}
function Normalize($t) {$t.Trim()}
function Case($title,$focused,$text) {
 $script:composeTitle='target';$script:composerKey='old';$script:title=$title;$script:focused=$focused;$script:edit=@{Key='new';Text=$text}
 @{outcome=${attempt("[void](CurrentComposer 'our prefix');'ok'")};key=$script:composerKey}
}
@{refreshed=(Case 'target' $true 'our prefix');different=(Case 'target' $true 'another draft');caseDiff=(Case 'target' $true 'OUR PREFIX');blurred=(Case 'target' $false 'our prefix');otherPage=(Case 'other' $true 'our prefix')} | ConvertTo-Json -Compress`);
  assert.deepEqual(result.refreshed, { outcome: 'ok', key: 'new' });
  assert.deepEqual(result.different, { outcome: 'ERR:STATE', key: 'old' });
  assert.deepEqual(result.caseDiff, { outcome: 'ERR:STATE', key: 'old' });
  assert.deepEqual(result.blurred, { outcome: 'ERR:FOCUS_REQUIRED', key: 'old' });
  assert.deepEqual(result.otherPage, { outcome: 'ERR:PROVENANCE', key: 'old' });
});

test('multiline input: preserves blank lines through guarded ValuePattern prefixes and stops on focus loss', { skip: !available }, () => {
  const result = pwsh(`Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
public static class AcbFolderControls {public static bool Interactive(){return true;}}
public static class AcbInput {
 public static IntPtr Foreground=new IntPtr(1); public static int Keys=0;
 public static IntPtr GetForegroundWindow(){return Foreground;}
 public static bool Type(string text,IntPtr window){Keys++;return true;}
}
'@
${fn('Normalize')}${fn('Within')}${fn('AssertForeground')}${fn('TypeInto')}
function EnsureForeground {AssertForeground}
function Focused($edit) {$true}
function ComposerText($edit) {Normalize $edit.V}
function CurrentComposer($expected) {AssertForeground;return $script:edit}
$script:edit=[pscustomobject]@{V=''}
Add-Member -InputObject $script:edit -MemberType ScriptMethod -Name SetFocus -Value {}
Add-Member -InputObject $script:edit -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {param($p,$out) $out.Value=$script:pattern;return $true}
$script:pattern=[pscustomobject]@{Current=@{IsReadOnly=$false}}
Add-Member -InputObject $script:pattern -MemberType ScriptMethod -Name SetValue -Value {param($v) $script:edit.V=$v;$script:writes.Add($v);if($script:switch){[AcbInput]::Foreground=[IntPtr]2}}
function Case($text,$switch,$authorized) {
 $request=[pscustomobject]@{foregroundInput=$authorized;timeoutMs=2000;pollMs=1}
 $script:handle=[IntPtr]1;$script:focusLost=$false;$script:typedText='';$script:edit.V='';$script:switch=$switch
 [AcbInput]::Foreground=[IntPtr]1;[AcbInput]::Keys=0
 $script:writes=[System.Collections.Generic.List[string]]::new()
 $outcome=${attempt("TypeInto $script:edit $text;'ok'")}
 @{outcome=$outcome;value=$script:edit.V;writes=@($script:writes.ToArray());keys=[AcbInput]::Keys}
}
$text="ACB first\`n\`nsecond paragraph\`n\`nlast"
@{text=$text;complete=(Case $text $false $true);switched=(Case $text $true $true);unauthorized=(Case $text $false $false);single=(Case 'plain text' $false $true)} | ConvertTo-Json -Compress -Depth 5`);
  assert.equal(result.complete.outcome, 'ok'); assert.equal(result.complete.value, result.text);
  assert.equal(result.complete.keys, 0); assert.ok(result.complete.writes.length > 1);
  assert.ok(result.complete.writes.every((prefix: string) => result.text.startsWith(prefix)));
  assert.equal(result.switched.outcome, 'ERR:FOCUS_REQUIRED'); assert.equal(result.switched.writes.length, 1); assert.equal(result.switched.keys, 0);
  assert.equal(result.unauthorized.outcome, 'ERR:AUTH'); assert.equal(result.unauthorized.writes.length, 0);
  assert.equal(result.single.outcome, 'ok'); assert.equal(result.single.writes.length, 0); assert.ok(result.single.keys > 0);
});
