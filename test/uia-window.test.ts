import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Window choice and the GPT new-chat check run as the real worker
// functions against mocks; no desktop is touched.
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true }).status === 0;
const skipWindowsUia = process.platform !== 'win32' ? 'UIAutomationClient requires Windows' : !available;
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

test('foreground: one verified UIA focus request waits for restore and never retries after denial or focus loss', { skip: !available }, () => {
  const result = pwsh(`Add-Type -TypeDefinition @'
using System;
public static class AcbInput {
 public static IntPtr Foreground; public static int Focuses, Restores, RestoreChecks;
 public static bool Allow, Iconic, Pending, RestoreAccepted, RestoreActivates, SwitchOnRestore, SwitchOnFocus, ThrowOnFocus;
 public static void Reset(){Foreground=new IntPtr(2);Focuses=Restores=0;RestoreChecks=2;Allow=Iconic=Pending=RestoreActivates=SwitchOnRestore=SwitchOnFocus=ThrowOnFocus=false;RestoreAccepted=true;}
 public static IntPtr GetForegroundWindow(){return Foreground;}
 public static bool IsIconic(IntPtr w){if(Pending){if(SwitchOnRestore)Foreground=new IntPtr(3);if(RestoreChecks--<=0){Pending=Iconic=false;if(RestoreActivates)Foreground=w;}}return Iconic;}
 public static bool ShowWindowAsync(IntPtr w,int c){Restores++;Pending=RestoreAccepted;return RestoreAccepted;}
 public static void Focus(){Focuses++;if(ThrowOnFocus||Iconic)throw new InvalidOperationException("Not focusable");if(SwitchOnFocus)Foreground=new IntPtr(3);else if(Allow)Foreground=new IntPtr(1);}
}
'@
${fn('Within')}${fn('StopForFocus')}${fn('AssertForeground')}${fn('EnsureForeground')}
$request=[pscustomobject]@{timeoutMs=100;pollMs=1;foregroundInput=$true}
$script:handle=[IntPtr]1
$script:root=[pscustomobject]@{Current=@{IsKeyboardFocusable=$false}}
$script:root | Add-Member ScriptMethod SetFocus {throw 'Top-level window is not focusable'}
$script:focusTarget=[pscustomobject]@{}
$script:focusTarget | Add-Member ScriptMethod SetFocus {[AcbInput]::Focus()}
function Document {$script:root}
function FindComposer($doc) {if($script:switchOnLookup){[AcbInput]::Foreground=[IntPtr]3};return $script:focusTarget}
function Reset {
 [AcbInput]::Reset();$script:gptProven=$true;$request.foregroundInput=$true
 $script:switchOnLookup=$false
 $script:focusLost=$false;$script:foregroundChecked=$false;$script:diagnostics=$null;$script:activation=$null;$script:typedText=''
}
function Run {@{outcome=${attempt("EnsureForeground;'ok'")};focuses=[AcbInput]::Focuses;restores=[AcbInput]::Restores;loss=$script:diagnostics}}
$cases=@{}
Reset
$request.foregroundInput=$false;[AcbInput]::Iconic=$true;$cases.unauthorized=Run
Reset
$script:gptProven=$false;$cases.unknown=Run
Reset
$cases.denied=Run;$cases.deniedAgain=Run
Reset
[AcbInput]::ThrowOnFocus=$true;$cases.providerError=Run
Reset
[AcbInput]::Allow=$true;$cases.activated=Run;$cases.again=Run
[AcbInput]::Foreground=[IntPtr]2
$script:typedText='our prefix'
$cases.switched=Run
Reset
[AcbInput]::Iconic=$true;[AcbInput]::Allow=$true;$cases.restored=Run
Reset
[AcbInput]::Iconic=$true;[AcbInput]::RestoreActivates=$true;$cases.restoreActivated=Run
Reset
[AcbInput]::Iconic=$true;[AcbInput]::RestoreAccepted=$false;$cases.restoreDenied=Run
Reset
[AcbInput]::Iconic=$true;[AcbInput]::RestoreChecks=2147483647;$cases.restoreTimeout=Run
Reset
[AcbInput]::Iconic=$true;[AcbInput]::SwitchOnRestore=$true;$cases.switchedWhileRestoring=Run
Reset
[AcbInput]::SwitchOnFocus=$true;$cases.switchedWhileFocusing=Run
Reset
$script:switchOnLookup=$true;$cases.switchedWhileFinding=Run
$cases | ConvertTo-Json -Compress -Depth 5`);
  const loss = (focusReason: string, foregroundHandle = 2, typedLength = 0) => ({ focusReason, targetHandle: 1, foregroundHandle, typedLength });
  assert.deepEqual(result.unauthorized, { outcome: 'ERR:FOCUS_REQUIRED', focuses: 0, restores: 0, loss: loss('foregroundNotAuthorized') });
  assert.deepEqual(result.unknown, { outcome: 'ERR:OWNER', focuses: 0, restores: 0, loss: null });
  assert.deepEqual(result.denied, { outcome: 'ERR:FOCUS_REQUIRED', focuses: 1, restores: 0, loss: { ...loss('activationDenied'), activation: { method: 'uiaComposerFocus', requestCompleted: true } } });
  assert.deepEqual(result.deniedAgain, result.denied);
  assert.equal(result.providerError.outcome, 'ERR:FOCUS_REQUIRED');
  assert.equal(result.providerError.focuses, 1);
  assert.equal(result.providerError.loss.focusReason, 'activationDenied');
  assert.equal(result.providerError.loss.activation.requestCompleted, false);
  assert.ok(result.providerError.loss.activation.hresult < 0);
  assert.deepEqual(result.activated, { outcome: 'ok', focuses: 1, restores: 0, loss: null });
  assert.deepEqual(result.again, result.activated);
  assert.deepEqual(result.switched, { outcome: 'ERR:FOCUS_REQUIRED', focuses: 1, restores: 0, loss: { ...loss('foregroundChanged', 2, 10), activation: { method: 'uiaComposerFocus', requestCompleted: true } } });
  assert.deepEqual(result.restored, { outcome: 'ok', focuses: 1, restores: 1, loss: null });
  assert.deepEqual(result.restoreActivated, { outcome: 'ok', focuses: 0, restores: 1, loss: null });
  for (const name of ['restoreDenied', 'restoreTimeout']) {
    assert.equal(result[name].outcome, 'ERR:FOCUS_REQUIRED', name);
    assert.equal(result[name].loss.focusReason, 'activationDenied', name);
    assert.equal(result[name].focuses, 0, name);
    assert.equal(result[name].restores, 1, name);
  }
  for (const name of ['switchedWhileRestoring', 'switchedWhileFocusing', 'switchedWhileFinding']) {
    assert.equal(result[name].outcome, 'ERR:FOCUS_REQUIRED', name);
    assert.equal(result[name].loss.focusReason, 'foregroundChanged', name);
    assert.equal(result[name].loss.foregroundHandle, 3, name);
    assert.equal(result[name].focuses, name === 'switchedWhileFocusing' ? 1 : 0, name);
  }
});

