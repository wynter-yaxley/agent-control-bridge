# Windows helper for agent-control-bridge, driven by src/helper.ts.
# One JSON request per stdin line, one JSON response per stdout line:
#   {"op":"pipe-owner","path":"\\.\pipe\..."} -> {"ok":true,"isApp":bool}
#   {"op":"foreground"}                        -> {"ok":true,"window":handle}
#   {"op":"give-back","window":handle}         -> {"ok":true,"taken":bool,"restored":bool}
#   {"op":"transcript","title":"..."}          -> {"ok":true,"found":bool,"busy":bool,"older":bool,"framed":bool,
#                                                  "scroll":{"percent","view"}|null,"nodes":[{"type","name","label"}]}
#     (found only in a window that shows on screen)
#     (the text between two buttons or role headings comes as one Text, with its line breaks)
#     (a role heading carries "id", the UI Automation runtime ID of its message)
#   {"op":"compose","prompt":"..."}            -> {"ok":true}
#   {"op":"launch"}                            -> {"ok":true,"started":bool}
#   {"op":"raise"}                             -> {"ok":true,"raised":[{"window","after"}]}
#   {"op":"lower","raised":[...]}              -> {"ok":true}
#   {"op":"scroll","title":"...","percent":n}  -> {"ok":true,"found":bool}
#   {"op":"reveal","title":"...","ids":["..."],"pages":n} -> {"ok":true,"found":bool}
#   {"op":"approval","title":"..."}           -> {"ok":true,"found":bool,"card":{"text","buttons":[{"name","className","usable"}]}|null}
#   {"op":"press","title":"...","text":"...","name":"..."} -> {"ok":true}
#   failure                                    -> {"ok":false,"code":"WINDOW|BUSY|UNAVAILABLE|INPUT|NO_APPROVAL","message":"..."}
# The ChatGPT window is used through UI Automation patterns only: no keystrokes, no mouse,
# no clipboard. Control names are those of the Simplified Chinese app.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# Native helpers, compiled once: Win32 calls, whether a window shows on screen, and the
# reader of a page's UI tree (PowerShell takes far longer to walk one).
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
namespace Acb {
  public static class Win32 {
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
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // The SID of the user that runs process `id`, from its token; null when it cannot be read.
    public static string Owner(int id) {
      IntPtr process = OpenProcess(0x1000, false, id);
      if (process == IntPtr.Zero) return null;
      try {
        IntPtr token;
        if (!OpenProcessToken(process, 0x0008, out token)) return null;
        try {
          using (var identity = new System.Security.Principal.WindowsIdentity(token)) return identity.User.Value;
        } finally {
          CloseHandle(token);
        }
      } finally {
        CloseHandle(process);
      }
    }
  }

  // Whether a window shows on screen. Chromium stops updating the page of a window that is
  // minimized, cloaked (another virtual desktop) or fully covered; this follows its occlusion
  // rules: only visible, opaque, rectangular windows above it in z-order cover it.
  public static class Screen {
    delegate bool EachWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EachWindow each, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
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

    // The visible top-level windows of the processes `ids`: the ones UI Automation lists as
    // children of the desktop, found without walking its tree, which takes far longer.
    public static IntPtr[] Windows(int[] ids) {
      var processes = new HashSet<int>(ids);
      var found = new List<IntPtr>();
      EnumWindows((window, data) => {
        uint owner;
        Win32.GetWindowThreadProcessId(window, out owner);
        if (processes.Contains((int)owner) && IsWindowVisible(window)) found.Add(window);
        return true;
      }, IntPtr.Zero);
      return found.ToArray();
    }

