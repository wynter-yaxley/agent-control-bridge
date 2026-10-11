#!/usr/bin/env python3
"""Drive a second ChatGPT.exe instance as a background worker (no focus stealing).

实测约束（Windows，勿改）：
- 主实例（用户在用）已占 9222 + 默认 profile；本脚本只驱动第二个实例（默认 9224）；
- 第二实例启动参数（已验证成功）：--remote-debugging-port=9224 --remote-allow-origins=*
  --user-data-dir=<profile> --window-position=-2000,-2000（移出屏幕 → headed 但不抢焦点）；
- 独立 profile，首次登录需用户手动完成一次，登录态只存在该 profile 内；
- 本脚本不读取/导出 Cookie/token/密码，只经 CDP 读写可见 DOM。

CLI（stdout 只输出最终 JSON，日志走 stderr，失败非零退出）：
  chatgpt_worker.py start [--port P] [--profile P] [--exe PATH]
      # 启动隐藏实例；端口已有实例（/json/version 可达）则不重复启动
  chatgpt_worker.py login [--port P] [--profile P] [--timeout S]
      # 弹可见窗口，阻塞等待用户手动登录（LOGGED_IN_JS：可见编辑器 + 无登录按钮）
  chatgpt_worker.py ask [--prompt TEXT] [--conversation ID] [--port P] [--timeout S]
      # prompt 缺省读 stdin；--conversation 先导航到 chatgpt.com/c/<id> 续会话
"""
import argparse, json, os, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

from clipboard_paste import paste_text
from desktop_common import Cdp, ToolError, entry, redact
from chatgpt_headless import (LOGGED_IN_JS, POLL_INTERVAL_SECONDS, STOP_ACTIVE_JS,
                              conversation_url, read_stdin, resolve_prompt,
                              validate_conversation_id)
from gpt_read_cdp import EXTRACT
from gpt_send_cdp import CHECK_EDITOR, READ_EDITOR, SUBMIT_EDITOR

DEFAULT_EXE = r'C:\Program Files\WindowsApps\OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe'
DEFAULT_PROFILE = Path.home() / '.codex' / 'chatgpt-second-profile'
DEFAULT_PORT = 9224
OFFSCREEN_POSITION = '-2000,-2000'          # 移出屏幕：headed 但不抢焦点
ALLOW_ORIGINS = '*'                         # 第二实例专用端口；与 desktop_common.config 的受限 origin 校验无关
START_TIMEOUT_SECONDS = 90                  # 等待 /json/version 可达的上限
LOGIN_TIMEOUT_SECONDS = 600                 # 一次性手动登录等待上限
ASK_TIMEOUT_SECONDS = 300                   # 回复轮询上限
EDITOR_WAIT_SECONDS = 30                    # composer/webview 出现等待上限
JSON_LIMIT_BYTES = 1048576                  # 与 desktop_common.targets 相同的有界读取上限


def log(message):
    print(message, file=sys.stderr)


def require_windows():
    """CDP + Windows 剪贴板注入都只在 Windows 主机上有意义；其余环境 fail-closed。"""
    if sys.platform != 'win32':
        raise ToolError('DEPENDENCY', 'chatgpt_worker must run on the Windows host', 6)


def _bounded_get_json(url, timeout):
    """有界 loopback JSON 读取；拒绝重定向（绝不跟随到其他主机）。"""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs): return None
    with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url), timeout=timeout) as response:
        data = response.read(JSON_LIMIT_BYTES + 1)
    if len(data) > JSON_LIMIT_BYTES:
        raise ToolError('INPUT', 'Devtools endpoint response exceeded limit', 2)
    return json.loads(data)