test('composer binding: a refreshed RuntimeId needs the same page, focus and exact prior text', { skip: !available }, () => {
  const result = pwsh(`Add-Type -TypeDefinition 'using System; public static class AcbInput {public static IntPtr GetForegroundWindow(){return new IntPtr(1);}}'
${fn('StopForFocus')}${fn('CurrentComposer')}
function AssertForeground {}
function Document {[pscustomobject]@{Current=@{Name=$script:title}}}
function FindComposer($doc) {$script:edit}
function ElementKey($edit) {$edit.Key}
function Focused($edit) {$script:focused}
function ComposerText($edit) {$edit.Text}
function Normalize($t) {$t.Trim()}
function Case($title,$focused,$text) {
 $script:composeTitle='target';$script:composerKey='old';$script:title=$title;$script:focused=$focused;$script:edit=@{Key='new';Text=$text}
 $script:handle=[IntPtr]1;$script:focusLost=$false;$script:typedText='our prefix';$script:diagnostics=$null
 @{outcome=${attempt("[void](CurrentComposer 'our prefix');'ok'")};key=$script:composerKey;loss=$script:diagnostics}
}
@{refreshed=(Case 'target' $true 'our prefix');different=(Case 'target' $true 'another draft');caseDiff=(Case 'target' $true 'OUR PREFIX');blurred=(Case 'target' $false 'our prefix');otherPage=(Case 'other' $true 'our prefix')} | ConvertTo-Json -Compress`);
  assert.deepEqual(result.refreshed, { outcome: 'ok', key: 'new', loss: null });
  assert.deepEqual(result.different, { outcome: 'ERR:STATE', key: 'old', loss: null });
  assert.deepEqual(result.caseDiff, { outcome: 'ERR:STATE', key: 'old', loss: null });
  assert.deepEqual(result.blurred, { outcome: 'ERR:FOCUS_REQUIRED', key: 'old', loss: { focusReason: 'composerFocusLost', targetHandle: 1, foregroundHandle: 1, typedLength: 10 } });
  assert.deepEqual(result.otherPage, { outcome: 'ERR:PROVENANCE', key: 'old', loss: null });
});

