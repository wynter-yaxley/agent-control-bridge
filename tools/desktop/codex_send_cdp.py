#!/usr/bin/env python3
"""Approved Codex send with project-route and local-environment guards."""
import hashlib
import json
import os
import sys
from pathlib import Path

from clipboard_paste import paste_text
from desktop_common import Cdp, DesktopLock, ToolError, config, entry, find_target, guard_write, validate_prompt
from desktop_guards import (binding_fingerprint, guard_local_codex_execution,
    guard_project_route, read_codex_app_binding, read_execution_environment,
    read_project_route, repair_project_route)


FIND_COMPOSER = r"""
(() => {
 const eds=[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;});
 if(eds.length!==1)return eds.length?'ambiguous':'no-editor';eds[0].focus();return document.activeElement===eds[0]?'focused':'focus-failed';
})()
"""
READ_COMPOSER = r"""
(() => {
 const eds=[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;});
 return eds.length===1?eds[0].textContent:null;
})()
"""
CLEAR_COMPOSER = r"""
(() => {
 const eds=[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;});
 if(eds.length!==1)return 'ambiguous';eds[0].replaceChildren();eds[0].dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));return 'cleared';
})()
"""
READ_MESSAGES_JS = r"""
(() => {
  const all = document.querySelectorAll('H4.sr-only');
  const msgs = [];
  all.forEach(h => {
    const t = h.textContent.trim();
    let role = 'unknown';
    if (t.includes('你说') || t.includes('你：')) role = 'user';
    else if (t.includes('ChatGPT')) role = 'assistant';
    if (role === 'unknown') return;
    const block = h.parentElement;
    if (!block) return;
    const fullText = block.innerText;
    const roleText = (h.innerText || h.textContent).trim();
    let body = fullText;
    const start = fullText.indexOf(roleText);
    if (start === 0) body = fullText.slice(roleText.length);
    else if (start > 0 && start < 64) body = fullText.slice(start + roleText.length);
    body = body.trim();
    if (body) msgs.push({role, text: body, sourceMessageId: block.getAttribute('data-message-id') || null});
  });
  return JSON.stringify({messages: msgs, diagnostics: {nodesScanned: all.length, messagesFound: msgs.length}});
})()
"""


def _read_messages(connection):
    raw=connection.evaluate(READ_MESSAGES_JS)
    try: value=json.loads(raw) if isinstance(raw,str) else raw
    except (ValueError,TypeError): return None
    if not isinstance(value,dict) or not isinstance(value.get('messages'),list): return None
    return value

def _normalize_text(s):
    """归一化：折叠所有空白，用于容忍 DOM 渲染的换行/空白差异。"""
    import re
    return re.sub(r'\s+', ' ', (s or '')).strip()

def _verify_submission(connection,prompt,baseline,timeout_ms=3000):
    """提交后轮询验证：出现内容匹配 prompt 的新 user 消息才算提交成功。

    baseline 是提交前的消息列表（用于判断「新」）。内容用归一化比较（折叠空白），
    不逐字符相等——DOM 渲染会改变 Markdown/换行，逐字符相等会把成功提交误判为
    失败从而诱发重复发送。内容不精确匹配时降级为 unverified 而非 mismatch。
    """
    import time
    deadline=time.monotonic()+timeout_ms/1000.0
    prompt_norm=_normalize_text(prompt)
    baseline_ids={m.get('sourceMessageId') for m in baseline if m.get('sourceMessageId')}
    baseline_texts={_normalize_text(m.get('text')) for m in baseline}
    while time.monotonic()<deadline:
        result=_read_messages(connection)
        if result is None:
            time.sleep(0.4); continue
        for m in result.get('messages',[]):
            if m.get('role')!='user': continue
            text_norm=_normalize_text(m.get('text'))
            mid=m.get('sourceMessageId')
            # 「新」：sourceMessageId 新增，或（无 id 时）文本不在基线里
            is_new=(mid is not None and mid not in baseline_ids) or (text_norm and text_norm not in baseline_texts)
            if not is_new: continue
            if text_norm and (text_norm==prompt_norm or text_norm.startswith(prompt_norm) or prompt_norm.startswith(text_norm)):
                return 'verified'
            # 新 user 消息已出现但内容不精确匹配（可能是渲染差异），不报 mismatch
            return 'unverified'
        time.sleep(0.4)
    return 'unverified'


def find_codex_shell_compat(): return find_target('page')


def _require_route(connection,target_context,authority=None,repair_approval=None):
    evidence=read_project_route(connection);repair=None
    if evidence and evidence.get('listKind')=='recent' and repair_approval is not None:
        repair=lambda expected,observed:repair_project_route(connection,expected,observed,authority,repair_approval)
    result=guard_project_route(target_context,evidence,repair=repair,provider='codex')
    if result.get('status')!='success':
        raise ToolError(result.get('code','PROJECT_ROUTE_BLOCKED'),result.get('reason','Conversation route could not be verified'),
                        6,status=result.get('status','blocked'),details=result)
    return result


