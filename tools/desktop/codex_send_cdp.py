#!/usr/bin/env python3
# codex_send_cdp.py — Windows 侧执行，CDP 向 Codex 桌面可见 composer 注入并提交
# 契约：
#   - 空提示词 → exit 2（不碰 composer）
#   - composer 非空（含未发送草稿）且无 --force-clear → exit 3（不碰草稿，调用方可决定清空）
#   - composer 非空 + --force-clear → 先清空再注入
#   - 注入后严格相等验证，mismatch → exit 4（不提交）
import sys
import json
import urllib.request
from desktop_common import Cdp, find_target, guard_write, entry, ToolError, validate_prompt



FIND_COMPOSER = """
(() => {
  const eds = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')];
  const visible = eds.find(e => {
    const r = e.getBoundingClientRect();
    return e.offsetParent !== null && r.width > 0 && r.height > 0;
  });
  if (!visible) return 'no-editor';
  visible.focus();
  return 'focused';
})()
"""

READ_COMPOSER = """
(() => {
  const eds = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')];
  const e = eds.find(x => { const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; });
  return e ? e.textContent : '';
})()
"""

CLEAR_COMPOSER = """
(() => {
  const eds = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')];
  const e = eds.find(x => { const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; });
  if (!e) return 'no-editor';
  e.textContent = '';
  e.dispatchEvent(new InputEvent('input', {bubbles: true, data: '', inputType: 'deleteContentBackward'}));
  return 'cleared';
})()
"""


def find_codex_shell_compat():
    return find_target("page")


def main(authority=None, approval=None, bridge_receipt=None):
    if '--help' in sys.argv:
        print('Use trusted host API with one-time approval; CLI sending is blocked. No model is invoked by help.'); return 0
    if bridge_receipt is None: raise ToolError('PROVENANCE','Codex requires a host-verified ChatGPT generation receipt')
    if len(sys.argv) < 2:
        print("用法: codex_send_cdp.py <提示词> [--force-clear]")
        sys.exit(2)
    args = sys.argv[1:]
    force_clear = "--force-clear" in args
    prompt = " ".join(a for a in args if a != "--force-clear")
    validate_prompt(prompt)
    if not prompt.strip():
        print(json.dumps({"error": "空提示词，拒绝执行（不碰 composer）"}, ensure_ascii=False))
        sys.exit(2)

    import hashlib
    digest = hashlib.sha256(prompt.encode()).hexdigest()
    if authority is None: raise ToolError('AUTH','Trusted host authority required')
    authority.consume(bridge_receipt, 'verified-chatgpt-prompt', digest)
    guard_write('codex_send_cdp.py', authority, approval, digest)
    ws_url = find_codex_shell_compat()
    if not ws_url:
        print(json.dumps({"error": "未找到 Codex shell target"}, ensure_ascii=False))
        sys.exit(2)

    connection = Cdp(ws_url)
    try:
        ws = connection
        pending = [None]
        def send(method, params): pending[0] = (method, params)
        def recv(): return connection.call(*pending[0])
        def evaljs(js): return connection.evaluate(js)

        # 1. focus composer
        if evaljs(FIND_COMPOSER) != "focused":
            print(json.dumps({"error": "未找到 Codex composer"}, ensure_ascii=False))
            sys.exit(3)

        # 2. 检查 composer 是否非空（含未发送草稿）
        cur = evaljs(READ_COMPOSER)
        if cur.strip():
            if not force_clear:
                print(json.dumps({"error": "composer 非空（含未发送草稿），未触碰；如需清空加 --force-clear"}, ensure_ascii=False))
                sys.exit(3)
            evaljs(CLEAR_COMPOSER)

        # 3. 注入（Input.insertText，ProseMirror 监听 beforeinput）
        send("Input.insertText", {"text": prompt})
        recv()

        # 4. 严格相等验证；mismatch 则 abort，不提交
        txt = evaljs(READ_COMPOSER)
        if txt != prompt:
            print(json.dumps({"error": "注入 mismatch，中止提交（未按 Enter）"}, ensure_ascii=False))
            sys.exit(4)
        print(json.dumps({"inject": "ok"}, ensure_ascii=False))

        # 5. Enter 提交
        send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
        recv()
        send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
        recv()

        print(json.dumps({"ok": True,"submitted":True,"executionVerified":False}, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(entry(main))
