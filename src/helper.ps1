# Windows helper for agent-control-bridge, driven by src/helper.ts.
# One JSON request per stdin line, one JSON response per stdout line:
#   {"op":"pipe-owner","path":"\\.\pipe\..."} -> {"ok":true,"isApp":bool}
#   {"op":"foreground"}                        -> {"ok":true,"window":handle}
#   {"op":"give-back","window":handle}         -> {"ok":true,"taken":bool,"restored":bool}
#   {"op":"transcript","title":"..."}          -> {"ok":true,"found":bool,"busy":bool,"atEnd":bool,"nodes":[{"type","name","label"}]}
#     (found only in a window that shows on screen)
#     (the text between two buttons or role headings comes as one Text, with its line breaks)
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

# Whether a window shows on screen. Chromium stops updating the page of a window that is
# minimized, cloaked (another virtual desktop) or fully covered; this follows its occlusion
# rules: only visible, opaque, rectangular windows above it in z-order cover it.
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Acb {
  public static class Screen {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr window, IntPtr region);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] static extern int CombineRgn(IntPtr target, IntPtr first, IntPtr second, int mode);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
    const uint Above = 3;
    const int And = 1, Diff = 4, Empty = 1, Error = 0;

    public static bool Shows(IntPtr window) {
      Rect bounds;
      if (!Showing(window) || !Bounds(window, out bounds)) return false;
      IntPtr visible = CreateRectRgn(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
      int x = GetSystemMetrics(76), y = GetSystemMetrics(77);
      int left = Clip(visible, x, y, x + GetSystemMetrics(78), y + GetSystemMetrics(79), And);
      for (IntPtr other = GetWindow(window, Above); other != IntPtr.Zero && left != Empty && left != Error; other = GetWindow(other, Above)) {
        Rect cover;
        if (Covers(other) && Bounds(other, out cover)) left = Clip(visible, cover.Left, cover.Top, cover.Right, cover.Bottom, Diff);
      }
      DeleteObject(visible);
      return left != Empty && left != Error;
    }

    static int Clip(IntPtr visible, int left, int top, int right, int bottom, int mode) {
      IntPtr region = CreateRectRgn(left, top, right, bottom);
      int result = CombineRgn(visible, visible, region, mode);
      DeleteObject(region);
      return result;
    }

    static bool Showing(IntPtr window) {
      int cloaked;
      return IsWindowVisible(window) && !IsIconic(window) &&
        !(DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0);
    }

    static bool Covers(IntPtr window) {
      if (!Showing(window)) return false;
      int style = GetWindowLong(window, -20);
      // Click-through and tool windows, and layered windows that are not opaque, do not cover.
      if ((style & 0x20) != 0 || (style & 0x80) != 0) return false;
      if ((style & 0x80000) != 0) {
        uint key, flags;
        byte alpha;
        if (!GetLayeredWindowAttributes(window, out key, out alpha, out flags)) return false;
        if (((flags & 2) != 0 && alpha < 255) || (flags & 1) != 0) return false;
      }
      IntPtr shape = CreateRectRgn(0, 0, 0, 0);
      int shaped = GetWindowRgn(window, shape);
      DeleteObject(shape);
      return shaped == Error;
    }

    static bool Bounds(IntPtr window, out Rect rect) {
      return DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) == 0 &&
        rect.Right > rect.Left && rect.Bottom > rect.Top;
    }
  }
}
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
# The page comes as one cached batch of its raw tree: a reply being written has one element
# per word, and the tree tells where paragraphs, list items and code lines begin.
function Transcript($request) {
  $pages = @(foreach ($window in AppWindows) {
    $document = Find $window 'Document'
    if ($document -and $document.Current.Name -eq $request.title) { @{ Window = $window; Document = $document } }
  })
  if ($pages.Count -eq 0) { return @{ ok = $true; found = $false } }
  if ($pages.Count -gt 1) { Fail 'WINDOW' 'Several windows show a conversation with this title' }
  # The page of a window that does not show on screen may be out of date.
  if (-not [Acb.Screen]::Shows([IntPtr]$pages[0].Window.Current.NativeWindowHandle)) { return @{ ok = $true; found = $false } }
  $pages = @($pages[0].Document)
  $scope = Find $pages[0] 'Group' $Names.Conversation
  # The page holds only the messages near what it shows, so its last one is the conversation's
  # newest only while it is scrolled to the end. A conversation that fits has no ScrollPattern.
  $atEnd = [bool]$scope
  $scroll = $null
  if ($scope -and $scope.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll)) {
    $atEnd = -not $scroll.Current.VerticallyScrollable -or $scroll.Current.VerticalScrollPercent -ge 99
  }
  if (-not $scope) { $scope = $pages[0] }
  $cache = [Windows.Automation.CacheRequest]::new()
  foreach ($property in $Element::NameProperty, $Element::ControlTypeProperty, $Element::ClassNameProperty, $Element::IsControlElementProperty) {
    $cache.Add($property)
  }
  $cache.TreeScope = [Windows.Automation.TreeScope]::Subtree
  $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
  $active = $cache.Activate()
  try { $tree = $scope.GetUpdatedCache($cache) } finally { $active.Dispose() }
  $page = @{ nodes = [Collections.Generic.List[object]]::new(); text = [Text.StringBuilder]::new(); last = $null }
  Visit $page $tree @()
  EndText $page
  return @{ ok = $true; found = $true; busy = [bool](Find $pages[0] 'Button' $Names.Stop); atEnd = $atEnd; nodes = $page.nodes }
}

