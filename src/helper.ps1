# Windows helper for agent-control-bridge, driven by src/helper.ts.
# One JSON request per stdin line, one JSON response per stdout line:
#   {"op":"pipe-owner","path":"\\.\pipe\..."} -> {"ok":true,"isApp":bool}
#   {"op":"foreground"}                        -> {"ok":true,"window":handle}
#   {"op":"give-back","window":handle}         -> {"ok":true,"taken":bool,"restored":bool}
#   {"op":"transcript","title":"..."}          -> {"ok":true,"found":bool,"busy":bool,"nodes":[{"type","name","label"}]}
#   {"op":"compose","prompt":"..."}            -> {"ok":true}
#   failure                                    -> {"ok":false,"code":"WINDOW|BUSY|UNAVAILABLE|INPUT","message":"..."}
# The ChatGPT window is used through UI Automation patterns only: no keystrokes, no mouse,
# no clipboard. Control names are those of the Simplified Chinese app.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Acb -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint processId);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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

# Whether the server of a tool pipe is the ChatGPT desktop app: signed by OpenAI and running
# in this Windows session as this user.
# A pipe that vanished, did not answer or whose server exited is not the app.
function PipeOwner($request) {
  try { return @{ ok = $true; isApp = (IsAppPipe $request.path) } } catch { return @{ ok = $true; isApp = $false } }
}

function IsAppPipe([string]$path) {
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', ($path -replace '^\\\\\.\\pipe\\', ''), [IO.Pipes.PipeDirection]::InOut)
  [uint32]$id = 0
  try {
    $pipe.Connect(2000)
    if (-not [Acb.Win32]::GetNamedPipeServerProcessId($pipe.SafePipeHandle, [ref]$id)) { return $false }
  } finally {
    $pipe.Dispose()
  }
  $server = Get-Process -Id $id
  $signature = Get-AuthenticodeSignature -LiteralPath $server.Path
  $owner = Invoke-CimMethod -InputObject (Get-CimInstance Win32_Process -Filter "ProcessId=$id") -MethodName GetOwnerSid
  return [bool]($server.SessionId -eq (Get-Process -Id $PID).SessionId -and
    $owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and
    $signature.Status -eq 'Valid' -and
    $signature.SignerCertificate.Subject -match '(^|, )O=("OpenAI OpCo, LLC"|OpenAI)(,|$)')
}

function Foreground { return @{ ok = $true; window = [Acb.Win32]::GetForegroundWindow().ToInt64() } }

# Switching pages or opening a new chat can make the app take the foreground. Give it back
# to `window`, which had it before, but only when it is the app that has it now: a window
# the user switched to meanwhile is left alone. Attaching to the input of the thread that
# holds the foreground lets this helper set it without any synthetic input.
function GiveBack($request) {
  $target = [IntPtr][long]$request.window
  if ($target -eq [IntPtr]::Zero -or -not [Acb.Win32]::IsWindow($target)) { return @{ ok = $true; taken = $false; restored = $false } }
  $app = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | ForEach-Object Id)
  $taken = Until 300 {
    $current = [Acb.Win32]::GetForegroundWindow()
    [uint32]$owner = 0
    $thread = [Acb.Win32]::GetWindowThreadProcessId($current, [ref]$owner)
    if ($current -ne $target -and $app -contains [int]$owner) { $thread }
  }
  if (-not $taken) { return @{ ok = $true; taken = $false; restored = $false } }
  $self = [Acb.Win32]::GetCurrentThreadId()
  [void][Acb.Win32]::AttachThreadInput($self, $taken, $true)
  try { [void][Acb.Win32]::SetForegroundWindow($target) } finally { [void][Acb.Win32]::AttachThreadInput($self, $taken, $false) }
  return @{ ok = $true; taken = $true; restored = ([Acb.Win32]::GetForegroundWindow() -eq $target) }
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
  $text = $composer.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1)
  $text = ($text -replace "`r`n", "`n").Trim()
  # An empty composer reads as its placeholder.
  if ($text -eq $Names.Composer) { return '' }
  return $text
}