    public static bool Shows(IntPtr window) {
      Rect bounds;
      if (!Showing(window) || !Bounds(window, out bounds)) return false;
      IntPtr visible = CreateRectRgn(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
      int x = GetSystemMetrics(76), y = GetSystemMetrics(77);
      int left = Clip(visible, x, y, x + GetSystemMetrics(78), y + GetSystemMetrics(79), And);
      for (IntPtr other = Win32.GetWindow(window, Above); other != IntPtr.Zero && left != Empty && left != Error; other = Win32.GetWindow(other, Above)) {
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
      return IsWindowVisible(window) && !Win32.IsIconic(window) &&
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

  // The text and buttons of a page's cached raw tree, in page order (see Transcript).
  public class Page {
    readonly List<Hashtable> nodes = new List<Hashtable>();
    readonly StringBuilder text = new StringBuilder();
    readonly List<AutomationElement> path = new List<AutomationElement>();
    AutomationElement[] last;

    public static List<Hashtable> Read(AutomationElement root) {
      var page = new Page();
      page.Visit(root);
      page.EndText();
      return page.nodes;
    }

    // The approval card in a page's cached raw tree, or null: its text and its buttons, those
    // that carry the card's class marker. The card is the nearest element above its first
    // button that holds text besides buttons.
    public static Hashtable Card(AutomationElement root) {
      var card = CardOf(root);
      if (card == null) return null;
      var buttons = new List<Hashtable>();
      foreach (var button in CardButtons(card)) {
        var cached = button.Cached;
        buttons.Add(new Hashtable { { "name", cached.Name }, { "className", cached.ClassName }, { "usable", Usable(button) } });
      }
      return new Hashtable { { "text", CardText(card) }, { "buttons", buttons } };
    }

    // The one usable button `name` of the approval card under `root`, taken from the card
    // itself and only while it reads `text`; null otherwise.
    public static AutomationElement CardButton(AutomationElement root, string text, string name) {
      var card = CardOf(root);
      if (card == null || CardText(card) != text) return null;
      AutomationElement found = null;
      foreach (var button in CardButtons(card)) {
        if (button.Cached.Name != name || !Usable(button)) continue;
        if (found != null) return null;
        found = button;
      }
      return found;
    }

    static AutomationElement CardOf(AutomationElement root) {
      var path = new List<AutomationElement>();
      if (!PathTo(root, path)) return null;
      int at = path.Count - 2;
      while (at >= 0 && !HasText(path[at])) at--;
      return at < 0 ? null : path[at];
    }

    static string CardText(AutomationElement card) {
      var text = new List<string>();
      foreach (var node in Read(card)) if ((string)node["type"] == "Text") text.Add((string)node["name"]);
      return string.Join("\n", text);
    }

    static bool Usable(AutomationElement button) {
      return button.Cached.IsEnabled && !button.Cached.IsOffscreen;
    }

    static bool IsCardButton(AutomationElement element) {
      var cached = element.Cached;
      return cached.ControlType == ControlType.Button && (cached.ClassName ?? "").Contains("approval-card");
    }

    // `path` from `element` down to the first card button below it.
    static bool PathTo(AutomationElement element, List<AutomationElement> path) {
      path.Add(element);
      if (IsCardButton(element)) return true;
      var children = element.CachedChildren;
      if (children != null) foreach (AutomationElement child in children) if (PathTo(child, path)) return true;
      path.RemoveAt(path.Count - 1);
      return false;
    }

    static List<AutomationElement> CardButtons(AutomationElement element) {
      var found = new List<AutomationElement>();
      if (IsCardButton(element)) found.Add(element);
      var children = element.CachedChildren;
      if (children != null) foreach (AutomationElement child in children) found.AddRange(CardButtons(child));
      return found;
    }

    static bool HasText(AutomationElement element) {
      var cached = element.Cached;
      if (cached.ControlType == ControlType.Button) return false;
      if (cached.ControlType == ControlType.Text && !string.IsNullOrEmpty(cached.Name)) return true;
      var children = element.CachedChildren;
      if (children != null) foreach (AutomationElement child in children) if (HasText(child)) return true;
      return false;
    }

    void Visit(AutomationElement element) {
      var cached = element.Cached;
      var type = cached.ControlType;
      bool label = type == ControlType.Text && (" " + cached.ClassName + " ").Contains(" sr-only ");
      if (label || type == ControlType.Button) {
        EndText();
        if (!string.IsNullOrEmpty(cached.Name)) {
          var node = new Hashtable { { "type", type.ProgrammaticName.Substring(12) }, { "name", cached.Name }, { "label", label } };
          // A heading keeps its runtime ID while its message stays on the page, also as it scrolls.
          var id = element.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty) as int[];
          if (label && id != null) node["id"] = string.Join(".", id);
          nodes.Add(node);
        }
        return;
      }
      var children = element.CachedChildren;
      if (type == ControlType.Text && (children == null || children.Count == 0)) {
        if (!string.IsNullOrEmpty(cached.Name)) AddText(cached.Name);
        return;
      }
      if (children == null) return;
      path.Add(element);
      foreach (AutomationElement child in children) Visit(child);
      path.RemoveAt(path.Count - 1);
    }

    // Adds a piece of text whose ancestors are `path`. Pieces of one block are joined as they
    // are; a line break separates two pieces with a block between them and their common
    // ancestor: anything but inline text (code, emphasis) and links. A list item's marker joins
    // its first line. An empty code line is a block holding only a line break, which then needs
    // no other.
    void AddText(string piece) {
      if (last != null) {
        int shared = 0;
        while (shared < path.Count && shared < last.Length && ReferenceEquals(path[shared], last[shared])) shared++;
        bool block = false;
        for (int i = shared; i < last.Length; i++) if (!IsInline(last[i])) block = true;
        for (int i = shared; i < path.Count; i++) if (!IsInline(path[i])) block = true;
        bool marker = shared == last.Length && shared > 0 && path[shared - 1].Cached.ControlType == ControlType.ListItem;
        bool broken = text.Length > 0 && text[text.Length - 1] == '\n';
        if (block && !marker && !broken) text.Append('\n');
      }
      text.Append(piece);
      last = path.ToArray();
    }

    static bool IsInline(AutomationElement element) {
      var cached = element.Cached;
      return (cached.ControlType == ControlType.Text && !cached.IsControlElement) || cached.ControlType == ControlType.Hyperlink;
    }

    // Ends the text being gathered: what follows is a button or a role heading.
    void EndText() {
      if (text.Length > 0) nodes.Add(new Hashtable { { "type", "Text" }, { "name", text.ToString() }, { "label", false } });
      text.Clear();
      last = null;
    }
  }
}
'@
# Window bounds from DWM are in physical pixels; screen metrics are too only in a DPI-aware
# process. UI Automation would make this process system-aware on first use; per-monitor
# awareness, set before, keeps every monitor in physical pixels.
[void][Acb.Win32]::SetProcessDpiAwarenessContext([IntPtr](-4))

$Names = @{
  Conversation = '对话'
  Stop         = '停止'
  NewChat      = '新聊天'
  Composer     = '询问 ChatGPT'
  Send         = '发送'
  You          = @('你说：', '您说：')
  Assistant    = @('ChatGPT 说：')
  ModePrefix   = '切换模式，当前模式：'
  ChatGptMode  = 'ChatGPT'
  Older        = '正在加载更早的消息…'
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
  for (;;) {
    $value = & $probe
    if ($value) { return $value }
    if ([DateTime]::UtcNow -ge $deadline) { return $null }
    Start-Sleep -Milliseconds 50
  }
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
  return [bool]($server.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId -and
    [Acb.Win32]::Owner([int]$id) -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -and
    $signature.Status -eq 'Valid' -and
    $signature.SignerCertificate.Subject -match '(^|, )O=("OpenAI OpCo, LLC"|OpenAI)(,|$)')
}

function AppIds { @([Diagnostics.Process]::GetProcessesByName('ChatGPT') | ForEach-Object Id) }

function Foreground { return @{ ok = $true; window = [Acb.Win32]::GetForegroundWindow().ToInt64() } }

# Switching pages or opening a new chat can make the app take the foreground. Give it back
# to `window`, which had it before, but only when it is the app that has it now: a window
# the user switched to meanwhile is left alone. Attaching to the input of the thread that
# holds the foreground lets this helper set it without any synthetic input.
function GiveBack($request, [int]$waitMs = 300) {
  $target = [IntPtr][long]$request.window
  if ($target -eq [IntPtr]::Zero -or -not [Acb.Win32]::IsWindow($target)) { return @{ ok = $true; taken = $false; restored = $false } }
  $app = AppIds
  $taken = Until $waitMs {
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

# Chromium makes its window the foreground one, synchronously, when UI Automation scrolls or
# presses something in its page; the foreground is given back at once.
function KeepForeground([scriptblock]$action) {
  $foreground = [Acb.Win32]::GetForegroundWindow().ToInt64()
  try { & $action } finally { $null = GiveBack @{ window = $foreground } 0 }
}

# The app's top-level windows. A minimized window exposes no UI tree, so it is restored
# without being activated (SW_SHOWNOACTIVATE): the user's active window keeps the focus.
function AppWindows {
  $ids = AppIds
  if (-not $ids) { Fail 'UNAVAILABLE' 'The ChatGPT desktop app is not running' }
  # A window can close in between.
  $windows = @(foreach ($handle in [Acb.Screen]::Windows([int[]]$ids)) { try { $Element::FromHandle($handle) } catch {} })
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

# The page of the conversation shown under `title`, or null when no window that shows on
# screen shows it: the page of a window that does not may be out of date.
function Shown([string]$title) {
  $pages = @(foreach ($window in AppWindows) {
    $document = Find $window 'Document'
    if ($document -and $document.Current.Name -eq $title) { @{ Window = $window; Document = $document } }
  })
  if ($pages.Count -gt 1) { Fail 'WINDOW' 'Several windows show a conversation with this title' }
  if (-not $pages.Count -or -not [Acb.Screen]::Shows([IntPtr]$pages[0].Window.Current.NativeWindowHandle)) { return $null }
  return $pages[0].Document
}

# Text and buttons of the conversation shown under `title`, in page order. The role headings
# before each message are screen-reader-only (`sr-only`), which tells them from message text.
# The page comes as one cached batch of its raw tree: a reply being written has one element
# per word, and the tree tells where paragraphs, list items and code lines begin.
function Transcript($request) {
  $document = Shown $request.title
  if (-not $document) { return @{ ok = $true; found = $false } }
  $scope = Find $document 'Group' $Names.Conversation
  $position = Position $scope
  $framed = [bool]$scope
  # Above its first message, the page shows a status while it has older messages to load.
  $older = [bool]($scope -and (Find $scope 'Text' $Names.Older))
  if (-not $scope) { $scope = $document }
  $nodes = [Acb.Page]::Read((RawTree $scope))
  return @{ ok = $true; found = $true; busy = [bool](Find $document 'Button' $Names.Stop); older = $older; framed = $framed; scroll = $position; nodes = $nodes }
}

# The raw tree below `scope`, fetched as one cached batch.
function RawTree($scope) {
  $cache = [Windows.Automation.CacheRequest]::new()
  foreach ($property in $Element::NameProperty, $Element::ControlTypeProperty, $Element::ClassNameProperty, $Element::IsControlElementProperty, $Element::RuntimeIdProperty, $Element::IsEnabledProperty, $Element::IsOffscreenProperty) {
    $cache.Add($property)
  }
  $cache.TreeScope = [Windows.Automation.TreeScope]::Subtree
  $cache.TreeFilter = [Windows.Automation.Automation]::RawViewCondition
  $active = $cache.Activate()
  try { return $scope.GetUpdatedCache($cache) } finally { $active.Dispose() }
}

# The approval card Codex shows in the conversation shown under `title` while it waits for the
# user (see Acb.Page.Card): {found, card: {text, buttons: [{name, className, usable}]} | null}.
function Approval($request) {
  $document = Shown $request.title
  if (-not $document) { return @{ ok = $true; found = $false } }
  $scope = Find $document 'Group' $Names.Conversation
  if (-not $scope) { return @{ ok = $true; found = $true; card = $null } }
  return @{ ok = $true; found = $true; card = [Acb.Page]::Card((RawTree $scope)) }
}

# Presses the button named `name` on the approval card of the conversation shown under `title`
# while the card reads `text`: a card that changed asks something else. The button is taken
# from that card (see Acb.Page.CardButton), so no other card's button is pressed.
function Press($request) {
  $document = Shown $request.title
  if (-not $document) { Fail 'WINDOW' 'The ChatGPT window does not show the conversation on screen' }
  $scope = Find $document 'Group' $Names.Conversation
  $button = if ($scope) { [Acb.Page]::CardButton((RawTree $scope), $request.text, $request.name) }
  if (-not $button) { Fail 'NO_APPROVAL' "The approval card changed, or has no single usable button named $($request.name); read it again" }
  KeepForeground { Invoke $button }
  return @{ ok = $true }
}

# Where the conversation `scope` is scrolled to: null when it fits, so it does not scroll.
function Position($scope) {
  $scroll = $null
  if (-not ($scope -and $scope.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll))) { return $null }
  if (-not $scroll.Current.VerticallyScrollable) { return $null }
  return @{ percent = $scroll.Current.VerticalScrollPercent; view = $scroll.Current.VerticalViewSize }
}

# Scrolls the conversation shown under `title` to `percent` of its height (ScrollPattern: no
# input, the window is not activated).
function Scroll($request) {
  $document = Shown $request.title
  if (-not $document) { return @{ ok = $true; found = $false } }
  $scope = Find $document 'Group' $Names.Conversation
  $scroll = $null
  if ($scope -and $scope.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll) -and $scroll.Current.VerticallyScrollable) {
    $scroll.SetScrollPercent([Windows.Automation.ScrollPattern]::NoScroll, [Math]::Min(100, [Math]::Max(0, [double]$request.percent)))
  }
  return @{ ok = $true; found = [bool]$scope }
}

# Scrolls the conversation shown under `title` to the first of the messages whose headings
# have the runtime IDs `ids` that is still on the page, then `pages` screens further up
# (ScrollItemPattern and ScrollPattern: no input). The page renders the messages above it
# then. Moving from what the page shows keeps to it while the page re-measures the messages it
# renders, which a share of its height does not.
function Reveal($request) {
  $document = Shown $request.title
  if (-not $document) { return @{ ok = $true; found = $false } }
  $scope = Find $document 'Group' $Names.Conversation
  if (-not $scope) { return @{ ok = $true; found = $false } }
  $cache = [Windows.Automation.CacheRequest]::new()
  $cache.Add($Element::RuntimeIdProperty)
  $headings = [Windows.Automation.OrCondition]::new(@($Names.You + $Names.Assistant | ForEach-Object { Condition 'Text' $_ }))
  $active = $cache.Activate()
  try { $found = @($scope.FindAll($Descendants, $headings)) } finally { $active.Dispose() }
  $byId = @{}
  foreach ($heading in $found) { $byId[(@($heading.GetCachedPropertyValue($Element::RuntimeIdProperty)) -join '.')] = $heading }
  foreach ($id in @($request.ids)) {
    if ($byId.ContainsKey($id)) {
      $byId[$id].GetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
      $scroll = $null
      if ($scope.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll) -and $scroll.Current.VerticallyScrollable) {
        for ($page = 0; $page -lt [int]$request.pages; $page++) {
          $scroll.Scroll([Windows.Automation.ScrollAmount]::NoAmount, [Windows.Automation.ScrollAmount]::LargeDecrement)
        }
      }
      return @{ ok = $true; found = $true }
    }
  }
  return @{ ok = $true; found = $false }
}

# Opens the ChatGPT desktop window, also when its processes keep running in the tray.
# It is a packaged app, opened through the shell by its application user model ID.
function Launch {
  $ids = AppIds
  if ($ids -and [Acb.Screen]::Windows([int[]]$ids).Length) { return @{ ok = $true; started = $false } }
  $package = @(Get-AppxPackage -Name 'OpenAI.Codex')[0]
  if (-not $package) { Fail 'UNAVAILABLE' 'The ChatGPT desktop app is not installed' }
  $application = @((Get-AppxPackageManifest $package).Package.Applications.Application)[0]
  $foreground = Foreground
  try {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList "shell:AppsFolder\$($package.PackageFamilyName)!$($application.Id)"
    $opened = Until 10000 {
      $null = GiveBack $foreground
      $ids = AppIds
      $ids -and [Acb.Screen]::Windows([int[]]$ids).Length -gt 0
    }
    if (-not $opened) { Fail 'WINDOW' 'The ChatGPT desktop app did not open a window in time' }
  } finally {
    $null = GiveBack $foreground
  }
  return @{ ok = $true; started = $true }
}

# Brings the app's windows that do not show on screen above the others without activating
# them (topmost on, then off), so the app updates their pages. Each comes with the window it
# was below, to put it back with Lower: the first one above it of another process, as the
# app's own windows above it (owned ones, such as its input method window) move along with
# it. The user's active window keeps the focus.
function Raise {
  $flags = 0x0001 -bor 0x0002 -bor 0x0010
  $app = AppIds
  $raised = @(foreach ($window in AppWindows) {
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ([Acb.Screen]::Shows($handle)) { continue }
    $after = [Acb.Win32]::GetWindow($handle, 3)
    while ($after -ne [IntPtr]::Zero) {
      [uint32]$owner = 0
      [void][Acb.Win32]::GetWindowThreadProcessId($after, [ref]$owner)
      if ($app -notcontains [int]$owner) { break }
      $after = [Acb.Win32]::GetWindow($after, 3)
    }
    # Below no other window: it is put back at the top, where it already is.
    if ($after -eq [IntPtr]::Zero) { continue }
    [void][Acb.Win32]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, $flags)
    [void][Acb.Win32]::SetWindowPos($handle, [IntPtr](-2), 0, 0, 0, 0, $flags)
    @{ window = $handle.ToInt64(); after = $after.ToInt64() }
  })
  return @{ ok = $true; raised = $raised }
}

function Lower($request) {
  $flags = 0x0001 -bor 0x0002 -bor 0x0010
  foreach ($entry in @($request.raised)) {
    $window = [IntPtr][long]$entry.window
    $after = [IntPtr][long]$entry.after
    if ([Acb.Win32]::IsWindow($window) -and [Acb.Win32]::IsWindow($after)) {
      [void][Acb.Win32]::SetWindowPos($window, $after, 0, 0, 0, 0, $flags)
    }
  }
  return @{ ok = $true }
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
  # The sidebar can show more than one new-chat button (its list of recent chats has one too);
  # any opens the same page, which is checked before anything is written. The first is used.
  $newChat = @(Visible $window 'Button' $Names.NewChat)
  if (-not $newChat.Count) { Fail 'WINDOW' 'The new-chat button was not found' }
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
      'launch' { Launch }
      'raise' { Raise }
      'lower' { Lower $request }
      'scroll' { KeepForeground { Scroll $request } }
      'reveal' { KeepForeground { Reveal $request } }
      'approval' { Approval $request }
      'press' { Press $request }
      default { Fail 'INPUT' "Unknown operation: $($request.op)" }
    }
  } catch {
    $code, $message = $_.Exception.Message -split "`t", 2
    if (-not $message) { $code, $message = 'WINDOW', $_.Exception.Message }
    $response = @{ ok = $false; code = $code; message = $message }
  }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 5 -Compress))
}