function Visit($page, $element, $path) {
  $cached = $element.Cached
  $type = $cached.ControlType
  $label = $type -eq [Windows.Automation.ControlType]::Text -and $cached.ClassName -match '(^| )sr-only( |$)'
  if ($label -or $type -eq [Windows.Automation.ControlType]::Button) {
    EndText $page
    if ($cached.Name) { $page.nodes.Add(@{ type = $type.ProgrammaticName.Substring(12); name = $cached.Name; label = $label }) }
    return
  }
  $children = $element.CachedChildren
  if ($type -eq [Windows.Automation.ControlType]::Text -and -not $children.Count) {
    if ($cached.Name) { AddText $page $path $cached.Name }
    return
  }
  $inside = @($path) + $element
  foreach ($child in $children) { Visit $page $child $inside }
}

# Adds a piece of text whose ancestors are `path`. Pieces of one block are joined as they are;
# a line break separates two pieces with a block between them and their common ancestor:
# anything but inline text (code, emphasis) and links. A list item's marker joins its first line.
# An empty code line is a block holding only a line break, which then needs no other.
function AddText($page, $path, [string]$text) {
  $last = $page.last
  if ($null -ne $last) {
    $shared = 0
    while ($shared -lt $path.Count -and $shared -lt $last.Count -and [object]::ReferenceEquals($path[$shared], $last[$shared])) { $shared++ }
    $block = $false
    foreach ($side in $last, $path) {
      for ($i = $shared; $i -lt $side.Count; $i++) { if (-not (IsInline $side[$i])) { $block = $true } }
    }
    $marker = $shared -eq $last.Count -and $shared -gt 0 -and $path[$shared - 1].Cached.ControlType -eq [Windows.Automation.ControlType]::ListItem
    $broken = $page.text.Length -and $page.text.Chars($page.text.Length - 1) -eq "`n"
    if ($block -and -not $marker -and -not $broken) { [void]$page.text.Append("`n") }
  }
  [void]$page.text.Append($text)
  $page.last = $path
}

function IsInline($element) {
  $cached = $element.Cached
  ($cached.ControlType -eq [Windows.Automation.ControlType]::Text -and -not $cached.IsControlElement) -or
    $cached.ControlType -eq [Windows.Automation.ControlType]::Hyperlink
}

# Ends the text being gathered: what follows is a button or a role heading.
function EndText($page) {
  if ($page.text.Length) { $page.nodes.Add(@{ type = 'Text'; name = $page.text.ToString(); label = $false }) }
  [void]$page.text.Clear()
  $page.last = $null
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
