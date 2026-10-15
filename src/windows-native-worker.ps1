$initClock=[Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::Error.WriteLine('ACB_UI_STAGE=input')
Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AcbFolderControls {
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,int size,out int needed);
 public static bool Interactive() {var handle=OpenInputDesktop(0,false,1);if(handle==IntPtr.Zero)return false;try {var text=new StringBuilder(256);int needed;return GetUserObjectInformation(handle,2,text,512,out needed)&&text.ToString()=="Default";}finally {CloseDesktop(handle);}}
}
/** Authorized foreground keyboard input (SendInput, Unicode packets). */
public static class AcbInput {
 [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {public ushort wVk;public ushort wScan;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}
 [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {public int dx;public int dy;public uint mouseData;public uint dwFlags;public uint time;public IntPtr dwExtraInfo;}
 [StructLayout(LayoutKind.Explicit)] struct UNION {[FieldOffset(0)] public MOUSEINPUT mi;[FieldOffset(0)] public KEYBDINPUT ki;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public UNION u;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window,int command);
 static INPUT Key(ushort vk,ushort scan,uint flags) {var input=new INPUT();input.type=1;input.u.ki.wVk=vk;input.u.ki.wScan=scan;input.u.ki.dwFlags=flags;return input;}
 static bool Send(System.Collections.Generic.List<INPUT> list) {var items=list.ToArray();return SendInput((uint)items.Length,items,Marshal.SizeOf(typeof(INPUT)))==items.Length;}
 // Unicode packets; a newline is Shift+Enter so the composer does not submit.
 public static bool Type(string text,IntPtr window) {
  foreach (char c in text) {
   if (GetForegroundWindow()!=window) return false;
   var list=new System.Collections.Generic.List<INPUT>();
   if (c=='\n') {list.Add(Key(0x10,0,0));list.Add(Key(0x0D,0,0));list.Add(Key(0x0D,0,2));list.Add(Key(0x10,0,2));}
   else {list.Add(Key(0,c,4));list.Add(Key(0,c,6));}
   if (!Send(list)) return false;
  }
  return true;
 }
 // Ctrl+A, Delete: removes only text this worker typed into a field that was empty.
 public static bool Clear() {var list=new System.Collections.Generic.List<INPUT>{Key(0x11,0,0),Key(0x41,0,0),Key(0x41,0,2),Key(0x11,0,2),Key(0x2E,0,0),Key(0x2E,0,2)};return Send(list);}
}
'@
[Console]::Error.WriteLine('ACB_UI_STAGE=worker-loaded')
$initMs=$initClock.ElapsedMilliseconds
function RunRequest($request) {
$actionClock=[Diagnostics.Stopwatch]::StartNew()
function Respond($result) {$result.timings=@{initMs=$initMs;actionMs=$actionClock.ElapsedMilliseconds};[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 9 -Compress))}
$script:stage='input'
$script:identity=$null
$script:typed=$null
$script:typedText=''
$script:composer=$null
$script:composerKey=$null
$script:composeTitle=$null
$script:focusLost=$false
$script:foregroundChecked=$false
$script:submission=$null
$script:diagnostics=$null
$script:gptProven=$false
$script:treeReadable=$true
$script:inputMode=$null
$script:landing=$false
$script:handle=[IntPtr]::Zero
$mutex=$null
$locked=$false
try {
 # Distinct stages tell the operator why UIA is unavailable; no app is started or restarted.
 $script:stage='interactive-desktop'
 if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
 $deadline=[DateTime]::UtcNow.AddMilliseconds($request.timeoutMs)
 $script:stage='chatgpt-process'
 $processes=@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
 if ($processes.Count -eq 0) {throw 'OWNER'}
 $script:stage='chatgpt-window'
 # Every top-level window of the app: it can show a ChatGPT and a Codex window side by side.
 $all=@(foreach ($process in $processes) {[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,[int]$process.Id))})
 if ($all.Count -eq 0) {throw 'OWNER'}
 $script:stage='input'
 function Find($scope,[string]$type,[string]$name,[string]$id='') {
  $conditions=[System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
  $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::$type))
  if ($name) {$conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name))}
  if ($id) {$conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id))}
  $condition=if ($conditions.Count -eq 1) {$conditions[0]} else {[System.Windows.Automation.AndCondition]::new($conditions.ToArray())}
  return $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
 }
 function Wait($predicate) {
  do {
   $value=& $predicate
   if ($value) {return $value}
   if ([DateTime]::UtcNow -ge $deadline) {throw 'TIMEOUT'}
   Start-Sleep -Milliseconds $request.pollMs
  } while ($true)
 }
 # Hidden, disabled or non-invokable controls are never invoked; only a sidebar chat
 # entry may be scrolled out of view (-offscreen), its InvokePattern still navigates.
 function Invoke($element,[switch]$offscreen) {
  if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
  $pattern=$null
  if ($null -eq $element -or -not $element.Current.IsEnabled -or ($element.Current.IsOffscreen -and -not $offscreen) -or -not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {throw 'STATE'}
  ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
 }
 function Value($element) {return ([System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value.Trim()}
 # The Chromium tree can be briefly unreadable: re-acquire the window and retry, at most 3 times.
 function Document {
  for ($attempt=0;$attempt -lt 3;$attempt++) {
   $doc=Find $script:root 'Document' ''
   if ($doc) {return $doc}
   $script:treeReadable=$false
   Start-Sleep -Milliseconds 700
   # Always the same window (by handle), never whichever window the app reports as main.
   try {$script:root=[System.Windows.Automation.AutomationElement]::FromHandle($script:handle)} catch {}
  }
  return $null
 }
 function ConversationId {
  $doc=Document
  $pattern=$null
  if (-not $doc -or -not $doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {return $null}
  # Public accessibility URI only; generic app://index.html contains no identity.
  $uri=[Uri]$pattern.Current.Value
  if ($uri.AbsolutePath -match '^/c/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$') {return $Matches[1]}
  return $null
 }
 function ComposerUsable($edit) {
  if (-not $edit) {return $false}
  try {
   $c=$edit.Current
   return ($c.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $c.Name -in @('询问 ChatGPT','使用 ChatGPT Work','Ask ChatGPT','Message ChatGPT') -and $c.IsEnabled -and -not $c.IsOffscreen -and $c.IsKeyboardFocusable -and -not $c.BoundingRectangle.IsEmpty)
  } catch [System.Windows.Automation.ElementNotAvailableException] {return $false}
 }
 # Filter hidden/disabled edits before choosing. Keep the same RuntimeId during an
 # input transaction; a replacement must be independently rebound by CurrentComposer.
 function FindComposer($doc,$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker) {
  if (-not $doc) {return $null}
  if ($script:landing) {
   $edits=$doc.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit))
   $live=@($edits | Where-Object {ComposerUsable $_})
   if ($live.Count -gt 1) {$script:stage='chat-compose-ambiguous';throw 'STATE'}
   if ($live.Count -eq 1) {return $live[0]};return $null
  }
  $stack=[System.Collections.Generic.Stack[object]]::new();$visited=0
  $found=$null
  $last=$walker.GetLastChild($doc);if ($null -ne $last) {$stack.Push($last)}
  while ($stack.Count -gt 0 -and $visited -lt 400) {
   if ([DateTime]::UtcNow -ge $deadline) {throw 'TIMEOUT'}
   $node=$stack.Pop();$visited++
   if (ComposerUsable $node) {
    if ($found) {$script:stage='chat-compose-ambiguous';throw 'STATE'}
    $found=$node
    # A bound, live editor is the only editor this transaction may reuse.
    if ($script:composerKey -and (ElementKey $node) -eq $script:composerKey) {return $node}
   }
   # Once the composer is found, do not descend into the (potentially huge) transcript.
   if ($found -and $node.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') {continue}
   $previous=$walker.GetPreviousSibling($node);if ($null -ne $previous) {$stack.Push($previous)}
   $child=$walker.GetLastChild($node);if ($null -ne $child) {$stack.Push($child)}
  }
  return $found
 }
 function Normalize([string]$text) {return ($text -replace "`r`n","`n" -replace [char]0xA0,' ').Trim()}
 # The empty composer reports its placeholder (its Name, e.g. "询问 ChatGPT" plus a newline) as value.
 function ComposerText($edit) {
  $pattern=$null
  # Chromium's contenteditable is multiline. TextPattern reads its actual text;
  # ValuePattern on some builds prepends the accessible placeholder.
  if ($edit.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) {
   $script:textSource='TextPattern'
   $value=Normalize $pattern.DocumentRange.GetText(65537)
  } else {$script:textSource='ValuePattern';$value=Normalize (Value $edit)}
  $name=Normalize $edit.Current.Name
  if (-not $name) {return $value}
  if ($value -eq $name) {return ''}
  if ($value.StartsWith("$name`n")) {return $value.Substring($name.Length+1).Trim()}
  return $value
 }
 # Bounded poll: returns $null after $ms (never longer than the request budget).
 function Within([int]$ms,$predicate) {
  $until=[DateTime]::UtcNow.AddMilliseconds([Math]::Min($ms,[int]$request.timeoutMs))
  if ($deadline -and $deadline -lt $until) {$until=$deadline}
  do {$value=& $predicate;if ($value) {return $value};Start-Sleep -Milliseconds ([Math]::Min(500,[int]$request.pollMs))} while ([DateTime]::UtcNow -lt $until)
  return $null
 }
 function Focused($edit) {
  $focused=[System.Windows.Automation.AutomationElement]::FocusedElement;$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($i=0;$i -lt 8 -and $null -ne $focused;$i++) {if ((ElementKey $focused) -eq (ElementKey $edit)) {return $true};$focused=$walker.GetParent($focused)}
  return $false
 }
 function AssertForeground {
  if ($script:focusLost -or [AcbInput]::GetForegroundWindow() -ne $script:handle) {$script:focusLost=$true;throw 'FOCUS_REQUIRED'}
 }
 function EnsureForeground {
  if ($script:foregroundChecked) {AssertForeground;return}
  $script:stage='input-foreground'
  if ([AcbInput]::GetForegroundWindow() -ne $script:handle) {
   if ($request.foregroundInput -ne $true) {throw 'FOCUS_REQUIRED'}
   if (-not $script:gptProven) {throw 'OWNER'}
   $script:stage='input-activate'
   if ([AcbInput]::IsIconic($script:handle)) {[void][AcbInput]::ShowWindowAsync($script:handle,9)}
   # Windows may refuse. No simulated Alt key, focus-lock changes or retry loop.
   [void][AcbInput]::SetForegroundWindow($script:handle)
   if (-not (Within 2000 {if ([AcbInput]::GetForegroundWindow() -eq $script:handle) {$true}})) {throw 'FOCUS_REQUIRED'}
  }
  $script:foregroundChecked=$true
  AssertForeground
 }
 function CurrentComposer([string]$expected) {
  AssertForeground
  $doc=Document
  if (-not $doc -or $doc.Current.Name -ne $script:composeTitle) {$script:stage='conversation-identity';throw 'PROVENANCE'}
  $current=FindComposer $doc
  if (-not $current) {return $null}
  if ((ElementKey $current) -ne $script:composerKey) {
   # A UIA refresh can replace the edit. Never select a different field merely
   # because it has the same name: it must be the sole visible, focused edit,
   # on the same page, containing exactly our previously verified text.
   if (-not (Focused $current)) {$script:focusLost=$true;throw 'FOCUS_REQUIRED'}
   if ((ComposerText $current) -cne (Normalize $expected)) {$script:stage='chat-compose-replaced';throw 'STATE'}
   $script:composerKey=ElementKey $current
  }
  $script:composer=$current
  return $current
 }
 # Writes to $edit with guarded UIA/SendInput, only when the request carries the user's
 # authorization. The ChatGPT window must be in front and $edit focused before every chunk.
 function TypeInto($edit,[string]$text) {
  $script:stage='input-authorize'
  if ($request.foregroundInput -ne $true) {throw 'AUTH'}
  if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
  EnsureForeground
  $script:stage='input-focus'
  $edit.SetFocus()
  if (-not (Within 3000 {AssertForeground;$now=CurrentComposer '';if ($now -and (Focused $now)) {$true}})) {throw 'FOCUS_REQUIRED'}
  $script:stage='input-type';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
  $script:typed=$edit
  # This Chromium editor collapses consecutive Shift+Enter breaks. For multiline
  # text, use its supported ValuePattern on our own verified prefix, never keyboard
  # newline events. Read the exact prefix back after every write; no whitespace
  # equivalence is used for the final prompt comparison.
  $multiline=$text.Contains("`n")
  for ($offset=0;$offset -lt $text.Length;) {
   # The user moved the window or focus: stop rather than type elsewhere.
   $edit=CurrentComposer $script:typedText
   if (-not $edit -or -not (Focused $edit)) {$script:focusLost=$true;throw 'FOCUS_REQUIRED'}
   $count=[Math]::Min(8,$text.Length-$offset)
   # Do not split a surrogate pair across chunks.
   if ($offset+$count -lt $text.Length -and [char]::IsHighSurrogate($text[$offset+$count-1])) {$count--}
   $chunk=$text.Substring($offset,$count)
   if ($multiline) {
    if ((ComposerText $edit) -cne (Normalize $script:typedText)) {throw 'CONFLICT'}
    $pattern=$null
    if (-not $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern) -or $pattern.Current.IsReadOnly) {$script:stage='input-multiline-pattern';throw 'STATE'}
    $pattern.SetValue($script:typedText+$chunk)
   } elseif (-not [AcbInput]::Type($chunk,$script:handle)) {AssertForeground;throw 'IO'}
   $script:typedText+=$chunk;$script:typed=$edit;$offset+=$count
   if ($multiline) {
    $verified=Within 1000 {$now=CurrentComposer $script:typedText;if ($now -and -not (Focused $now)) {$script:focusLost=$true;throw 'FOCUS_REQUIRED'};if ($now -and (ComposerText $now) -ceq (Normalize $script:typedText)) {$true}}
    if (-not $verified) {$script:stage='input-multiline-verify';throw 'STATE'}
   }
   Start-Sleep -Milliseconds 10
  }
 }
 # After a failure, remove only what this worker typed (the field was empty before).
 function ClearTyped {
  if ($null -eq $script:typed) {return}
  try {if (-not $script:focusLost) {$edit=CurrentComposer $script:typedText;if ($edit -and (Focused $edit) -and (ComposerText $edit) -ceq (Normalize $script:typedText)) {[void][AcbInput]::Clear()}}} catch {}
  $script:typed=$null
 }
 # Writes $prompt into an empty ordinary composer and requires it to read back within ~10 s.
 function Compose([string]$prompt) {
  $script:stage='chat-compose-find';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
  $edit=Within 10000 {FindComposer (Document)}
  if (-not $edit) {throw 'STATE'}
  $script:composer=$edit;$script:composerKey=ElementKey $edit;$script:composeTitle=(Document).Current.Name
  $beforeKey=$script:composerKey
  $draft=ComposerText $edit
  # drafted: the user already wrote exactly this prompt; nothing is typed.
  if ($draft -ceq $prompt) {$script:inputMode='drafted';return}
  if ($draft) {throw 'CONFLICT'}
  $script:inputMode='typed'
  TypeInto $edit $prompt
  $script:stage='chat-compose-verify';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
  $written=Within 10000 {$current=CurrentComposer $prompt;if ($current -and -not (Focused $current)) {$script:focusLost=$true;throw 'FOCUS_REQUIRED'};if ($current -and (ComposerText $current) -ceq $prompt) {$current}}
  if (-not $written) {
   $after=CurrentComposer $prompt;$actual=if ($after) {ComposerText $after} else {''}
   $script:diagnostics=@{beforeRuntimeId=$beforeKey;afterRuntimeId=$(if ($after) {ElementKey $after} else {$null});expectedLength=$prompt.Length;actualLength=$actual.Length;textSource=$script:textSource;visible=($null -ne $after);focused=($after -and (Focused $after))}
   $script:stage=if (-not $actual) {'chat-compose-verify-empty'} else {'chat-compose-verify-different'};throw 'STATE'
  }
 }
 function VerifyComposed([string]$prompt) {
  $edit=CurrentComposer $prompt
  if (-not $edit -or (ComposerText $edit) -cne $prompt) {$script:stage='chat-compose-before-send';throw 'STATE'}
  if ($script:inputMode -eq 'typed' -and -not (Focused $edit)) {$script:focusLost=$true;throw 'FOCUS_REQUIRED'}
 }
 function Buttons([string]$name,[switch]$offscreen,$scope=$script:root) {
  $condition=[System.Windows.Automation.AndCondition]::new([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name))
  $pattern=$null
  return @($scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition) | Where-Object {$_.Current.IsEnabled -and ($offscreen -or -not $_.Current.IsOffscreen) -and $_.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)})
 }
 function Sidebar {
  $groups=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Group))
  $nav=@($groups | Where-Object {$_.Current.Name -in @('首页','Home','导航','Navigation') -and -not $_.Current.IsOffscreen -and (WindowMode $_) -eq 'ChatGPT'})
  if ($nav.Count -ne 1) {$script:stage='gpt-sidebar';throw 'STATE'}
  return $nav[0]
 }
 function Prefixed($scope,[string]$prefix) {
  return @($scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)) | Where-Object {$_.Current.Name.StartsWith($prefix)})
 }
 # The mode switch names the window's kind ("ChatGPT", "Codex", ...); $null when not shown.
 function WindowMode($win) {
  $prefix='切换模式，当前模式：';$switch=@(Prefixed $win $prefix)
  if ($switch.Count -ne 1) {return $null}
  return $switch[0].Current.Name.Substring($prefix.Length)
 }
 function WindowKind($win) {
  $mode=WindowMode $win
  if ($mode) {return $mode}
  $doc=Find $win 'Document' ''
  if ($doc -and (FindComposer $doc)) {return 'ChatGPT'}
  return $null
 }
 # Both windows have a "新聊天" button: only the single window known to be ChatGPT is used.
 # A window of unknown kind is accepted only when it is the app's only window (-strict: never).
 function PickGptWindow($wins,[switch]$strict) {
  $kinds=@($wins | ForEach-Object {[pscustomobject]@{Window=$_;Kind=(WindowKind $_)}})
  $gpt=@($kinds | Where-Object {$_.Kind -eq 'ChatGPT'})
  if ($gpt.Count -eq 1) {return $gpt[0].Window}
  throw 'OWNER'
 }
 # A named chat is used in the one window showing that title, never in a Codex window.
 function PickWindow {
  if ($request.name -and $request.operation -ne 'chat-open-title') {
   $titled=@($all | Where-Object {$doc=Find $_ 'Document' '';$doc -and $doc.Current.Name -eq $request.name})
   if ($titled.Count -gt 1) {throw 'PROVENANCE'}
   if ($titled.Count -eq 1) {$kind=WindowKind $titled[0];if ($kind -ne 'ChatGPT') {throw 'OWNER'};return $titled[0]}
  }
  return PickGptWindow $all -strict:($request.operation -eq 'gpt-create')
 }
 # The blank GPT new-chat page: GPT mode (-strict: the switch must be shown) and no message yet.
 function GptLanding([switch]$strict) {
  $mode=WindowMode $script:root
  if (($mode -and $mode -ne 'ChatGPT') -or (-not $script:gptProven)) {return $false}
  $doc=Document
  return ($doc -and $null -ne (FindComposer $doc) -and -not (Find $doc 'Text' '你说：') -and -not (Find $doc 'Text' '您说：') -and -not (Find $doc 'Text' 'ChatGPT 说：'))
 }
 function Expand($element) {
  if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
  $pattern=$null
  if ($null -eq $element -or -not $element.Current.IsEnabled -or $element.Current.IsOffscreen) {throw 'STATE'}
  if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) {Invoke $element;return}
  # Radix menus may report Collapsed while open; Expand then refuses, which means open.
  try {([System.Windows.Automation.ExpandCollapsePattern]$pattern).Expand()} catch [InvalidOperationException] {}
 }
 function Choose($item) {
  $pattern=$null
  if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {Invoke $item;return}
  if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
  if ($item.Current.IsOffscreen -or -not $item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {throw 'STATE'}
  ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
 }
 function ProjectItems([string]$name) {
  return @($script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.AndCondition]::new([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::ListItem),[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name))))
 }
 function ElementKey($element) {return ($element.GetRuntimeId() -join '.')}
 # Puts the blank new chat into an existing ChatGPT project via "更改项目". The sidebar
 # lists projects too, so only an item that appeared with the menu counts, and the
 # button must read the project back; otherwise nothing is typed or sent.
 function ChooseProject([string]$project) {
  $script:stage='gpt-project';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
  $label='更改项目：'
  $button=@(Prefixed $script:root $label)
  if ($button.Count -ne 1) {throw 'PROVENANCE'}
  if ($button[0].Current.Name -eq "$label$project") {return}
  $before=@(ProjectItems $project | ForEach-Object {ElementKey $_})
  Expand $button[0]
  $script:stage='gpt-project-list'
  $items=@(Within 5000 {@(ProjectItems $project | Where-Object {(ElementKey $_) -notin $before})} | Where-Object {$_})
  if ($items.Count -ne 1) {throw 'PROVENANCE'}
  Choose $items[0]
  $script:stage='gpt-project-confirm'
  if (-not (Within 5000 {$now=@(Prefixed $script:root $label);if ($now.Count -eq 1 -and $now[0].Current.Name -eq "$label$project") {$true}})) {throw 'PROVENANCE'}
 }
 function AssertConversation([string]$id) {
  $script:stage='conversation-identity'
  if (-not $id) {throw 'PROVENANCE'}
  $current=ConversationId
  if ($current) {if ($current -ne $id) {throw 'PROVENANCE'};$script:identity='uuid';return}
  # The desktop app exposes only app://-/index.html (no /c/UUID route). Then only the
  # operator-opened current chat whose title and ordinary composer match is accepted;
  # this titleOnly mode does not prove the UUID identity.
  $doc=Document
  if (-not $doc -or -not $request.name -or $doc.Current.Name -ne $request.name -or $null -eq (FindComposer $doc)) {throw 'PROVENANCE'}
  $script:identity='titleOnly'
 }
 function Snapshot {
  $doc=Document
  $text=([System.Windows.Automation.TextPattern]$doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)).DocumentRange.GetText(65537)
  if ($text.Length -gt 65536) {throw 'PROVENANCE'}
  return @{title=$doc.Current.Name;text=$text;ordinaryComposer=($null -ne (FindComposer $doc));pid=$script:root.Current.ProcessId;conversationId=(ConversationId)}
 }
 function OpenChat([string]$title) {
  # No navigation. The title comes from the native read of the target conversation;
  # a different current chat stops here, before any composer or draft is touched.
  $script:stage='conversation-title'
  $doc=Document
  if (-not $title -or -not $doc -or $doc.Current.Name -ne $title) {throw 'PROVENANCE'}
  AssertConversation $request.conversationId
 }
 function Reply([string]$prompt) {
  $nodes=(Document).FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $users=@(for ($index=0;$index -lt $nodes.Count;$index++) {if ($nodes.Item($index).Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and $nodes.Item($index).Current.Name -eq $prompt) {$index}})
  if ($users.Count -ne 1) {return $null}
  $start=-1
  for ($index=$users[0]+1;$index -lt $nodes.Count;$index++) {if ($nodes.Item($index).Current.Name -eq 'ChatGPT 说：') {$start=$index+1;break}}
  if ($start -lt 0) {return $null}
  $parts=[System.Collections.Generic.List[string]]::new()
  $finished=$false
  $readAloud=$false
  for ($index=$start;$index -lt $nodes.Count;$index++) {
   $node=$nodes.Item($index)
   if ($node.Current.Name -in @('您说：','ChatGPT 说：')) {return $null}
   if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $node.Current.Name -eq '朗读' -and $node.Current.IsEnabled) {$readAloud=$true}
   if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $node.Current.Name -eq '更多操作') {$finished=$true;break}
   if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) {$parts.Add($node.Current.Name)}
  }
  $body=($parts -join "`n").Trim()
  if (-not $finished -or -not $readAloud -or -not $body) {return $null}
  if ($body.Length -gt 65536) {throw 'PROVENANCE'}
  return $body
 }
 function GptBusy {return ($null -ne (Find (Document) 'Button' '停止') -or $null -ne (Find (Document) 'Text' 'ChatGPT 正在回应'))}
 $script:stage='chatgpt-window'
 $script:root=PickWindow
 $script:handle=[IntPtr]$script:root.Current.NativeWindowHandle
 $script:gptProven=((WindowKind $script:root) -eq 'ChatGPT')
 if ($script:handle -eq [IntPtr]::Zero -or -not $script:gptProven) {throw 'OWNER'}
 if ($request.operation -eq 'snapshot') {
  $script:stage='current-gpt-view'
  $snapshot=Snapshot
  if ($request.name -and $snapshot.title -ne $request.name) {throw 'PROVENANCE'}
  if ($request.conversationId) {AssertConversation $request.conversationId}
  Respond @{ok=$true;snapshot=$snapshot};return
 }
 if ($request.operation -notin @('chat-send','chat-read-reply','chat-open-title','gpt-create')) {throw 'INPUT'}
 $mutex=[Threading.Mutex]::new($false,'ACB_Desktop_Write_Lock')
 $locked=$mutex.WaitOne(0)
 if (-not $locked) {throw 'CONFLICT'}
 if ($request.operation -in @('chat-send','gpt-create','chat-open-title')) {EnsureForeground}
 if ($request.operation -eq 'chat-open-title') {
  # Fallback navigation: only a sidebar chat entry whose title is unique is opened.
  # Entries scrolled out of the sidebar view count too, so uniqueness covers them all.
  $script:stage='open-title'
  $entries=Buttons $request.name -offscreen
  if ($entries.Count -ne 1) {throw 'PROVENANCE'}
  AssertForeground
  Invoke $entries[0] -offscreen
  if (-not (Within 10000 {$doc=Document;if ($doc -and $doc.Current.Name -eq $request.name) {$true}})) {throw 'TIMEOUT'}
  Respond @{ok=$true;conversationId=(ConversationId)};return
 }
 if ($request.operation -eq 'gpt-create') {
  # $script:root is the single window known to be ChatGPT (PickWindow -strict); its own
  # visible "新聊天" button is used, never the Codex window's.
  $script:stage='gpt-new-chat';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
  if ($request.foregroundInput -ne $true) {throw 'AUTH'}
  $new=Buttons '新聊天' -scope (Sidebar)
  if ($new.Count -ne 1) {throw 'PROVENANCE'}
  AssertForeground;Invoke $new[0]
  # Only an ordinary ChatGPT chat is used; the mode is read, never switched by guess.
  $script:stage='gpt-mode'
  if ((WindowMode $script:root) -in @('Codex')) {throw 'OWNER'}
  $script:stage='gpt-blank'
  $script:landing=$true
  if (-not (Within 10000 {AssertForeground;GptLanding -strict})) {throw 'STATE'}
  if ((ComposerText (FindComposer (Document)))) {throw 'CONFLICT'}
  if ($request.project) {ChooseProject $request.project;$script:stage='gpt-blank';if (-not (Within 10000 {AssertForeground;GptLanding -strict})) {throw 'STATE'}}
  try {Compose (Normalize $request.prompt)} catch {ClearTyped;throw}
  # Still the blank GPT page of this window right before the identity marker is sent.
  $script:stage='gpt-send-button'
  if (-not (GptLanding)) {ClearTyped;throw 'PROVENANCE'}
  $send=Within 10000 {Find (Document) 'Button' '发送'}
  if (-not $send) {ClearTyped;throw 'TIMEOUT'}
  VerifyComposed (Normalize $request.prompt)
  $script:submission='attempted';Invoke $send;$script:submission='sent';$script:typed=$null
  Respond @{ok=$true;conversationId=(ConversationId);project=$request.project;submission=$script:submission};return
 }
 $script:stage='chat-open'
 OpenChat $request.name
 if ($request.operation -eq 'chat-send') {
   $script:stage='chat-compose-set'
   AssertConversation $request.conversationId
   if ((Document).Current.Name -ne $request.name) {throw 'PROVENANCE'}
   try {Compose (Normalize $request.prompt)} catch {ClearTyped;throw}
   AssertConversation $request.conversationId
   if ((Document).Current.Name -ne $request.name) {ClearTyped;throw 'PROVENANCE'}
   $script:stage='chat-send-button';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $send=Within 10000 {Find (Document) 'Button' '发送'}
   if (-not $send) {ClearTyped;throw 'TIMEOUT'}
   AssertConversation $request.conversationId
   VerifyComposed (Normalize $request.prompt)
   $script:submission='attempted';Invoke $send;$script:submission='sent';$script:typed=$null
   Respond @{ok=$true;conversationId=(ConversationId);identity=$script:identity;inputMode=$script:inputMode};return
 }
 if ($request.operation -eq 'chat-read-reply') {
   $script:stage='gpt-reply';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $body=Wait {
    AssertConversation $request.conversationId
    if ((Document).Current.Name -ne $request.name) {throw 'PROVENANCE'}
    $composer=FindComposer (Document)
    if ($composer -and $composer.Current.IsEnabled -and -not (GptBusy)) {
     $final=Reply $request.prompt
     AssertConversation $request.conversationId
     if (-not (GptBusy)) {return $final}
    }
   }
   Respond @{ok=$true;body=$body;conversationId=(ConversationId);completionVerified=$true;identity=$script:identity};return
 }
} catch {
 $failureStage=$script:stage
 if ($null -ne $script:typed) {ClearTyped}
 $script:stage=$failureStage
 $code=$_.Exception.Message
 if ($code -notin @('INPUT','OWNER','IO','TIMEOUT','CONFLICT','PROVENANCE','STATE','AUTH','FOCUS_REQUIRED')) {$code='EXECUTION'}
 Respond @{ok=$false;code=$code;stage=$script:stage;treeReadable=$script:treeReadable;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;diagnostics=$script:diagnostics;submission=$script:submission;privateDiagnosticsOmitted=$true}
} finally {
 if ($locked) {$mutex.ReleaseMutex()}
 if ($mutex) {$mutex.Dispose()}
 $script:root=$null
}

}
while ($null -ne ($inputText=[Console]::In.ReadLine())) {RunRequest ($inputText | ConvertFrom-Json)}
