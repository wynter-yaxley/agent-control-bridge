#!/usr/bin/env python3
# gpt_send_cdp.py — Windows 侧执行，CDP 向 ChatGPT 输入框注入提示词并提交
# 流程：找输入框 → 若无则点"新聊天"并等输入框出现 → 注入 → 发送
import sys
import json
import time
import urllib.request
from desktop_common import Cdp, find_target, guard_write, entry, ToolError, validate_prompt



CLICK_NEW_CHAT = """
(() => {
  const btn = [...document.querySelectorAll('a,button')].find(e => /新聊天|新对话|New chat/i.test(e.textContent||''));
  if (btn) { btn.click(); return 'clicked'; }
  return 'no-btn';
})()
"""

CHECK_EDITOR = """
(() => {
  const eds = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea')];
  const e = eds.find(x => { const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; });
  return e ? 'found' : 'none';
})()
"""


def find_target_compat():
    return find_target("webview")


def main(authority=None, approval=None, bridge_receipt=None):
    if '--help' in sys.argv:
        print('Use trusted host API with one-time approval; CLI sending is blocked. No model is invoked by help.'); return 0
    guard_write('gpt_send_cdp.py', authority, approval)
    if len(sys.argv) < 2:
        print("用法: gpt_send_cdp.py <提示词> [--force-clear]")
        sys.exit(2)
    args = sys.argv[1:]
    force_clear = "--force-clear" in args
    prompt = " ".join(a for a in args if a != "--force-clear")
    # 入口拒空：空串/纯空白直接拒绝
    if not prompt.strip():
        print(json.dumps({"error": "空提示词，拒绝执行"}, ensure_ascii=False))
        sys.exit(2)
    validate_prompt(prompt)
    js_prompt = json.dumps(prompt)

    ws_url = find_target_compat()
    if not ws_url:
        print(json.dumps({"error": "未找到 ChatGPT target"}, ensure_ascii=False))
        sys.exit(2)

    connection = Cdp(ws_url)
    try:
        ws = connection
        pending = [None]
        def send(method, params): pending[0] = (method, params)
        def recv(): return connection.call(*pending[0])
        def evaljs(js): return connection.evaluate(js)

        # 1. 确保有输入框：若无则点新聊天，轮询等输入框
        if evaljs(CHECK_EDITOR) != "found":
            clicked = evaljs(CLICK_NEW_CHAT)
            for _ in range(20):  # 最多 ~20 秒
                time.sleep(1)
                if evaljs(CHECK_EDITOR) == "found":
                    break
        if evaljs(CHECK_EDITOR) != "found":
            print(json.dumps({"error": "等待后仍无输入框（新对话未加载）"}, ensure_ascii=False))
            sys.exit(3)

        # 2. 检查输入框是否非空（含未发送草稿）；非空且无 force-clear 则拒绝
        read_editor = """
        (() => {
          const eds = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea')];
          const e = eds.find(x => { const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; });
          return e ? e.textContent : '';
        })()
        """
        cur = evaljs(read_editor)
        if cur.strip():
            if not force_clear:
                print(json.dumps({"error": "输入框非空（含未发送草稿），未触碰；如需清空加 --force-clear"}, ensure_ascii=False))
                sys.exit(3)
            clear_js = """
            (() => {
              const eds = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea')];
              const e = eds.find(x => { const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; });
              if (!e) return 'no-editor';
              e.textContent = '';
              e.dispatchEvent(new InputEvent('input', {bubbles: true, data: '', inputType: 'deleteContentBackward'}));
              return 'cleared';
            })()
            """
            evaljs(clear_js)

        # 3. 注入（不清空，因上一步已确认空或已 force-clear）
        inject_js = f"""
        (() => {{
          const eds = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea')];
          const editor = eds.find(x => {{ const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; }});
          if (!editor) return 'no-editor';
          editor.focus();
          const ok = document.execCommand('insertText', false, {js_prompt});
          editor.dispatchEvent(new InputEvent('input', {{bubbles: true, data: {js_prompt}, inputType: 'insertText'}}));
          return ok ? 'ok:' + editor.textContent : 'failed';
        }})()
        """
        val = evaljs(inject_js)
        print(json.dumps({"inject": "checked"}))
        if val == "no-editor":
            sys.exit(3)
        # 严格相等验证：注入后 editor 文本须 == prompt，否则 abort 不发送
        if not val.startswith("ok:") or val[3:].strip() != prompt.strip():
            print(json.dumps({"error": "注入 mismatch，中止发送"}, ensure_ascii=False))
            sys.exit(4)

        # 3. 发送
        submit_js = """
        (() => {
          const btn = document.querySelector('[data-testid="send-button"], button[aria-label*="发送"], button[aria-label*="Send"]');
          if (btn) { btn.click(); return 'clicked'; }
          const eds = [...document.querySelectorAll('#prompt-textarea, div[contenteditable="true"], textarea')];
          const editor = eds.find(x => { const r = x.getBoundingClientRect(); return x.offsetParent !== null && r.width > 0 && r.height > 0; });
          if (editor) { editor.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13})); return 'enter'; }
          return 'no-submit';
        })()
        """
        submitted = evaljs(submit_js)
        if submitted not in ('clicked','enter'): raise ToolError('EXECUTION','No submit control found')
        print(json.dumps({'submit':submitted,'executionVerified':False}, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == "__main__":
    sys.exit(entry(main))
