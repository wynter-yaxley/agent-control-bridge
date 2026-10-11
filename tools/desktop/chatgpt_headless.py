#!/usr/bin/env python3
"""Drive chatgpt.com (ChatGPT desktop app web body) in a background window via Playwright.

实测约束（Windows + Playwright 1.63 + chromium，勿改）：
- 纯 headless 会被 Cloudflare "请稍候…" 人机验证拦截，因此绝不能 headless=True；
- headed + `--window-position=-2000,-2000`（窗口移出屏幕）可正常加载且不抢用户鼠标焦点；
- 登录态只保存在独立 persistent profile 目录内，本脚本不读取/导出 Cookie/token/密码。

CLI（供 Node 侧 subprocess 调用；stdin 或 argv 传参；stdout 只输出最终 JSON，日志走 stderr）：
  chatgpt_headless.py login [--profile P] [--timeout S]     # 弹可见窗口，用户手动登录
  chatgpt_headless.py ask [--prompt TEXT] [--conversation ID] [--profile P] [--timeout S]
      # prompt 缺省时读 stdin；--conversation 续用指定会话，否则当前会话
所有失败路径（找不到输入框、发送后读不到回复、超时）都走 ToolError：结构化错误到
stderr、非零退出码，stdout 不被污染。
"""
import argparse, json, re, sys, time
from pathlib import Path
from desktop_common import ToolError, entry, validate_prompt

CHATGPT_URL = 'https://chatgpt.com/'
OFFSCREEN_POSITION = '-2000,-2000'          # 移出屏幕：headed 但不抢焦点
DEFAULT_PROFILE = Path.home() / '.codex' / 'chatgpt-headless-profile'
DEFAULT_CHANNEL = 'chrome'                  # 真实 Chrome：Google/Cloudflare 放行（chromium 带自动化特征会被拦）
LOGIN_TIMEOUT_SECONDS = 600                 # 一次性手动登录等待上限
ASK_TIMEOUT_SECONDS = 300                   # 回复轮询上限
EDITOR_WAIT_SECONDS = 30                    # 输入框出现等待上限
PAGE_LOAD_TIMEOUT_MS = 60000
POLL_INTERVAL_SECONDS = 1.0
CONVERSATION_ID_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{7,63}$')
CONVERSATION_URL_PATTERN = re.compile(r'chatgpt\.com/c/([A-Za-z0-9-]+)')

# 选择器与可见性过滤和 gpt_send_cdp.py 保持同一写法（offsetParent + 宽高 > 0）。
FIND_EDITOR_JS = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const eds=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"],textarea')].filter(visible);
 return eds.length===1?'found':(eds.length?'ambiguous':'none');
})()
"""
FOCUS_EDITOR_JS = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const eds=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"],textarea')].filter(visible);
 if(eds.length!==1)return 'ambiguous';
 eds[0].focus();return 'focused';
})()
"""
READ_EDITOR_JS = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const eds=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"],textarea')].filter(visible);
 if(eds.length!==1)return JSON.stringify({found:false});
 const e=eds[0];return e.matches('textarea,input')?e.value:e.textContent;
})()
"""
SUBMIT_EDITOR_JS = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const candidates=[...document.querySelectorAll('[data-testid="send-button"],button[aria-label*="发送"],button[aria-label*="Send"]')];
 const buttons=candidates.filter(b=>{const label=(b.getAttribute('aria-label')||b.textContent||'').trim();return !/停止|stop|Stop/i.test(label)&&visible(b);});
 if(buttons.length===1){buttons[0].click();return 'clicked';}
 return buttons.length>1?'ambiguous':'no-submit';
})()
"""
STOP_ACTIVE_JS = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 return [...document.querySelectorAll('[data-testid="stop-button"]')].some(visible);
})()
"""
READ_REPLIES_JS = r"""
(() => {
 const msgs=[...document.querySelectorAll('div[data-message-author-role="assistant"]')];
 const last=msgs[msgs.length-1];
 return JSON.stringify({count:msgs.length,text:last?last.innerText.trim():''});
})()
"""
LOGGED_IN_JS = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const editor=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"]')].some(visible);
 const loginButton=[...document.querySelectorAll('[data-testid="login-button"],a[href*="/auth/login"]')].some(visible);
 return editor&&!loginButton;
})()
"""


def log(message):
    print(message, file=sys.stderr)