test('multiline input: preserves blank lines through guarded ValuePattern prefixes and stops on focus loss', { skip: skipWindowsUia }, () => {
  const result = pwsh(`Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
public static class AcbFolderControls {public static bool Interactive(){return true;}}
public static class AcbInput {
 public static IntPtr Foreground=new IntPtr(1); public static int Keys=0, TypedLength=0, Clears=0; public static bool Interrupt=false;
 public static IntPtr GetForegroundWindow(){return Foreground;}
 public static bool Type(string text,IntPtr window){Keys++;TypedLength=Interrupt?3:text.Length;if(Interrupt)Foreground=new IntPtr(2);return !Interrupt;}
 public static bool Clear(IntPtr window){Clears++;return true;}
}
'@
${fn('Normalize')}${fn('Within')}${fn('StopForFocus')}${fn('AssertForeground')}${fn('TypeInto')}${fn('ClearTyped')}
function EnsureForeground {AssertForeground}
function Focused($edit) {$script:focused}
function ComposerText($edit) {Normalize $edit.V}
function CurrentComposer($expected) {AssertForeground;return $script:edit}
$script:edit=[pscustomobject]@{V=''}
Add-Member -InputObject $script:edit -MemberType ScriptMethod -Name SetFocus -Value {}
Add-Member -InputObject $script:edit -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {param($p,$out) $out.Value=$script:pattern;if($script:switch -eq 'pattern-window'){[AcbInput]::Foreground=[IntPtr]2};if($script:switch -eq 'pattern-composer'){$script:focused=$false};return $true}
$script:pattern=[pscustomobject]@{Current=@{IsReadOnly=$false}}
Add-Member -InputObject $script:pattern -MemberType ScriptMethod -Name SetValue -Value {param($v) $script:edit.V=$v;$script:writes.Add($v);if($script:switch -eq 'window'){[AcbInput]::Foreground=[IntPtr]2};if($script:switch -eq 'composer'){$script:focused=$false}}
function Case($text,$switch,$authorized) {
 $request=[pscustomobject]@{foregroundInput=$authorized;timeoutMs=2000;pollMs=1}
 $script:handle=[IntPtr]1;$script:focusLost=$false;$script:typedText='';$script:edit.V='';$script:switch=$switch;$script:focused=$true;$script:diagnostics=$null;$script:typed=$null
 [AcbInput]::Foreground=[IntPtr]1;[AcbInput]::Keys=0;[AcbInput]::Clears=0;[AcbInput]::Interrupt=($switch -eq 'single-window')
 $script:writes=[System.Collections.Generic.List[string]]::new()
 $outcome=${attempt("TypeInto $script:edit $text;'ok'")}
 if($script:focusLost){ClearTyped}
 @{outcome=$outcome;value=$script:edit.V;writes=@($script:writes.ToArray());keys=[AcbInput]::Keys;loss=$script:diagnostics;clears=[AcbInput]::Clears}
}
$text="ACB first\`n\`nsecond paragraph\`n\`nlast"
$unicode="ACB1234😀中文\`n\`n\`n末段"
@{text=$text;complete=(Case $text '' $true);unicodeText=$unicode;unicode=(Case $unicode '' $true);switched=(Case $text 'window' $true);blurred=(Case $text 'composer' $true);patternWindow=(Case $text 'pattern-window' $true);patternComposer=(Case $text 'pattern-composer' $true);unauthorized=(Case $text '' $false);single=(Case 'plain text' '' $true);singleSwitched=(Case 'plain text' 'single-window' $true)} | ConvertTo-Json -Compress -Depth 5`);
  assert.equal(result.complete.outcome, 'ok'); assert.equal(result.complete.value, result.text);
  assert.equal(result.complete.keys, 0); assert.ok(result.complete.writes.length > 1);
  assert.ok(result.complete.writes.every((prefix: string) => result.text.startsWith(prefix)));
  assert.equal(result.unicode.outcome, 'ok'); assert.equal(result.unicode.value, result.unicodeText);
  assert.ok(result.unicode.writes.every((prefix: string) => result.unicodeText.startsWith(prefix) && !/[\uD800-\uDBFF]$/.test(prefix)));
  assert.equal(result.switched.outcome, 'ERR:FOCUS_REQUIRED'); assert.equal(result.switched.writes.length, 1); assert.equal(result.switched.keys, 0);
  assert.deepEqual(result.switched.loss, { focusReason: 'foregroundChanged', targetHandle: 1, foregroundHandle: 2, typedLength: 8 });
  assert.equal(result.switched.clears, 0);
  assert.equal(result.blurred.outcome, 'ERR:FOCUS_REQUIRED'); assert.equal(result.blurred.writes.length, 1);
  assert.deepEqual(result.blurred.loss, { focusReason: 'composerFocusLost', targetHandle: 1, foregroundHandle: 1, typedLength: 8 });
  assert.equal(result.blurred.clears, 0);
  for (const [key, reason] of [['patternWindow', 'foregroundChanged'], ['patternComposer', 'composerFocusLost']]) {
    assert.equal(result[key].outcome, 'ERR:FOCUS_REQUIRED'); assert.equal(result[key].writes.length, 0);
    assert.equal(result[key].loss.focusReason, reason); assert.equal(result[key].loss.typedLength, 0);
  }
  assert.equal(result.unauthorized.outcome, 'ERR:AUTH'); assert.equal(result.unauthorized.writes.length, 0);
  assert.equal(result.single.outcome, 'ok'); assert.equal(result.single.writes.length, 0); assert.ok(result.single.keys > 0);
  assert.equal(result.singleSwitched.outcome, 'ERR:FOCUS_REQUIRED'); assert.equal(result.singleSwitched.keys, 1);
  assert.deepEqual(result.singleSwitched.loss, { focusReason: 'foregroundChanged', targetHandle: 1, foregroundHandle: 2, typedLength: 3 });
  assert.equal(result.singleSwitched.clears, 0);
});

