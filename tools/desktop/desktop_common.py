"""Shared bounded CDP access and opaque, host-owned approval handles. No credential access."""
import json, os, sys, time, urllib.request, urllib.parse, weakref, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# —— 安全边界与共享常量（集中管理，避免散落魔法数字）——
MAX_TEXT_CHARS = 65536             # 单次文本（prompt/剪贴板/config）长度上限，不得无理由提高
CLIPBOARD_MAX_BYTES = 131072       # 剪贴板快照保留上限（128 KiB）
CLIPBOARD_MAX_FORMATS = 32         # 剪贴板格式数量上限
STATE_FILE_MAX_BYTES = 2 * 1024 * 1024  # 状态文件读取上限（2 MiB）
MAX_PATH_ROOTS = 32                # 授权根目录数量上限
RENAME_WAIT_SECONDS = 0.75         # 改名后 UI 稳定等待
KEYCODE_A = 65                     # CDP 键码：Ctrl+A（全选）
KEYCODE_V = 86                     # CDP 键码：Ctrl+V（粘贴）

def config():
    try:
        raw = Path(os.environ.get('ACB_CONFIG', ROOT / '.bridge.config.json'))
        # 先检查原始路径的 symlink（resolve 会丢失此信息；Windows junction 由 P2-05 路径核验覆盖）
        if raw.is_symlink():
            raise ToolError('CONFIG','Configuration must not be a symlink',2)
        path = raw.resolve()
        if path.exists() and (not path.is_file() or path.stat().st_size>MAX_TEXT_CHARS):
            raise ToolError('CONFIG','Configuration must be a bounded regular file',2)
        value = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        if os.environ.get('ACB_CONFIG') and not path.exists(): raise ToolError('CONFIG','Configuration file does not exist',2)
        if not isinstance(value,dict) or not isinstance(value.get('desktop',{}),dict): raise ToolError('CONFIG','Invalid configuration object',2)
        settings = {'enabled':False,'cdpUrl':'http://127.0.0.1:9222','remoteAllowOrigins':None,'python':'python','allowForegroundAutomation':False,'allowPhysicalInput':False,'uiPollMs':100}
        if set(value.get('desktop',{}))-set(settings): raise ToolError('CONFIG','Unknown desktop configuration field',2)
        settings.update(value.get('desktop',{}))
        settings['cdpUrl'] = os.environ.get('ACB_CDP_URL',settings['cdpUrl'])
        if not isinstance(settings['cdpUrl'],str): raise ToolError('CONFIG','Invalid CDP endpoint',2)
        endpoint=urllib.parse.urlparse(settings['cdpUrl']); port=endpoint.port
        if endpoint.scheme!='http' or endpoint.hostname not in ('127.0.0.1','localhost','::1') or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ToolError('CONFIG','CDP must be credential-free loopback HTTP',2)
        host='['+endpoint.hostname+']' if endpoint.hostname=='::1' else endpoint.hostname
        origin='http://'+host+(':'+str(port) if port not in (None,80) else '')
        if settings['remoteAllowOrigins'] != origin: raise ToolError('CONFIG','remoteAllowOrigins must be an explicit restricted loopback origin; wildcard rejected',2)
        if any(type(settings[k]) is not bool for k in ('enabled','allowForegroundAutomation','allowPhysicalInput')) or settings['allowPhysicalInput']:
            raise ToolError('CONFIG','Physical input is unsupported; desktop flags must be boolean',2)
        if not isinstance(settings['python'],str) or not settings['python'].strip(): raise ToolError('CONFIG','Invalid Python executable',2)
        return settings
    except ToolError: raise
    except (ValueError,OSError,TypeError): raise ToolError('CONFIG','Invalid desktop configuration',2)

def read_bounded_json(path):
    """有界 JSON 读取：拒绝 symlink、超 64KiB、非普通文件；解析失败返回结构化错误。"""
    p = Path(path)
    if p.is_symlink(): raise ToolError('CONFIG','Configuration must not be a symlink',2)
    p = p.resolve()
    if not p.exists(): return None
    if not p.is_file() or p.stat().st_size > MAX_TEXT_CHARS: raise ToolError('CONFIG','Configuration must be a bounded regular file',2)
    try: return json.loads(p.read_text(encoding='utf-8'))
    except (ValueError,OSError): raise ToolError('CONFIG','Invalid configuration JSON',2)