# Text and buttons of the conversation shown under `title`, in page order. The role headings
# before each message are screen-reader-only (`sr-only`), which tells them from message text.
function Transcript($request) {
  $pages = @(foreach ($window in AppWindows) {
    $document = Find $window 'Document'
    if ($document -and $document.Current.Name -eq $request.title) { $document }
  })
  if ($pages.Count -eq 0) { return @{ ok = $true; found = $false } }
  if ($pages.Count -gt 1) { Fail 'WINDOW' 'Several windows show a conversation with this title' }
  $scope = Find $pages[0] 'Group' $Names.Conversation
  if (-not $scope) { $scope = $pages[0] }
  $kinds = [Windows.Automation.OrCondition]::new((Condition 'Text'), (Condition 'Button'))
  $nodes = @(foreach ($node in $scope.FindAll($Descendants, $kinds)) {
    $current = $node.Current
    if ($current.Name) {
      @{ type = $current.ControlType.ProgrammaticName.Substring(12); name = $current.Name; label = $current.ClassName -match '(^| )sr-only( |$)' }
    }
  })
  return @{ ok = $true; found = $true; busy = [bool](Find $pages[0] 'Button' $Names.Stop); nodes = $nodes }
}

# A new, empty chat page of `window`: no message on it and exactly one usable composer.
function BlankPage($window) {
  $document = Find $window 'Document'
  if (-not $document) { return $null }
  if (@($Names.You | Where-Object { Find $document 'Text' $_ }).Count) { return $null }
  $composers = @(Visible $document 'Edit' $Names.Composer)
  if ($composers.Count -ne 1) { return $null }
  return @{ Document = $document; Composer = $composers[0] }
}

# Starts a ChatGPT conversation: the new-chat button of the ChatGPT-mode window, the prompt
# written through ValuePattern and read back, then the page's single send button. Whatever is
# in the composer when something does not match is left for the user to see.
function Compose($request) {
  $expected = ($request.prompt -replace "`r`n", "`n").Trim()
  # Showing a ChatGPT conversation puts the window in ChatGPT mode once the page updates.
  $window = Until 5000 {
    $found = @(AppWindows | Where-Object {
      $mode = Find $_ 'Button' ($Names.ModePrefix + $Names.ChatGptMode)
      $mode -and -not $mode.Current.IsOffscreen
    })
    if ($found.Count -eq 1) { $found[0] }
  }
  if (-not $window) { Fail 'WINDOW' 'No single ChatGPT window in ChatGPT mode; the app does not update a fully covered window, so keep part of it visible' }
  $newChat = @(Visible $window 'Button' $Names.NewChat)
  if ($newChat.Count -ne 1) { Fail 'WINDOW' 'The new-chat button was not found' }
  Invoke $newChat[0]
  $page = Until 10000 { BlankPage $window }
  if (-not $page) { Fail 'WINDOW' 'The new chat page did not open' }
  if (ComposerText $page.Composer) { Fail 'BUSY' 'The new chat page holds a draft' }
  $page.Composer.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($request.prompt)
  if (-not (Until 5000 { (ComposerText $page.Composer) -ceq $expected })) {
    Fail 'WINDOW' 'The composer does not hold exactly the prompt; nothing was sent'
  }
  $send = Until 5000 { $buttons = @(Visible $page.Document 'Button' $Names.Send); if ($buttons.Count -eq 1) { $buttons[0] } }
  if (-not $send) { Fail 'WINDOW' 'No single send button on the new chat page; nothing was sent' }
  # The window is active now and the user may type: check once more right before sending.
  if (-not (BlankPage $window) -or (ComposerText $page.Composer) -cne $expected) {
    Fail 'WINDOW' 'The new chat page changed before sending; nothing was sent'
  }
  Invoke $send
  return @{ ok = $true }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    $response = switch ($request.op) {
      'pipe-owner' { PipeOwner $request }
      'foreground' { Foreground }
      'give-back' { GiveBack $request }
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