def version_reachable(port):
    """/json/version 可达即视为已有实例在跑；不可达返回 None（连接失败不算致命）。"""
    try:
        value = _bounded_get_json('http://127.0.0.1:%d/json/version' % port, timeout=2)
    except ToolError:
        raise
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def listener_pid(port):
    """已运行实例的 PID 只能从 netstat 侧信道拿；拿不到就返回 None，不阻塞 start。"""
    try:
        completed = subprocess.run(['netstat', '-ano', '-p', 'tcp'], capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    for line in (completed.stdout or '').splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3].upper() == 'LISTENING' and parts[1].endswith(':' + str(port)):
            try:
                return int(parts[4])
            except ValueError:
                return None
    return None


def build_launch_args(exe, port, profile, visible):
    """唯一的启动参数出口：login 弹可见窗口，start/ask 移出屏幕。"""
    args = [str(exe), '--remote-debugging-port=' + str(int(port)), '--remote-allow-origins=' + ALLOW_ORIGINS,
            '--user-data-dir=' + str(profile)]
    if not visible:
        args.append('--window-position=' + OFFSCREEN_POSITION)
    return args


def _popen_flags():
    # 独立进程组 + 脱离控制台；非 Windows（测试）环境两个常量缺失时退化为 0
    return getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0) | getattr(subprocess, 'DETACHED_PROCESS', 0)


def launch(exe, port, profile, visible):
    command = build_launch_args(exe, port, profile, visible)
    log('chatgpt-worker: launching ' + command[0] + ' with worker flags')
    try:
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, creationflags=_popen_flags())
    except OSError as error:
        raise ToolError('EXECUTION', 'Could not launch the ChatGPT worker instance: ' + str(error), 6)


def ensure_running(exe, port, profile, visible=False, timeout=START_TIMEOUT_SECONDS,
                   poll=POLL_INTERVAL_SECONDS):
    """端口已有实例则不重复启动；否则 Popen 并轮询 /json/version 直到可达。"""
    if version_reachable(port) is not None:
        return {'alreadyRunning': True, 'pid': listener_pid(port)}
    process = launch(exe, port, profile, visible)
    deadline = time.monotonic() + timeout
    while True:
        if version_reachable(port) is not None:
            return {'alreadyRunning': False, 'pid': process.pid}
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'ChatGPT worker instance did not expose its debugging port before deadline', 7)
        time.sleep(poll)


def list_targets(port):
    try:
        value = _bounded_get_json('http://127.0.0.1:%d/json' % port, timeout=5)
    except ToolError:
        raise
    except Exception:
        return []
    return value if isinstance(value, list) else []


def find_webview_ws(port):
    """与 desktop_common.find_target('webview') 同一匹配/信任规则，但指向 9224 实例。"""
    matches = []
    for target in list_targets(port):
        url = urllib.parse.urlparse(target.get('url', ''))
        if target.get('type') in ('webview', 'page') and url.scheme == 'https' and url.hostname == 'chatgpt.com':
            matches.append(target)
    if len(matches) != 1:
        raise ToolError('AGENT', 'Expected exactly one authorized application target', 6)
    ws = urllib.parse.urlparse(matches[0].get('webSocketDebuggerUrl', ''))
    if ws.scheme != 'ws' or ws.hostname not in ('127.0.0.1', 'localhost') or ws.port != port or ws.username or ws.password:
        raise ToolError('CONFIG', 'Untrusted websocket endpoint', 2)
    return matches[0]['webSocketDebuggerUrl']


def wait_for_webview(port, timeout, poll=POLL_INTERVAL_SECONDS):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return find_webview_ws(port)
        except ToolError:
            pass
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'ChatGPT.com webview target did not appear before deadline', 7)
        time.sleep(poll)


def is_logged_in(port):
    """LOGGED_IN_JS：可见编辑器 + 无登录按钮；找不到 webview 或求值失败一律视为未登录。"""
    try:
        ws = find_webview_ws(port)
    except ToolError:
        return False
    connection = Cdp(ws)
    try:
        return bool(connection.evaluate(LOGGED_IN_JS))
    except ToolError:
        return False
    finally:
        connection.close()