class ToolError(Exception):
    def __init__(self, code, message, exit_code=3, status='blocked', details=None):
        super().__init__(message); self.code=code; self.exit_code=exit_code; self.status=status; self.details=details
class Handle: pass
class DesktopAuthority:
    """Only a trusted in-process host can issue these; no CLI flag or JSON grants authority."""
    def __init__(self): self._handles=weakref.WeakKeyDictionary()
    def approve(self, operation, prompt_hash=None, binding=None):
        handle=Handle(); self._handles[handle]=(operation,prompt_hash,binding); return handle
    def consume(self, handle, operation, prompt_hash=None, binding=None):
        if not isinstance(handle,Handle) or self._handles.pop(handle,None)!=(operation,prompt_hash,binding):
            raise ToolError('AUTH','One-time trusted host approval required')

class DesktopLock:
    """Windows 命名互斥体：串行化共享 composer/焦点/剪贴板的桌面写操作（防并发 TOCTOU）。
    Worker 崩溃时互斥体自动释放（句柄随进程关闭），不会永久死锁。
    非 Windows（测试/开发）环境降级为 no-op：跨进程互斥仅在真实 Windows 桌面有意义。"""
    def __init__(self, name='ACB_Desktop_Write_Lock'):
        self.acquired=False
        self._noop = sys.platform != 'win32'
        if self._noop:
            return
        import ctypes
        self.kernel32=ctypes.windll.kernel32
        self.handle=self.kernel32.CreateMutexW(None,False,name)
        if not self.handle: raise ToolError('LOCK','Could not create desktop mutex',6)
    def acquire(self, timeout_ms=5000):
        if self._noop:
            self.acquired=True; return
        ret=self.kernel32.WaitForSingleObject(self.handle,int(timeout_ms))
        # WAIT_OBJECT_0=0 正常获取；WAIT_ABANDONED=0x80 表示前任持有者崩溃，互斥体已归属当前线程
        if ret not in (0, 0x80): raise ToolError('LOCK_TIMEOUT','Another desktop write is in progress',6)
        self.acquired=True
    def release(self):
        if self.acquired and not self._noop:
            self.kernel32.ReleaseMutex(self.handle)
        self.acquired=False
    def __enter__(self):
        self.acquire(); return self
    def __exit__(self,*exc):
        self.release()

CAPABILITIES = {
 'read': {'backgroundSafe': True,'requiresForeground':False,'usesPhysicalInput':False,'requiresUserApproval':False},
 'write': {'backgroundSafe':False,'requiresForeground':True,'usesPhysicalInput':False,'requiresUserApproval':True},
}
def guard_write(operation, authority=None, approval=None, prompt_hash=None, binding=None):
    settings=config()
    if not settings['enabled'] or not settings['allowForegroundAutomation']:
        raise ToolError('FOREGROUND_REQUIRED','Write path may change editing focus; disabled by default',6)
    if authority is None: raise ToolError('AUTH','Configuration does not grant one-time approval')
    authority.consume(approval,operation,prompt_hash,binding)

def targets():
    settings=config()
    if not settings['enabled']: raise ToolError('AGENT','Desktop integration is disabled',6)
    request=urllib.request.Request(settings['cdpUrl'].rstrip('/')+'/json')
    # Refuse redirects; never follow a loopback URL onto another host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=5) as response:
            data=response.read(1048577)
    except urllib.error.URLError as error:
        raise ToolError('CDP_UNAVAILABLE','Configured current-instance CDP endpoint is unavailable',6,status='blocked') from error
    if len(data)>1048576: raise ToolError('INPUT','Target listing exceeded limit',2)
    value=json.loads(data)
    if not isinstance(value,list) or len(value)>200: raise ToolError('INPUT','Invalid target listing',2)
    return value

def find_target(kind):
    matches=[]
    for target in targets():
        url=urllib.parse.urlparse(target.get('url',''))
        if kind=='webview': match=target.get('type') in ('webview','page') and url.scheme=='https' and url.hostname=='chatgpt.com'
        else: match=target.get('type')=='page' and url.scheme=='app' and 'avatar' not in target.get('url','') and 'detached' not in target.get('url','')
        if match: matches.append(target)
    if len(matches)!=1: raise ToolError('AGENT','Expected exactly one authorized application target',6)
    endpoint=urllib.parse.urlparse(config()['cdpUrl']); ws=urllib.parse.urlparse(matches[0].get('webSocketDebuggerUrl',''))
    if ws.scheme!='ws' or ws.hostname!=endpoint.hostname or ws.port!=endpoint.port or ws.username or ws.password:
        raise ToolError('CONFIG','Untrusted websocket endpoint',2)
    return matches[0]['webSocketDebuggerUrl']

