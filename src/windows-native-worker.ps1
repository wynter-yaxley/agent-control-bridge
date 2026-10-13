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
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder text,int count);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SetText(IntPtr window,uint message,UIntPtr wparam,string text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr GetText(IntPtr window,uint message,UIntPtr count,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Click(IntPtr window,uint message,UIntPtr wparam,IntPtr lparam,uint flags,uint timeout,out UIntPtr result);
}
'@
[Console]::Error.WriteLine('ACB_UI_STAGE=worker-loaded')
$script:stage='input'
$mutex=$null
$locked=$false
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 $deadline=[DateTime]::UtcNow.AddMilliseconds($request.timeoutMs)
 $windows=@(Get-Process -Name ChatGPT | Where-Object {$_.MainWindowHandle -ne 0})
 if ($windows.Count -ne 1) {throw 'OWNER'}
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
 function Invoke($element) {([System.Windows.Automation.InvokePattern]$element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()}
 function Expand($element) {([System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()}
 function Value($element) {return ([System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value.Trim()}
 function SetValue($scope,[string]$name,[string]$id,[string]$text) {
  $edit=Wait {Find $scope 'Edit' $name $id}
  ([System.Windows.Automation.ValuePattern]$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($text)
  [void](Wait { $current=Find $scope 'Edit' $name $id; if ($current -and (Value $current) -eq $text) {$current} })
 }
 function Document {return Find $script:root 'Document' ''}
 function Snapshot {
  $doc=Document
  $text=([System.Windows.Automation.TextPattern]$doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)).DocumentRange.GetText(65537)
  if ($text.Length -gt 65536) {throw 'PROVENANCE'}
  return @{title=$doc.Current.Name;text=$text;ordinaryComposer=($null -ne (Find $doc 'Edit' '询问 ChatGPT'));pid=$window.Id}
 }
 function OpenChat([string]$title) {
  [Console]::Error.WriteLine('ACB_UI_STAGE=chat-open-check')
  if ((Document).Current.Name -eq $title) {return}
  $edits=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit))
  foreach ($edit in $edits) {if (-not $edit.Current.IsOffscreen) {$draft=Value $edit;if ($draft -and $draft -ne $edit.Current.Name) {throw 'CONFLICT'}}}
  $condition=[System.Windows.Automation.AndCondition]::new(
   [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$title),
   [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty,$true))
  $button=Wait {$script:root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)}
  Invoke $button
  [Console]::Error.WriteLine('ACB_UI_STAGE=chat-open-invoked')
  [void](Wait {if ((Document).Current.Name -eq $title) {$true}})
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
  for ($index=$start;$index -lt $nodes.Count;$index++) {
   $node=$nodes.Item($index)
   if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $node.Current.Name -eq '更多操作') {$finished=$true;break}
   if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) {$parts.Add($node.Current.Name)}
  }
  $body=($parts -join "`n").Trim()
  if (-not $finished -or -not $body) {return $null}
  if ($body.Length -gt 65536) {throw 'PROVENANCE'}
  return $body
 }
 if ($request.operation -in @('snapshot','gpt-read')) {
  $script:stage='current-gpt-view'
  $snapshot=Snapshot
  if ($snapshot.title -ne $request.name) {throw 'PROVENANCE'}
  if ($request.operation -eq 'gpt-read') {
   if (-not $snapshot.ordinaryComposer) {throw 'PROVENANCE'}
   $script:stage='gpt-read-correlate'
   $body=Reply $request.prompt
   if (-not $body) {throw 'PROVENANCE'}
   [Console]::Out.WriteLine((@{ok=$true;body=$body} | ConvertTo-Json -Depth 5 -Compress));exit 0
  }
  [Console]::Out.WriteLine((@{ok=$true;snapshot=$snapshot} | ConvertTo-Json -Depth 5 -Compress)); exit 0
 }
 if ($request.operation -notin @('workspace-create','gpt-create','codex-create','gpt-rename','chat-open','chat-send','chat-read-reply')) {throw 'INPUT'}
 $mutex=[Threading.Mutex]::new($false,'ACB_Desktop_Write_Lock')
 $locked=$mutex.WaitOne(0)
 if (-not $locked) {throw 'CONFLICT'}
 if ($request.operation -in @('chat-open','chat-send','chat-read-reply')) {
  $script:stage='chat-open'
  OpenChat $request.name
  if ($request.operation -eq 'chat-open') {
   [Console]::Out.WriteLine((@{ok=$true;snapshot=(Snapshot)} | ConvertTo-Json -Depth 5 -Compress));exit 0
  }
  if ($request.operation -eq 'chat-send') {
   $script:stage='chat-compose-find';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $composer=if ($request.mode -eq 'codex') {'使用 ChatGPT Work'} else {'询问 ChatGPT'}
   $edit=Wait {Find (Document) 'Edit' $composer}
   $draft=Value $edit
   if ($draft -and $draft -ne $edit.Current.Name -and $draft -ne $request.prompt) {throw 'CONFLICT'}
   $script:stage='chat-compose-set';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   if ($draft -ne $request.prompt) {SetValue (Document) $composer '' $request.prompt}
   $script:stage='chat-send-button';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   Invoke (Wait {Find (Document) 'Button' '发送'})
  }
  if ($request.mode -ne 'codex') {
   $script:stage='gpt-reply';[Console]::Error.WriteLine("ACB_UI_STAGE=$script:stage")
   $body=Wait {if ((Document).Current.Name -ne $request.name) {throw 'PROVENANCE'}; Reply $request.prompt}
   [Console]::Out.WriteLine((@{ok=$true;body=$body} | ConvertTo-Json -Depth 5 -Compress));exit 0
  }
  [Console]::Out.WriteLine('{"ok":true}');exit 0
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
  if ($request.operation -in @('gpt-create','codex-create')) {
   $script:stage='new-gpt'
   $edits=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit))
   foreach ($edit in $edits) {if (-not $edit.Current.IsOffscreen) {$draft=Value $edit;if ($draft -and $draft -ne $edit.Current.Name) {throw 'CONFLICT'}}}
   if ($request.operation -eq 'codex-create') {
    Invoke (Wait {Find $script:root 'Button' "在 $($request.projectName) 中开始新聊天"})
    $mode='工作';$composer='使用 ChatGPT Work'
   } else {
    $newChats=$script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'新聊天'))
    $new=@($newChats | Where-Object {$_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and -not $_.Current.IsOffscreen})
    if ($new.Count -ne 1) {throw 'PROVENANCE'}
    Invoke $new[0]
    $mode='聊天';$composer='询问 ChatGPT'
   }
   $chat=Wait {Find $script:root 'Button' $mode}
   $toggle=[System.Windows.Automation.TogglePattern]$chat.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
   if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {$toggle.Toggle()}
   [void](Wait {$current=Find $script:root 'Button' $mode;if (([System.Windows.Automation.TogglePattern]$current.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) {$true}})
   if ($request.operation -eq 'codex-create') {[void](Wait {Find $script:root 'Button' "更改项目：$($request.projectName)"})}
   SetValue $script:root $composer '' $request.prompt
   $script:stage='gpt-send-once'
   Invoke (Wait {Find $script:root 'Button' '发送'})
   [void](Wait {Find $script:root 'Text' $request.marker})
  } else {
   if ((Snapshot).title -ne $request.expectedTitle) {throw 'PROVENANCE'}
  }
  $script:stage='gpt-rename'
  Expand (Wait {Find $script:root 'Button' '更多'})
  Invoke (Wait {Find $script:root 'MenuItem' '重命名'})
  $rename=Wait {Find $script:root 'Window' '重命名聊天'}
  SetValue $rename '聊天标题' '' $request.name
  Invoke (Find $rename 'Button' '保存')
  [void](Wait {if ((Document).Current.Name -eq $request.name) {$true}})
 }
 [Console]::Out.WriteLine((@{ok=$true;operation=$request.operation;ordinaryModeObserved=($request.operation -eq 'gpt-create');physicalInput=$false;appActivated=$false} | ConvertTo-Json -Compress))
} catch {
 $code=$_.Exception.Message
 if ($code -notin @('INPUT','OWNER','IO','TIMEOUT','CONFLICT','PROVENANCE')) {$code='EXECUTION'}
 [Console]::Out.WriteLine((@{ok=$false;code=$code;stage=$script:stage;errorType=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;privateDiagnosticsOmitted=$true} | ConvertTo-Json -Compress))
} finally {
 if ($locked) {$mutex.ReleaseMutex()}
 if ($mutex) {$mutex.Dispose()}
}