def parse_extraction(raw):
    """解析 gpt_read_cdp.EXTRACT 的输出，返回 (assistant 计数, 最后一条 assistant 文本)。"""
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        value = None
    messages = value.get('messages', []) if isinstance(value, dict) else None
    if not isinstance(messages, list) or len(messages) > 1000:
        raise ToolError('AGENT', 'Message extraction returned an unexpected shape', 6)
    texts = [m.get('text') for m in messages
             if isinstance(m, dict) and m.get('role') == 'assistant' and isinstance(m.get('text'), str) and m.get('text')]
    return len(texts), (texts[-1] if texts else None)


def wait_for_editor(connection, timeout, poll=POLL_INTERVAL_SECONDS):
    deadline = time.monotonic() + timeout
    while True:
        try:
            state = connection.evaluate(CHECK_EDITOR)
        except ToolError:
            raise
        except Exception:  # 导航/中间页期间的瞬时求值失败按未出现处理，由超时兜底
            state = 'none'
        if state == 'found':
            return
        if state == 'ambiguous':
            raise ToolError('AGENT', 'Expected exactly one visible ChatGPT composer', 6)
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'ChatGPT composer did not appear before deadline', 7)
        time.sleep(poll)


def submit_prompt(connection, prompt):
    """与 gpt_send_cdp.py 相同的 fail-closed 提交链：唯一 composer → 无草稿 →
    校验粘贴回读 → 唯一发送按钮。窗口在屏幕外不影响 DOM 可见性判定。"""
    if connection.evaluate(CHECK_EDITOR) != 'found':
        raise ToolError('AGENT', 'Expected exactly one visible ChatGPT composer', 6)
    current = connection.evaluate(READ_EDITOR)
    if not isinstance(current, str):
        raise ToolError('INPUT', 'Composer contents could not be read safely')
    if current.strip():
        raise ToolError('DRAFT_PRESENT', 'Composer contains an existing draft; it was preserved')
    paste_text(connection, {'kind': 'gpt-composer'}, prompt)
    if connection.evaluate(READ_EDITOR) != prompt:
        raise ToolError('PASTE_MISMATCH', 'Composer readback differs; prompt was not submitted', 4, status='verification_failed')
    submitted = connection.evaluate(SUBMIT_EDITOR)
    if submitted != 'clicked':
        raise ToolError('EXECUTION', 'A unique supported submit control was not available')


def wait_for_reply(connection, baseline, timeout, poll=POLL_INTERVAL_SECONDS):
    """完成判定：停止生成按钮消失 + assistant 计数超过基线 + 文本连续两次轮询稳定。"""
    deadline = time.monotonic() + timeout
    previous = None
    while True:
        try:
            generating = bool(connection.evaluate(STOP_ACTIVE_JS))
            snapshot = parse_extraction(connection.evaluate(EXTRACT))
        except ToolError:
            raise
        except Exception:  # 轮询期间的瞬时求值失败按"仍在生成"处理，最终由超时兜底
            generating, snapshot = True, None
        if not generating and snapshot:
            count, text = snapshot
            if count > baseline and text and text == previous:
                return text
            previous = text or None
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'Assistant reply was not detected before deadline', 7)
        time.sleep(poll)


def run_start(args, poll=POLL_INTERVAL_SECONDS):
    info = ensure_running(resolve_exe(args), args.port, resolve_profile(args), visible=False,
                          timeout=args.timeout if args.timeout is not None else START_TIMEOUT_SECONDS, poll=poll)
    print(json.dumps({'status': 'ok', 'pid': info['pid'], 'port': args.port,
                      'alreadyRunning': info['alreadyRunning']}, ensure_ascii=False))
    return 0


