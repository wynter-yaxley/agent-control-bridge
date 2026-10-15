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
'@
[Console]::Error.WriteLine('ACB_UI_STAGE=worker-loaded')
$initMs=$initClock.ElapsedMilliseconds
function RunRequest($request) {
$actionClock=[Diagnostics.Stopwatch]::StartNew()
function Respond($result) {$result.timings=@{initMs=$initMs;actionMs=$actionClock.ElapsedMilliseconds};[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 9 -Compress))}
$script:stage='input'
$script:identity=$null
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
 $windows=@($processes | Where-Object {$_.MainWindowHandle -ne 0})
 if ($windows.Count -ne 1) {throw 'OWNER'}
 $script:stage='input'
 $window=$windows[0]
 $script:root=[System.Windows.Automation.AutomationElement]::FromHandle($window.MainWindowHandle)
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
 # Hidden, disabled or non-invokable controls are never invoked.
 function Invoke($element) {
  if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
  $pattern=$null
  if ($null -eq $element -or -not $element.Current.IsEnabled -or $element.Current.IsOffscreen -or -not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {throw 'STATE'}
  ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
 }
 function Value($element) {return ([System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value.Trim()}
 function Document {return Find $script:root 'Document' ''}
 function ConversationId {
  $doc=Document
  $pattern=$null
  if (-not $doc.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) {return $null}
  # Public accessibility URI only; generic app://index.html contains no identity.
  $uri=[Uri]$pattern.Current.Value
  if ($uri.AbsolutePath -match '^/c/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$') {return $Matches[1]}
  return $null
 }
 # Bounded reverse walk for the ordinary composer: it sits after every message in
 # document order, so visit last children first and stop after 400 nodes or the
 # deadline instead of a FindFirst over the whole conversation.
 function FindComposer($doc,$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker) {
  $stack=[System.Collections.Generic.Stack[object]]::new();$visited=0
  $last=$walker.GetLastChild($doc);if ($null -ne $last) {$stack.Push($last)}
  while ($stack.Count -gt 0 -and $visited -lt 400) {
   if ([DateTime]::UtcNow -ge $deadline) {throw 'TIMEOUT'}
   $node=$stack.Pop();$visited++
   if ($node.Current.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $node.Current.Name -eq '询问 ChatGPT') {return $node}
   $previous=$walker.GetPreviousSibling($node);if ($null -ne $previous) {$stack.Push($previous)}
   $child=$walker.GetLastChild($node);if ($null -ne $child) {$stack.Push($child)}
  }
  return $null
 }
 function Normalize([string]$text) {return ($text -replace "`r`n","`n" -replace [char]0xA0,' ').Trim()}
 # The empty composer reports its placeholder (its Name, e.g. "询问 ChatGPT" plus a newline) as value.
 function ComposerText($edit) {
  $value=Normalize (Value $edit);$name=Normalize $edit.Current.Name
  if (-not $name) {return $value}
  if ($value -eq $name) {return ''}
  if ($value.StartsWith("$name`n")) {return $value.Substring($name.Length+1).Trim()}
  return $value
 }
 # Bounded poll: returns $null after $ms (never longer than the request budget).
 function Within([int]$ms,$predicate) {
  $until=[DateTime]::UtcNow.AddMilliseconds([Math]::Min($ms,[int]$request.timeoutMs))
  do {$value=& $predicate;if ($value) {return $value};Start-Sleep -Milliseconds ([Math]::Min(500,[int]$request.pollMs))} while ([DateTime]::UtcNow -lt $until)
  return $null
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
  return @{title=$doc.Current.Name;text=$text;ordinaryComposer=($null -ne (FindComposer $doc));pid=$window.Id;conversationId=(ConversationId)}
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
 if ($request.operation -eq 'snapshot') {
  $script:stage='current-gpt-view'
  $snapshot=Snapshot
  if ($request.name -and $snapshot.title -ne $request.name) {throw 'PROVENANCE'}
  if ($request.conversationId) {AssertConversation $request.conversationId}
  Respond @{ok=$true;snapshot=$snapshot};return
 }
 if ($request.operation -notin @('chat-send','chat-read-reply')) {throw 'INPUT'}
 $mutex=[Threading.Mutex]::new($false,'ACB_Desktop_Write_Lock')
 $locked=$mutex.WaitOne(0)
 if (-not $locked) {throw 'CONFLICT'}
 $script:stage='chat-open'
 OpenChat $request.name
 if ($request.operation -eq 'chat-send') {
   $script:stage='chat-compose-find';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $prompt=Normalize $request.prompt
   $edit=Within 10000 {FindComposer (Document)}
   if (-not $edit) {throw 'PROVENANCE'}
   $draft=ComposerText $edit
   if ($draft -and $draft -ne $prompt) {throw 'CONFLICT'}
   $script:stage='chat-compose-set';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   AssertConversation $request.conversationId
   if ((Document).Current.Name -ne $request.name) {throw 'PROVENANCE'}
   if ($draft -ne $prompt) {
    if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
    ([System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($request.prompt)
    # The write must read back within ~10 s; otherwise stop instead of waiting for the whole budget.
    $script:stage='chat-compose-verify';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
    $written=Within 10000 {$current=FindComposer (Document);if ($current -and (ComposerText $current) -eq $prompt) {$current}}
    if (-not $written) {$after=FindComposer (Document);$script:stage=if (-not $after -or -not (ComposerText $after)) {'chat-compose-verify-empty'} else {'chat-compose-verify-different'};throw 'STATE'}
   }
   $script:stage='chat-send-button';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $send=Wait {Find (Document) 'Button' '发送'}
   AssertConversation $request.conversationId
   Invoke $send
   Respond @{ok=$true;conversationId=(ConversationId);identity=$script:identity};return
 }
 if ($request.operation -eq 'chat-read-reply') {
   $script:stage='gpt-reply';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $body=Wait {
    AssertConversation $request.conversationId
    if ((Document).Current.Name -ne $request.name) {throw 'PROVENANCE'}
    $composer=Find (Document) 'Edit' '询问 ChatGPT'
    if ($composer -and $composer.Current.IsEnabled -and -not (GptBusy)) {
     $final=Reply $request.prompt
     AssertConversation $request.conversationId
     if (-not (GptBusy)) {return $final}
    }
   }
   Respond @{ok=$true;body=$body;conversationId=(ConversationId);completionVerified=$true;identity=$script:identity};return
 }
} catch {
 $code=$_.Exception.Message
 if ($code -notin @('INPUT','OWNER','IO','TIMEOUT','CONFLICT','PROVENANCE','STATE')) {$code='EXECUTION'}
 Respond @{ok=$false;code=$code;stage=$script:stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;privateDiagnosticsOmitted=$true}
} finally {
 if ($locked) {$mutex.ReleaseMutex()}
 if ($mutex) {$mutex.Dispose()}
 $script:root=$null
}

}
while ($null -ne ($inputText=[Console]::In.ReadLine())) {RunRequest ($inputText | ConvertFrom-Json)}
