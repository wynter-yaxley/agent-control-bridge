# ChatGPT window helper for agent-control-bridge, driven by src/window.ts.
# One JSON request per stdin line, one JSON response per stdout line:
#   {"op":"transcript","title":"..."}  -> {"ok":true,"found":bool,"busy":bool,"nodes":[{"type","name"}]}
#   {"op":"compose","prompt":"..."}    -> {"ok":true}
#   failure                            -> {"ok":false,"code":"WINDOW|BUSY|UNAVAILABLE|INPUT","message":"..."}
# It uses UI Automation patterns only: no keystrokes, no mouse, no clipboard.
# Control names are those of the Simplified Chinese app.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Acb -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
'@

$Names = @{
  Conversation = '对话'
  Stop         = '停止'
  NewChat      = '新聊天'
  Composer     = '询问 ChatGPT'
  Send         = '发送'
  You          = @('你说：', '您说：')
  ModePrefix   = '切换模式，当前模式：'
  ChatGptMode  = 'ChatGPT'
}
$Element = [Windows.Automation.AutomationElement]
$Descendants = [Windows.Automation.TreeScope]::Descendants

function Fail([string]$code, [string]$message) { throw [InvalidOperationException]::new("$code`t$message") }

function Condition([string]$type, [string]$name) {
  $byType = [Windows.Automation.PropertyCondition]::new($Element::ControlTypeProperty, [Windows.Automation.ControlType]::$type)
  if (-not $name) { return $byType }
  return [Windows.Automation.AndCondition]::new($byType, [Windows.Automation.PropertyCondition]::new($Element::NameProperty, $name))
}

function Find($scope, [string]$type, [string]$name) { $scope.FindFirst($Descendants, (Condition $type $name)) }

function Visible($scope, [string]$type, [string]$name) {
  @($scope.FindAll($Descendants, (Condition $type $name)) | Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
}

function Invoke($element) { $element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }

function Until([int]$ms, [scriptblock]$probe) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  do {
    $value = & $probe
    if ($value) { return $value }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

# The app's top-level windows. A minimized window exposes no UI tree, so it is restored
# without being activated (SW_SHOWNOACTIVATE): the user's active window keeps the focus.
function AppWindows {
  $ids = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | ForEach-Object Id)
  if (-not $ids) { Fail 'UNAVAILABLE' 'The ChatGPT desktop app is not running' }
  $windows = @(foreach ($id in $ids) {
    $Element::RootElement.FindAll([Windows.Automation.TreeScope]::Children,
      [Windows.Automation.PropertyCondition]::new($Element::ProcessIdProperty, [int]$id))
  })
  foreach ($window in $windows) {
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ([Acb.Win32]::IsIconic($handle)) {
      [void][Acb.Win32]::ShowWindowAsync($handle, 4)
      $null = Until 3000 { -not [Acb.Win32]::IsIconic($handle) }
    }
  }
  return $windows
}

function ComposerText($composer) {
  $text = $composer.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1).Trim()
  # An empty composer reads as its placeholder.
  if ($text -eq $Names.Composer) { return '' }
  return $text
}

# Text and buttons of the conversation shown under `title`, in page order.
function Transcript($request) {
  $pages = @(foreach ($window in AppWindows) {
    $document = Find $window 'Document'
    if ($document -and $document.Current.Name -eq $request.title) { $document }
  })
  if ($pages.Count -eq 0) { return @{ ok = $true; found = $false } }
  if ($pages.Count -gt 1) { Fail 'WINDOW' 'Several windows show this conversation' }
  $scope = Find $pages[0] 'Group' $Names.Conversation
  if (-not $scope) { $scope = $pages[0] }
  $kinds = [Windows.Automation.OrCondition]::new((Condition 'Text'), (Condition 'Button'))
  $nodes = @(foreach ($node in $scope.FindAll($Descendants, $kinds)) {
    $current = $node.Current
    if ($current.Name) { @{ type = $current.ControlType.ProgrammaticName.Substring(12); name = $current.Name } }
  })
  return @{ ok = $true; found = $true; busy = [bool](Find $pages[0] 'Button' $Names.Stop); nodes = $nodes }
}

# Starts a ChatGPT conversation: the new-chat button of the ChatGPT-mode window, the prompt
# written through ValuePattern and read back, then the send button.
function Compose($request) {
  # Showing a ChatGPT conversation puts the window in ChatGPT mode once the page updates.
  $windows = Until 5000 {
    $found = @(AppWindows | Where-Object {
      $mode = Find $_ 'Button' ($Names.ModePrefix + $Names.ChatGptMode)
      $mode -and -not $mode.Current.IsOffscreen
    })
    if ($found.Count -eq 1) { , $found }
  }
  if (-not $windows) { Fail 'WINDOW' 'No single ChatGPT window in ChatGPT mode; the app does not update a fully covered window, so keep part of it visible' }
  $window = $windows[0]
  $newChat = @(Visible $window 'Button' $Names.NewChat)
  if ($newChat.Count -ne 1) { Fail 'WINDOW' 'The new-chat button was not found' }
  Invoke $newChat[0]
  $composer = Until 10000 {
    $document = Find $window 'Document'
    if (-not $document) { return $null }
    $spoken = @($Names.You | Where-Object { Find $document 'Text' $_ })
    $edits = @(Visible $document 'Edit' $Names.Composer)
    if ($spoken.Count -eq 0 -and $edits.Count -eq 1) { $edits[0] }
  }
  if (-not $composer) { Fail 'WINDOW' 'The new chat page did not open' }
  if (ComposerText $composer) { Fail 'BUSY' 'The new chat page holds a draft' }
  $composer.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($request.prompt)
  $expected = ($request.prompt -replace "`r`n", "`n").Trim()
  if (-not (Until 5000 { ((ComposerText $composer) -replace "`r`n", "`n") -ceq $expected })) {
    $composer.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('')
    Fail 'WINDOW' 'The prompt could not be written into the composer'
  }
  $send = Until 5000 { @(Visible $window 'Button' $Names.Send) | Select-Object -First 1 }
  if (-not $send) { Fail 'WINDOW' 'The send button did not become available' }
  Invoke $send
  return @{ ok = $true }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    $response = switch ($request.op) {
      'transcript' { Transcript $request }
      'compose' { Compose $request }
      default { Fail 'INPUT' "Unknown operation: $($request.op)" }
    }
  } catch {
    $code, $message = $_.Exception.Message -split "`t", 2
    if (-not $message) { $code, $message = 'WINDOW', $_.Exception.Message }
    $response = @{ ok = $false; code = $code; message = $message }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 4 -Compress))
}