test('composer verification: losing focus after input or immediately before submission retains progress diagnostics', { skip: !available }, () => {
  const result = pwsh(`Add-Type -TypeDefinition 'using System; public static class AcbInput {public static IntPtr GetForegroundWindow(){return new IntPtr(1);}}'
${fn('StopForFocus')}${fn('AssertForeground')}${fn('Within')}${fn('Compose')}${fn('VerifyComposed')}
function FindComposer($doc) {$script:edit}
function Document {[pscustomobject]@{Current=@{Name='target'}}}
function ElementKey($edit) {'bound'}
function ComposerText($edit) {$edit.Text}
function Focused($edit) {$false}
function CurrentComposer($expected) {AssertForeground;return $script:edit}
function TypeInto($edit,$text) {$edit.Text=$text;$script:typedText=$text}
function Case($beforeSend) {
 $request=[pscustomobject]@{timeoutMs=20;pollMs=1}
 $script:handle=[IntPtr]1;$script:focusLost=$false;$script:diagnostics=$null;$script:typedText='';$script:edit=[pscustomobject]@{Text=''}
 if($beforeSend){$script:inputMode='typed';$script:typedText='our prefix';$script:edit.Text='our prefix';$outcome=${attempt("VerifyComposed 'our prefix';'ok'")}}
 else{$outcome=${attempt("Compose 'our prefix';'ok'")}}
 @{outcome=$outcome;loss=$script:diagnostics;value=$script:edit.Text}
}
@{afterInput=(Case $false);beforeSend=(Case $true)}|ConvertTo-Json -Compress`);
  for (const key of ['afterInput', 'beforeSend']) {
    assert.equal(result[key].outcome, 'ERR:FOCUS_REQUIRED'); assert.equal(result[key].value, 'our prefix');
    assert.deepEqual(result[key].loss, { focusReason: 'composerFocusLost', targetHandle: 1, foregroundHandle: 1, typedLength: 10 });
  }
});

