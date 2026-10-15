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
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
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
  assert.deepEqual(result, { both: 'gpt', codexOnly: 'ERR:OWNER', codexAndUnknown: 'ERR:OWNER', twoGpt: 'ERR:OWNER', soleUnknown: 'x', soleUnknownStrict: 'ERR:OWNER' });
});

test('window: the identity marker is typed and sent only on a blank GPT new-chat page', { skip: !available }, () => {
  const result = pwsh(`${fn('GptLanding')}
$script:root=$null
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
  assert.deepEqual(result, { gpt: true, codex: false, noSwitchStrict: false, noSwitchBeforeSend: true, hasMessage: false, hasReply: false, noComposer: false });
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