def run_login(args, poll=POLL_INTERVAL_SECONDS):
    info = ensure_running(resolve_exe(args), args.port, resolve_profile(args), visible=True)
    log('chatgpt-worker: waiting for manual login in the visible window')
    if info['alreadyRunning'] and not is_logged_in(args.port):
        # 已有实例多半是隐藏启动的；登录态存在 profile，关闭后重新 login（可见窗口）即可
        log('chatgpt-worker: reusing the already-running worker instance; if its window is hidden, close it first to relaunch visibly')
    deadline = time.monotonic() + (args.timeout if args.timeout is not None else LOGIN_TIMEOUT_SECONDS)
    while True:
        if is_logged_in(args.port):
            log('chatgpt-worker: login detected; session is stored in the worker profile (window can be closed)')
            print(json.dumps({'status': 'ok', 'loggedIn': True}, ensure_ascii=False))
            return 0
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'Login was not detected before deadline', 7)
        time.sleep(poll)


def run_ask(args, prompt, poll=POLL_INTERVAL_SECONDS, editor_timeout=EDITOR_WAIT_SECONDS,
            reply_timeout=None, cdp_factory=None):
    conversation_id = validate_conversation_id(args.conversation) if args.conversation else None
    ensure_running(resolve_exe(args), args.port, resolve_profile(args), visible=False)
    ws = wait_for_webview(args.port, editor_timeout, poll)
    connection = (cdp_factory or Cdp)(ws)
    try:
        if conversation_id:
            log('chatgpt-worker: navigating to ' + conversation_url(conversation_id))
            connection.call('Page.navigate', {'url': conversation_url(conversation_id)})
        wait_for_editor(connection, editor_timeout, poll)
        baseline, _ = parse_extraction(connection.evaluate(EXTRACT))
        submit_prompt(connection, prompt)
        log('chatgpt-worker: prompt submitted; waiting for reply')
        timeout = reply_timeout if reply_timeout is not None else (args.timeout or ASK_TIMEOUT_SECONDS)
        reply = wait_for_reply(connection, baseline, timeout, poll)
        print(json.dumps({'status': 'ok', 'reply': redact(reply)}, ensure_ascii=False))
        return 0
    finally:
        connection.close()


def resolve_exe(args):
    exe = args.exe or os.environ.get('ACB_CHATGPT_EXE') or DEFAULT_EXE
    if not isinstance(exe, str) or not exe.strip():
        raise ToolError('INPUT', 'Invalid ChatGPT executable path', 2)
    return exe


def resolve_profile(args):
    return args.profile or str(DEFAULT_PROFILE)


def build_parser():
    parser = argparse.ArgumentParser(
        prog='chatgpt_worker.py',
        description='Manage and drive the second ChatGPT.exe instance as a background worker (off-screen, port 9224)')
    parser.add_argument('mode', choices=['start', 'login', 'ask'])
    parser.add_argument('--prompt', help='prompt text; ask mode falls back to stdin when omitted')
    parser.add_argument('--conversation', help='continue an existing conversation (chatgpt.com/c/<id>)')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help='second instance debugging port (default 9224)')
    parser.add_argument('--profile', default=None, help='dedicated user-data-dir for the second instance')
    parser.add_argument('--exe', default=None, help='ChatGPT.exe path (or ACB_CHATGPT_EXE environment variable)')
    parser.add_argument('--timeout', type=float, default=None, help='override mode timeout in seconds')
    return parser


def parse_args(argv=None):
    try:
        args = build_parser().parse_args(argv)
    except SystemExit:
        raise ToolError('INPUT', 'Invalid command line arguments', 2)
    if args.timeout is not None and args.timeout <= 0:
        raise ToolError('INPUT', 'timeout must be positive', 2)
    if not (1 <= args.port <= 65535):
        raise ToolError('INPUT', 'port must be within 1..65535', 2)
    return args


def main(argv=None):
    args = parse_args(argv)
    require_windows()
    if args.mode == 'start':
        return run_start(args)
    if args.mode == 'login':
        return run_login(args)
    stdin_text = '' if args.prompt is not None else read_stdin()
    return run_ask(args, resolve_prompt(args, stdin_text))


if __name__ == '__main__':
    sys.exit(entry(main))