test('native input: a mid-chunk switch counts completed characters and cleanup refuses a different foreground window', { skip: !available }, () => {
  // Compile the real Type/Clear bodies with a fake SendInput boundary, never the desktop.
  const methods = / public static int TypedLength[\s\S]*?\n public static bool Clear[^\n]+/.exec(source)![0];
  const result = pwsh(`Add-Type -TypeDefinition @'
using System;
public static class AcbInput {
 struct INPUT {}
 public static IntPtr Foreground=new IntPtr(1);
 public static int Sends=0, SwitchAfter=2;
 public static IntPtr GetForegroundWindow(){return Foreground;}
 static INPUT Key(ushort vk,ushort scan,uint flags){return new INPUT();}
 static bool Send(System.Collections.Generic.List<INPUT> list){Sends++;if(Sends==SwitchAfter)Foreground=new IntPtr(2);return true;}
${methods}
}
'@
$partial=[AcbInput]::Type('abcdef',[IntPtr]1);$partialLength=[AcbInput]::TypedLength;$partialSends=[AcbInput]::Sends
$blocked=[AcbInput]::Type('more',[IntPtr]1);$blockedLength=[AcbInput]::TypedLength
$clear=[AcbInput]::Clear([IntPtr]1);$afterClear=[AcbInput]::Sends
[AcbInput]::Foreground=[IntPtr]1
$complete=[AcbInput]::Type('ok',[IntPtr]1)
@{partial=$partial;partialLength=$partialLength;partialSends=$partialSends;blocked=$blocked;blockedLength=$blockedLength;clear=$clear;afterClear=$afterClear;complete=$complete;completeLength=[AcbInput]::TypedLength} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { partial: false, partialLength: 2, partialSends: 2, blocked: false, blockedLength: 0, clear: false, afterClear: 2, complete: true, completeLength: 2 });
});

test('cleanup: losing foreground or composer focus during text readback never clears the draft', { skip: !available }, () => {
  const result = pwsh(`Add-Type -TypeDefinition 'using System; public static class AcbInput {public static IntPtr Foreground=new IntPtr(1);public static int Clears=0;public static IntPtr GetForegroundWindow(){return Foreground;}public static bool Clear(IntPtr window){Clears++;return true;}}'
${fn('Normalize')}${fn('StopForFocus')}${fn('AssertForeground')}${fn('ClearTyped')}
function CurrentComposer($expected) {AssertForeground;return 'edit'}
function Focused($edit) {$script:focused}
function ComposerText($edit) {if($script:mode -eq 'window'){[AcbInput]::Foreground=[IntPtr]2};if($script:mode -eq 'composer'){$script:focused=$false};if($script:mode -eq 'otherDraft'){return 'user draft'};return 'our prefix'}
function Case($mode) {
 $script:mode=$mode;$script:handle=[IntPtr]1;$script:typed='edit';$script:typedText='our prefix';$script:focusLost=$false;$script:focused=$true;$script:diagnostics=$null
 [AcbInput]::Foreground=[IntPtr]1;[AcbInput]::Clears=0
 ClearTyped
 @{clears=[AcbInput]::Clears;loss=$script:diagnostics}
}
@{window=(Case 'window');composer=(Case 'composer');otherDraft=(Case 'otherDraft');owned=(Case 'owned')} | ConvertTo-Json -Compress`);
  assert.equal(result.window.clears, 0); assert.equal(result.window.loss.focusReason, 'foregroundChanged');
  assert.equal(result.composer.clears, 0); assert.equal(result.otherDraft.clears, 0);
  assert.equal(result.owned.clears, 1);
});

test('submit: a foreground change while obtaining the invoke pattern stops before invoking the button', { skip: skipWindowsUia }, () => {
  const result = pwsh(`Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition 'using System; public static class AcbFolderControls {public static bool Interactive(){return true;}} public static class AcbInput {public static IntPtr Foreground=new IntPtr(1);public static IntPtr GetForegroundWindow(){return Foreground;}}'
${fn('StopForFocus')}${fn('AssertForeground')}${fn('Invoke')}
$script:handle=[IntPtr]1;$script:focusLost=$false;$script:typedText='our prefix';$script:diagnostics=$null
$edit=[pscustomobject]@{Current=@{IsEnabled=$true;IsOffscreen=$false}}
Add-Member -InputObject $edit -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {param($p,$out) [AcbInput]::Foreground=[IntPtr]2;$out.Value=[pscustomobject]@{};return $true}
@{outcome=${attempt("Invoke $edit;'ok'")};loss=$script:diagnostics} | ConvertTo-Json -Compress`);
  assert.deepEqual(result, { outcome: 'ERR:FOCUS_REQUIRED', loss: { focusReason: 'foregroundChanged', targetHandle: 1, foregroundHandle: 2, typedLength: 10 } });
});

test('minimized window: with authorization the app\'s only, unreadable window is restored once, then identified before any use', { skip: !available }, () => {
  const result = pwsh(`Add-Type -TypeDefinition @'
using System;
public static class AcbInput {
 public static bool Iconic, Accept; public static int Restores, Command;
 public static bool IsIconic(IntPtr w){return Iconic;}
 public static bool ShowWindowAsync(IntPtr w,int c){Restores++;Command=c;if(Accept)Iconic=false;return Accept;}
}
'@
${fn('Within')}${fn('RevealMinimized')}
$request=[pscustomobject]@{timeoutMs=100;pollMs=1;foregroundInput=$true}
function W {[pscustomobject]@{Current=@{NativeWindowHandle=7}}}
# A minimized window has no readable tree; once shown it reads as $script:mode.
function WindowKind($w) {if ([AcbInput]::Iconic) {$null} else {$script:mode}}
function Run($windows,[bool]$iconic=$true,[bool]$authorized=$true,[bool]$accept=$true,$mode='ChatGPT') {
 [AcbInput]::Iconic=$iconic;[AcbInput]::Accept=$accept;[AcbInput]::Restores=0;$script:mode=$mode;$request.foregroundInput=$authorized;$script:all=$windows;$all=$windows
 RevealMinimized
 @{restores=[AcbInput]::Restores;command=[AcbInput]::Command;kind=(WindowKind $windows[0]);stage=$script:stage}
}
@{
 restored=Run @(W)
 codexAfterRestore=Run @(W) -mode 'Codex'
 unauthorized=Run @(W) -authorized $false
 twoWindows=Run @((W),(W))
 shown=Run @(W) -iconic $false
 refused=Run @(W) -accept $false
} | ConvertTo-Json -Compress`);
  // SW_SHOWNOACTIVATE (4), never SW_RESTORE (9): an unidentified window is not activated.
  assert.deepEqual(result.restored, { restores: 1, command: 4, kind: 'ChatGPT', stage: 'chatgpt-window' });
  // Restoring only reveals the window: a Codex window still reads as Codex and is refused by PickGptWindow.
  assert.equal(result.codexAfterRestore.restores, 1); assert.equal(result.codexAfterRestore.kind, 'Codex');
  for (const name of ['unauthorized', 'twoWindows', 'shown']) assert.equal(result[name].restores, 0, name);
  assert.deepEqual(result.refused, { restores: 1, command: 4, kind: null, stage: 'chatgpt-window' });
});