def normalize(text):
    """忽略空白差异的读回比较（contenteditable 渲染会折叠/包裹空白）。"""
    return ''.join(text.split())


def validate_conversation_id(value):
    if not isinstance(value, str) or not CONVERSATION_ID_PATTERN.match(value):
        raise ToolError('INPUT', 'conversation must be a ChatGPT conversation id', 2)
    return value


def conversation_url(conversation_id):
    return CHATGPT_URL + 'c/' + conversation_id


def extract_conversation_id(url):
    if not isinstance(url, str):
        return None
    match = CONVERSATION_URL_PATTERN.search(url)
    return match.group(1) if match else None


def launch_options(mode):
    """唯一的启动参数出口：两种模式都 headed；ask 模式窗口移出屏幕。"""
    return {'headless': False,
            'args': ['--window-position=' + OFFSCREEN_POSITION] if mode == 'ask' else []}


def resolve_prompt(args, stdin_text=''):
    prompt = args.prompt if args.prompt is not None else stdin_text
    validate_prompt(prompt)
    return prompt


def build_parser():
    parser = argparse.ArgumentParser(
        prog='chatgpt_headless.py',
        description='Background ChatGPT web driver (off-screen headed window; never headless)')
    parser.add_argument('mode', choices=['login', 'ask'])
    parser.add_argument('--prompt', help='prompt text; ask mode falls back to stdin when omitted')
    parser.add_argument('--conversation', help='continue an existing conversation (chatgpt.com/c/<id>)')
    parser.add_argument('--profile', default=str(DEFAULT_PROFILE),
                        help='persistent Chromium profile directory (login state stays here)')
    parser.add_argument('--channel', choices=['chrome', 'msedge', 'chromium'], default=DEFAULT_CHANNEL,
                        help='browser engine; use a real installed browser (chrome/msedge) for Google/Cloudflare login')
    parser.add_argument('--timeout', type=float, default=None, help='override mode timeout in seconds')
    return parser


def parse_args(argv=None):
    try:
        args = build_parser().parse_args(argv)
    except SystemExit:
        raise ToolError('INPUT', 'Invalid command line arguments', 2)
    if args.timeout is not None and args.timeout <= 0:
        raise ToolError('INPUT', 'timeout must be positive', 2)
    return args


def read_stdin():
    try:
        return sys.stdin.read() or ''
    except Exception:
        return ''


