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

 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SetText(IntPtr window,uint message,UIntPtr wparam,string text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr GetText(IntPtr window,uint message,UIntPtr count,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Click(IntPtr window,uint message,UIntPtr wparam,IntPtr lparam,uint flags,uint timeout,out UIntPtr result);
}
'@
[Console]::Error.WriteLine('ACB_UI_STAGE=worker-loaded')
$initMs=$initClock.ElapsedMilliseconds
# Read-only UIA survey of ChatGPT's own top-level windows. It records control
# types, classes, depth and pattern names only; never names, values or text.
function Survey($walker,$root) {
 $queue=[System.Collections.Generic.Queue[object]]::new()
 $queue.Enqueue(@($root,0))
 $types=@{};$documents=@();$visited=0;$maxDepth=0;$truncated=$false
 while ($queue.Count -gt 0) {
  if ($visited -ge 400) {$truncated=$true;break}
  $item=$queue.Dequeue();$element=$item[0];$depth=[int]$item[1];$visited++
  if ($depth -gt $maxDepth) {$maxDepth=$depth}
  try {$type=$element.Current.ControlType.ProgrammaticName -replace '^ControlType\.',''} catch {$type='Unavailable'}
  $types[$type]=1+[int]$types[$type]
  if ($type -eq 'Document' -and $documents.Count -lt 5) {
   $patterns=@(try {$element.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName}} catch {})
   $documents+=@{depth=$depth;className=$element.Current.ClassName;frameworkId=$element.Current.FrameworkId;offscreen=$element.Current.IsOffscreen;patterns=$patterns}
  }
  if ($depth -ge 12) {continue}
  try {$child=$walker.GetFirstChild($element)} catch {$child=$null}
  while ($null -ne $child) {
   $queue.Enqueue(@($child,($depth+1)))
   try {$child=$walker.GetNextSibling($child)} catch {$child=$null}
  }
 }
 return @{visited=$visited;maxDepth=$maxDepth;truncated=$truncated;controlTypes=$types;documents=$documents}
}
function Diagnose {
 $processes=@(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue)
 $ids=@($processes | ForEach-Object {$_.Id})
 $handles=@($processes | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object {[int64]$_.MainWindowHandle})
 $result=@{ok=$true;operation='uia-diagnose';interactiveDesktop=[AcbFolderControls]::Interactive();processCount=$processes.Count;mainWindowCount=$handles.Count;windows=@();privateTextOmitted=$true}
 $top=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
 foreach ($window in $top) {
  if ($result.windows.Count -ge 8) {break}
  try {$processId=$window.Current.ProcessId} catch {continue}
  if ($ids -notcontains $processId) {continue}
  $result.windows+=@{className=$window.Current.ClassName;frameworkId=$window.Current.FrameworkId;offscreen=$window.Current.IsOffscreen;
   mainWindow=($handles -contains [int64]$window.Current.NativeWindowHandle);nameLength=$window.Current.Name.Length;
   raw=(Survey ([System.Windows.Automation.TreeWalker]::RawViewWalker) $window);control=(Survey ([System.Windows.Automation.TreeWalker]::ControlViewWalker) $window)}
 }
 return $result
}
function RunRequest($request) {
$actionClock=[Diagnostics.Stopwatch]::StartNew()
function Respond($result) {$result.timings=@{initMs=$initMs;actionMs=$actionClock.ElapsedMilliseconds};[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 9 -Compress))}
$script:stage='input'
$mutex=$null
$locked=$false
try {
 if ($request.operation -eq 'uia-diagnose') {$script:stage='uia-diagnose';Respond (Diagnose);return}
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
 function Invoke($element) {if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'};([System.Windows.Automation.InvokePattern]$element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()}
 function Expand($element) {([System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()}
 function Value($element) {return ([System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value.Trim()}
 function SetValue($scope,[string]$name,[string]$id,[string]$text) {
  if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'}
  $edit=Wait {Find $scope 'Edit' $name $id}
  ([System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($text)
  [void](Wait { $current=Find $scope 'Edit' $name $id; if ($current -and (Value $current) -eq $text) {$current} })
 }
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
 function AssertConversation([string]$id) {
  $script:stage='conversation-identity'
  if (-not $id -or (ConversationId) -ne $id) {throw 'PROVENANCE'}
 }
 function Snapshot {
  $doc=Document
  $text=([System.Windows.Automation.TextPattern]$doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)).DocumentRange.GetText(65537)
  if ($text.Length -gt 65536) {throw 'PROVENANCE'}
  return @{title=$doc.Current.Name;text=$text;ordinaryComposer=($null -ne (Find $doc 'Edit' '询问 ChatGPT'));pid=$window.Id;conversationId=(ConversationId)}
 }
 function OpenChat([string]$title) {
  # No title-only navigation: the current public UI identity must already match.
  AssertConversation $request.conversationId
  if ((Document).Current.Name -ne $title) {throw 'PROVENANCE'}
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
 if ($request.operation -eq 'identity') {
  $script:stage='gpt-document'
  $doc=Document
  # Chromium can build its accessibility tree only after a client asks; retry briefly, read-only.
  $until=[DateTime]::UtcNow.AddMilliseconds([Math]::Min(3000,[int]$request.timeoutMs))
  while (-not $doc -and [DateTime]::UtcNow -lt $until) {Start-Sleep -Milliseconds $request.pollMs;$doc=Document}
  if (-not $doc) {throw 'OWNER'}
  Respond @{ok=$true;snapshot=@{title=$doc.Current.Name;text='';conversationId=$null;ordinaryComposer=($null -ne (Find $doc 'Edit' '询问 ChatGPT'));pid=$window.Id}};return
 }
 if ($request.operation -in @('snapshot','gpt-read')) {
  $script:stage='current-gpt-view'
  $snapshot=Snapshot
  if ($request.name -and $snapshot.title -ne $request.name) {throw 'PROVENANCE'}
  if ($request.conversationId -or $request.operation -eq 'gpt-read') {AssertConversation $request.conversationId}
  if ($request.operation -eq 'gpt-read') {
   if (-not $snapshot.ordinaryComposer) {throw 'PROVENANCE'}
   $script:stage='gpt-read-correlate'
   $body=Reply $request.prompt
   if (-not $body) {throw 'PROVENANCE'}
   Respond @{ok=$true;body=$body;conversationId=(ConversationId)};return
  }
  Respond @{ok=$true;snapshot=$snapshot};return
 }
 if ($request.operation -notin @('workspace-create','gpt-create','gpt-rename','chat-open','chat-send','chat-read-reply')) {throw 'INPUT'}
 $mutex=[Threading.Mutex]::new($false,'ACB_Desktop_Write_Lock')
 $locked=$mutex.WaitOne(0)
 if (-not $locked) {throw 'CONFLICT'}
 if ($request.mode -eq 'codex' -and $request.operation -eq 'chat-send') {throw 'PROVENANCE'}
 if ($request.operation -in @('chat-open','chat-send','chat-read-reply')) {
  $script:stage='chat-open'
  OpenChat $request.name
  if ($request.operation -eq 'chat-open') {
   Respond @{ok=$true;snapshot=(Snapshot)};return
  }
  if ($request.operation -eq 'chat-send') {
   $script:stage='chat-compose-find';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $composer=if ($request.mode -eq 'codex') {'使用 ChatGPT Work'} else {'询问 ChatGPT'}
   $edit=Wait {Find (Document) 'Edit' $composer}
   $draft=Value $edit
   if ($draft -and $draft -ne $edit.Current.Name -and $draft -ne $request.prompt) {throw 'CONFLICT'}
   $script:stage='chat-compose-set';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   AssertConversation $request.conversationId
   if ($draft -ne $request.prompt) {SetValue (Document) $composer '' $request.prompt}
   $script:stage='chat-send-button';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $send=Wait {Find (Document) 'Button' '发送'}
   AssertConversation $request.conversationId
   Invoke $send
   Respond @{ok=$true;conversationId=(ConversationId)};return
  }
  if ($request.mode -ne 'codex') {
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
   Respond @{ok=$true;body=$body;conversationId=(ConversationId);completionVerified=$true};return
  }
  Respond @{ok=$true};return
 }
 if ($request.operation -eq 'workspace-create') {
  $script:stage='workspace-dialog'
  Invoke (Wait {Find $script:root 'Button' '添加新项目'})
  $dialog=Wait {Find $script:root 'Window' '创建项目'}
  SetValue $dialog '' 'chatgpt-project-name' $request.name
  Invoke (Find $dialog 'Button' '添加')
  $script:stage='folder-picker'
  $picker=Wait {Find $script:root 'Window' 'Select Project Root'}
  $pickerHandle=[IntPtr]$picker.Current.NativeWindowHandle
  $folderEdits=$picker.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1152'))
  $folderEdit=@($folderEdits | Where-Object {$_.Current.ClassName -eq 'Edit' -and $_.Current.NativeWindowHandle -ne 0})[0]
  $editHandle=[IntPtr]$folderEdit.Current.NativeWindowHandle
  $result=[UIntPtr]::Zero
  if ([AcbFolderControls]::SetText($editHandle,12,[UIntPtr]::Zero,$request.path,2,$request.timeoutMs,[ref]$result) -eq [IntPtr]::Zero -or $result -eq [UIntPtr]::Zero) {throw 'IO'}
  $buffer=[Text.StringBuilder]::new(4096)
  if ([AcbFolderControls]::GetText($editHandle,13,[UIntPtr]4096,$buffer,2,$request.timeoutMs,[ref]$result) -eq [IntPtr]::Zero -or $buffer.ToString() -ne $request.path) {throw 'PROVENANCE'}
  $button=[AcbFolderControls]::GetDlgItem($pickerHandle,1)
  $class=[Text.StringBuilder]::new(256);$label=[Text.StringBuilder]::new(256)
  [void][AcbFolderControls]::GetClassName($button,$class,256);[void][AcbFolderControls]::GetWindowText($button,$label,256)
  if ($class.ToString() -ne 'Button' -or $label.ToString() -ne '选择文件夹') {throw 'PROVENANCE'}
  if ([AcbFolderControls]::Click($button,245,[UIntPtr]::Zero,[IntPtr]::Zero,2,$request.timeoutMs,[ref]$result) -eq [IntPtr]::Zero) {throw 'IO'}
  [void](Wait {if (-not (Find $script:root 'Window' 'Select Project Root')) {$true}})
  Invoke (Find $dialog 'Button' '创建项目')
  $script:stage='folder-consent'
  $trust=Wait {Find $script:root 'Window' '信任此文件夹吗？'}
  $folders=$trust.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::ListItem))
  if ($folders.Count -ne 1 -or $folders.Item(0).Current.Name -ne $request.path) {throw 'PROVENANCE'}
  Invoke (Find $trust 'Button' '信任文件夹')
  [void](Wait {if (-not (Find $script:root 'Window' '信任此文件夹吗？')) {$true}})
 } else {
  if ($request.operation -eq 'gpt-create') {
   $script:stage='new-gpt'
   $initialConversationId=ConversationId
   $edits=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit))
   foreach ($edit in $edits) {if (-not $edit.Current.IsOffscreen) {$draft=Value $edit;if ($draft -and $draft -ne $edit.Current.Name) {throw 'CONFLICT'}}}
    $newChats=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'新聊天'))
    $new=@($newChats | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and -not $_.Current.IsOffscreen})
    if ($new.Count -ne 1) {throw 'PROVENANCE'}
    Invoke $new[0]
    $mode='聊天';$composer='询问 ChatGPT'
   $chat=Wait {Find $script:root 'Button' $mode}
   $toggle=[System.Windows.Automation.TogglePattern]$chat.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
   if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {if (-not [AcbFolderControls]::Interactive()) {throw 'OWNER'};$toggle.Toggle()}
   [void](Wait {$current=Find $script:root 'Button' $mode;if (([System.Windows.Automation.TogglePattern]$current.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) {$true}})
    function AssertNewBlank {
     $doc=Document
     $edit=Find $doc 'Edit' '询问 ChatGPT'
     if ($doc.Current.Name -notin @('ChatGPT','新聊天') -or -not $edit -or (GptBusy) -or (Find $doc 'Text' '您说：') -or (Find $doc 'Text' 'ChatGPT 说：') -or (Find $doc 'Button' '复制消息')) {throw 'PROVENANCE'}
     $draft=Value $edit
     if ($draft -and $draft -ne $edit.Current.Name -and $draft -ne $request.prompt) {throw 'CONFLICT'}
     if ($initialConversationId -and (ConversationId) -eq $initialConversationId) {throw 'PROVENANCE'}
    }
    if ($request.marker -notmatch '^ACB_INIT_[a-f0-9-]{36}$' -or $request.prompt -ne "这是 Agent Control Bridge 的会话身份初始化，不执行工程任务。请只回复：$($request.marker)。") {throw 'PROVENANCE'}
    AssertNewBlank
   SetValue $script:root $composer '' $request.prompt
   $send=Wait {Find $script:root 'Button' '发送'}
   AssertNewBlank
   $script:stage='gpt-send-once'
   Invoke $send
   [void](Wait {Find $script:root 'Text' $request.marker})
  } else {
   AssertConversation $request.conversationId
   if ((Snapshot).title -ne $request.expectedTitle) {throw 'PROVENANCE'}
  }
  if ($request.operation -eq 'gpt-create') {
   $view=Snapshot
   if (-not $view.ordinaryComposer -or -not $view.text.Contains($request.marker) -or -not $view.text.Contains($request.prompt)) {throw 'PROVENANCE'}
  }
  $script:stage='gpt-rename'
  Expand (Wait {Find $script:root 'Button' '更多'})
  Invoke (Wait {Find $script:root 'MenuItem' '重命名'})
  $rename=Wait {Find $script:root 'Window' '重命名聊天'}
  SetValue $rename '聊天标题' '' $request.name
  Invoke (Find $rename 'Button' '保存')
  [void](Wait {if ((Document).Current.Name -eq $request.name) {$true}})
 }
 if ($request.operation -eq 'gpt-rename') {AssertConversation $request.conversationId}
 Respond @{ok=$true;conversationId=(ConversationId);operation=$request.operation;ordinaryModeObserved=($request.operation -eq 'gpt-create');physicalInput=$false;appActivated=$false}
} catch {
 $code=$_.Exception.Message
 if ($code -notin @('INPUT','OWNER','IO','TIMEOUT','CONFLICT','PROVENANCE')) {$code='EXECUTION'}
 Respond @{ok=$false;code=$code;stage=$script:stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;privateDiagnosticsOmitted=$true}
} finally {
 if ($locked) {$mutex.ReleaseMutex()}
 if ($mutex) {$mutex.Dispose()}
 $script:root=$null
}

}
while ($null -ne ($inputText=[Console]::In.ReadLine())) {RunRequest ($inputText | ConvertFrom-Json)}