def _load_metadata(target_context, state_path=None):
    if state_path is None:
        config()
        config_path=Path(os.environ.get('ACB_CONFIG',Path(__file__).resolve().parents[2]/'.bridge.config.json')).resolve()
        try:
            raw=json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}
            configured=raw.get('agents',{}).get('codex',{}).get('statePath')
            if configured:
                candidate=Path(configured)
                state_path=candidate if candidate.is_absolute() else config_path.parent/candidate
        except (OSError,ValueError,TypeError,AttributeError):
            pass
        code_home=os.environ.get('ACB_CODEX_HOME')
        if code_home:
            state_path=Path(code_home)/'.codex-global-state.json'
    return read_codex_app_binding(target_context,state_path)


def _require_local(connection,target_context,metadata,metadata_reader=None,reread=True):
    snapshot=read_execution_environment(connection)
    refresh=(lambda:read_execution_environment(connection)) if reread else None
    result=guard_local_codex_execution(target_context,snapshot,metadata,reread=refresh,metadata_reread=metadata_reader)
    if result.get('status')!='success':
        raise ToolError(result.get('code','EXECUTION_ENVIRONMENT_UNKNOWN'),result.get('reason','Local Codex environment could not be verified'),
                        6,status=result.get('status','blocked'),details=result)
    return result


def main(authority=None, approval=None, bridge_receipt=None, target_context=None,
         route_repair_approval=None, clipboard=None, codex_metadata=None, codex_metadata_reader=None):
    if '--help' in sys.argv:
        print('Trusted host API only; local Codex target, project, workspace, and execution mode must be verified.'); return 0
    if not isinstance(target_context,dict): raise ToolError('PROVENANCE','Trusted bridge project/thread mapping required')
    if bridge_receipt is None: raise ToolError('PROVENANCE','Codex requires a host-verified ChatGPT generation receipt')
    args=sys.argv[1:]
    if not args: raise ToolError('INPUT','Prompt is required',2)
    # --force-clear 仅在首参数位置作为命令选项；-- 之后的内容一律视为 prompt 正文
    force_clear = args[0] == '--force-clear'
    if force_clear: args = args[1:]
    if args and args[0] == '--': args = args[1:]
    prompt=' '.join(args)
    if not prompt: raise ToolError('INPUT','Prompt is required',2)
    validate_prompt(prompt)
    digest=hashlib.sha256(prompt.encode()).hexdigest()
    if authority is None: raise ToolError('AUTH','Trusted host authority required')
    authority.consume(bridge_receipt,'verified-chatgpt-prompt',digest)
    guard_write('codex_send_cdp.py',authority,approval,digest,binding_fingerprint(target_context))
    connection=Cdp(find_codex_shell_compat())
    lock=None
    try:
        _require_route(connection,target_context,authority,route_repair_approval)
        if connection.evaluate(FIND_COMPOSER)!='focused': raise ToolError('AGENT','Expected exactly one focused Codex composer')
        metadata_reader=codex_metadata_reader or ((lambda:codex_metadata) if codex_metadata is not None else (lambda:_load_metadata(target_context)))
        metadata=metadata_reader()
        _require_local(connection,target_context,metadata,metadata_reader)
        # 串行化共享 composer 的写操作（防并发 TOCTOU）
        lock=DesktopLock(); lock.acquire()
        # 提交前记录消息基线（消息列表），用于提交后验证新消息出现；读取失败 fail-closed
        baseline=_read_messages(connection)
        if baseline is None: raise ToolError('AGENT','Could not read the message baseline before submission',6)
        current=connection.evaluate(READ_COMPOSER)
        if not isinstance(current,str): raise ToolError('AGENT','Codex composer contents could not be read')
        if current.strip():
            if not force_clear: raise ToolError('DRAFT_PRESENT','Codex composer contains a draft; it was preserved')
            if connection.evaluate(CLEAR_COMPOSER)!='cleared': raise ToolError('AGENT','Could not safely clear the approved composer')
        paste_text(connection,{'kind':'codex-composer'},prompt,clipboard=clipboard)
        if connection.evaluate(READ_COMPOSER)!=prompt:
            raise ToolError('PASTE_MISMATCH','Codex composer readback differs; prompt was not sent',4,status='verification_failed')
        # Recheck both session ownership and actual local execution mode directly
        # before commit to close the UI-switch/TOCTOU window.
        _require_route(connection,target_context,authority,route_repair_approval)
        _require_local(connection,target_context,metadata,metadata_reader)
        if connection.evaluate(READ_COMPOSER)!=prompt:
            raise ToolError('PASTE_MISMATCH','Codex composer changed before submission',4,status='verification_failed')
        for event in (
            {'type':'keyDown','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13},
            {'type':'keyUp','key':'Enter','code':'Enter','windowsVirtualKeyCode':13,'nativeVirtualKeyCode':13},
        ):
            connection.call('Input.dispatchKeyEvent',event)
        # 提交后验证：新消息（身份+内容）匹配才算提交成功（composer 清空仅辅助证据）
        verification=_verify_submission(connection,prompt,baseline.get('messages',[]))
        submission_verified = verification=='verified'
        print(json.dumps({'ok':submission_verified,
                          'status':'success' if submission_verified else 'submission_unverified',
                          'submitted':True,
                          'submissionVerified':submission_verified,
                          'route':'verified',
                          'executionEnvironment':'local-codex',
                          'executionVerified':False},ensure_ascii=False))
        return 0 if submission_verified else 6
    finally:
        if lock: lock.release()
        connection.close()


if __name__=='__main__': sys.exit(entry(main))