class Cdp:
    def __init__(self,url):
        if os.name == 'nt': verify_cdp_owner(url)
        try: import websocket
        except ImportError: raise ToolError('DEPENDENCY','Install tools/desktop/requirements.txt',6)
        self.ws=websocket.create_connection(url,timeout=10,enable_multithread=True); self.number=0
    def call(self,method,params):
        self.number+=1; self.ws.send(json.dumps({'id':self.number,'method':method,'params':params})); deadline=time.monotonic()+10
        for _ in range(200):
            if time.monotonic()>deadline: break
            raw=self.ws.recv()
            if len(raw)>1048576: raise ToolError('INPUT','CDP response exceeded limit',2)
            message=json.loads(raw)
            if message.get('id')==self.number:
                if 'error' in message or message.get('result',{}).get('exceptionDetails'): raise ToolError('CDP','Application operation failed')
                return message
        raise ToolError('TIMEOUT','CDP response deadline exceeded',7)
    def evaluate(self,expression): return self.call('Runtime.evaluate',{'expression':expression,'returnByValue':True}).get('result',{}).get('result',{}).get('value')
    def close(self): self.ws.close()

def verify_cdp_owner(url):
    """Bind the loopback debugger to the existing interactive ChatGPT instance."""
    import subprocess
    port=urllib.parse.urlparse(url).port
    script=r"""
    $ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
    $apps=@(Get-Process -Name ChatGPT | Where-Object {$_.MainWindowHandle -ne 0})
    if ($apps.Count -ne 1) {throw 'OWNER'}
    $processes=@(Get-CimInstance Win32_Process)
    $owners=@(Get-NetTCPConnection -State Listen -LocalPort PORT | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) {throw 'OWNER'}
    $current=$owners[0]
    while ($current -ne $apps[0].Id) {
      $row=$processes | Where-Object {$_.ProcessId -eq $current}
      if (-not $row -or $row.ParentProcessId -eq 0) {throw 'OWNER'}
      $current=$row.ParentProcessId
    }
    $signature=Get-AuthenticodeSignature -LiteralPath $apps[0].Path
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI') {throw 'OWNER'}
    [Console]::Out.Write('BOUND')
    """.replace('PORT',str(port))
    executable=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    result=subprocess.run([str(executable),'-NoProfile','-NonInteractive','-Command',script],capture_output=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode or result.stdout!=b'BOUND': raise ToolError('PROVENANCE','CDP listener is not bound to the current signed application',3)

def redact(value):
    if isinstance(value,dict):
        return {k: '[REDACTED]' if re.search(r'^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$',k,re.I) else redact(v) for k,v in value.items()}
    if isinstance(value,list): return [redact(v) for v in value]
    if not isinstance(value,str): return value
    value=re.sub(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)', '[REDACTED]',value)
    value=re.sub(r'("(?:authorization|api[_-]?key|access[_-]?token|password|secret)"\s*:\s*")[^"\r\n]*(")',r'\1[REDACTED]\2',value,flags=re.I)
    value=re.sub(r'(\b(?:authorization|api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)(?:Bearer\s+)?[^\s,;"}]+',r'\1[REDACTED]',value,flags=re.I)
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]',lambda m:'\\u%04x'%ord(m[0]),value)

def validate_prompt(prompt):
    if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>MAX_TEXT_CHARS: raise ToolError('INPUT','Invalid prompt length',2)
    if redact(prompt)!=prompt: raise ToolError('INPUT','Authentication material is not accepted',2)

def entry(fn):
    try: return fn() or 0
    except ToolError as error:
        payload={'ok':False,'status':error.status,'code':error.code,'error':str(error)}
        if error.details is not None: payload['details']=error.details
        print(json.dumps(payload,ensure_ascii=False),file=sys.stderr); return error.exit_code
    except Exception:
        print(json.dumps({'ok':False,'code':'EXECUTION','error':'Tool failed; private response omitted'}),file=sys.stderr); return 3