def launch_context(profile, mode, channel=DEFAULT_CHANNEL):
    """启动浏览器的唯一入口（测试用假 factory 替换）。Playwright 延迟导入，
    非 Windows 测试环境无需安装 playwright 即可导入本模块。
    默认用真实 Chrome（channel='chrome'）而非自带的 chromium，因为后者带自动化
    特征，Google 登录会报"此浏览器或应用可能不安全"。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise ToolError('DEPENDENCY', 'Playwright is required on the Windows host', 6)
    # Chrome 无法从 UNC 路径（WSL 映射的 cwd）启动会立即退出，先切到 Windows 本地目录
    import os
    cwd = os.getcwd()
    if os.name == 'nt' and cwd.startswith('\\\\'):
        os.chdir(os.path.dirname(str(Path(profile).expanduser())) or 'C:\\')
    playwright = sync_playwright().start()
    try:
        context = playwright.chromium.launch_persistent_context(
            str(Path(profile).expanduser()), channel=channel, **launch_options(mode))
    except Exception:
        playwright.stop()
        raise
    return playwright, context


def read_replies(page):
    raw = page.evaluate(READ_REPLIES_JS)
    try:
        value = json.loads(raw or '{}')
    except ValueError:
        raise ToolError('AGENT', 'Reply extraction returned an unexpected shape', 6)
    text, count = value.get('text'), value.get('count')
    if not isinstance(text, str) or not isinstance(count, int) or count < 0:
        raise ToolError('AGENT', 'Reply extraction returned an unexpected shape', 6)
    return {'text': text, 'count': count}


def wait_for_editor(page, timeout, poll):
    deadline = time.monotonic() + timeout
    while True:
        try:
            state = page.evaluate(FIND_EDITOR_JS)
        except Exception:  # 页面导航/Cloudflare 中间页期间求值可能抛错，继续轮询直到超时
            state = 'none'
        if state == 'found':
            return
        if state == 'ambiguous':
            raise ToolError('AGENT', 'Expected exactly one visible ChatGPT composer', 6)
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'ChatGPT composer did not appear before deadline', 7)
        time.sleep(poll)


def submit_prompt(page, prompt):
    try:
        focused = page.evaluate(FOCUS_EDITOR_JS)
    except Exception:
        focused = None
    if focused != 'focused':
        raise ToolError('AGENT', 'Expected exactly one focusable ChatGPT composer', 6)
    page.keyboard.insert_text(prompt)
    entered = page.evaluate(READ_EDITOR_JS)
    if not isinstance(entered, str) or normalize(entered) != normalize(prompt):
        raise ToolError('INPUT', 'Composer readback differs; prompt was not entered safely', 4)
    baseline = read_replies(page)  # 提交前采样，回复计数必须超过它
    try:
        submitted = page.evaluate(SUBMIT_EDITOR_JS)
    except Exception:
        submitted = 'no-submit'
    if submitted != 'clicked':
        page.keyboard.press('Enter')
    return baseline


def wait_for_reply(page, baseline, timeout, poll):
    """完成判定：停止生成按钮消失 + 回复数超过提交前基线 + 文本连续两次轮询稳定。"""
    deadline = time.monotonic() + timeout
    previous = None
    while True:
        try:
            generating = bool(page.evaluate(STOP_ACTIVE_JS))
            snapshot = read_replies(page)
        except Exception:  # 轮询期间的瞬时求值失败按"仍在生成"处理，最终由超时兜底
            generating, snapshot = True, None
        if not generating and snapshot:
            if snapshot['count'] > baseline['count'] and snapshot['text'] and snapshot['text'] == previous:
                return snapshot['text']
            previous = snapshot['text'] or None
        if time.monotonic() >= deadline:
            raise ToolError('TIMEOUT', 'Assistant reply was not detected before deadline', 7)
        time.sleep(poll)


def open_page(context, target):
    page = context.pages[0] if context.pages else context.new_page()
    page.goto(target, wait_until='domcontentloaded', timeout=PAGE_LOAD_TIMEOUT_MS)
    return page


def run_login(args, context_factory=None, poll=POLL_INTERVAL_SECONDS):
    """一次性登录：弹可见窗口（不设 window-position），阻塞等待用户手动登录完成。"""
    factory = context_factory or launch_context
    playwright, context = factory(args.profile, 'login', args.channel)
    try:
        page = open_page(context, CHATGPT_URL)
        deadline = time.monotonic() + (args.timeout or LOGIN_TIMEOUT_SECONDS)
        while time.monotonic() < deadline:
            try:
                logged_in = bool(page.evaluate(LOGGED_IN_JS))
            except Exception:
                logged_in = False
            if logged_in:
                print(json.dumps({'status': 'ok', 'loggedIn': True}, ensure_ascii=False))
                return 0
            time.sleep(poll)
        raise ToolError('TIMEOUT', 'Login was not detected before deadline', 7)
    finally:
        context.close()
        playwright.stop()


def run_ask(args, prompt, context_factory=None, poll=POLL_INTERVAL_SECONDS,
            editor_timeout=EDITOR_WAIT_SECONDS, reply_timeout=None):
    conversation_id = validate_conversation_id(args.conversation) if args.conversation else None
    target = conversation_url(conversation_id) if conversation_id else CHATGPT_URL
    log('chatgpt-headless: navigating ' + target)
    factory = context_factory or launch_context
    playwright, context = factory(args.profile, 'ask', args.channel)
    try:
        page = open_page(context, target)
        wait_for_editor(page, editor_timeout, poll)
        baseline = submit_prompt(page, prompt)
        log('chatgpt-headless: prompt submitted; waiting for reply')
        timeout = reply_timeout if reply_timeout is not None else (args.timeout or ASK_TIMEOUT_SECONDS)
        reply = wait_for_reply(page, baseline, timeout, poll)
        print(json.dumps({'status': 'ok', 'conversationId': extract_conversation_id(page.url),
                          'reply': reply, 'url': page.url}, ensure_ascii=False))
        return 0
    finally:
        context.close()
        playwright.stop()


def main(argv=None):
    args = parse_args(argv)
    if args.mode == 'login':
        return run_login(args)
    stdin_text = '' if args.prompt is not None else read_stdin()
    return run_ask(args, resolve_prompt(args, stdin_text))


if __name__ == '__main__':
    sys.exit(entry(main))
