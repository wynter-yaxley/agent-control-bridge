#!/usr/bin/env python3
"""Approved visible ChatGPT send with project/session route verification."""
import hashlib
import json
import sys

from clipboard_paste import paste_text
from desktop_common import Cdp, ToolError, entry, find_target, guard_write, validate_prompt
from desktop_guards import binding_fingerprint, guard_project_route, read_project_route, repair_project_route


CHECK_EDITOR = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const eds=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"],textarea')].filter(visible);
 return eds.length===1?'found':(eds.length?'ambiguous':'none');
})()
"""
READ_EDITOR = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const eds=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"],textarea')].filter(visible);
 if(eds.length!==1)return JSON.stringify({found:false});
 const e=eds[0];return e.matches('textarea,input')?e.value:e.textContent;
})()
"""
CLEAR_EDITOR = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const eds=[...document.querySelectorAll('#prompt-textarea,div[contenteditable="true"],textarea')].filter(visible);
 if(eds.length!==1)return 'ambiguous';const e=eds[0];
 if(e.matches('textarea,input')){e.value='';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}
 else{e.replaceChildren();e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));}
 return 'cleared';
})()
"""
SUBMIT_EDITOR = r"""
(() => {
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const buttons=[...document.querySelectorAll('[data-testid="send-button"],button[aria-label*="发送"],button[aria-label*="Send"]')].filter(visible);
 if(buttons.length===1){buttons[0].click();return 'clicked';}
 return buttons.length>1?'ambiguous':'no-submit';
})()
"""


def find_target_compat():
    return find_target('webview')


def _require_route(connection,target_context,authority=None,repair_approval=None):
    evidence=read_project_route(connection)
    repair=None
    if target_context.get('projectId') is not None and evidence and evidence.get('listKind')=='recent' and repair_approval is not None:
        repair=lambda expected,observed:repair_project_route(connection,expected,observed,authority,repair_approval)
    result=guard_project_route(target_context,evidence,repair=repair,provider='gpt')
    if result.get('status')!='success':
        status=result.get('status','blocked')
        raise ToolError(result.get('code','PROJECT_ROUTE_BLOCKED'),result.get('reason','Conversation route could not be verified'),
                        6,status=status,details=result)
    return result


def main(authority=None, approval=None, bridge_receipt=None, target_context=None,
         route_repair_approval=None, clipboard=None):
    if '--help' in sys.argv:
        print('Use the trusted host API with a one-time target-bound approval; CLI sending is blocked.'); return 0
    if not isinstance(target_context,dict): raise ToolError('PROVENANCE','Trusted bridge session mapping required')
    if len(sys.argv)<2: raise ToolError('INPUT','Prompt is required',2)
    args=sys.argv[1:];force_clear='--force-clear' in args
    prompt=' '.join(arg for arg in args if arg!='--force-clear')
    validate_prompt(prompt)
    digest=hashlib.sha256(prompt.encode()).hexdigest()
    if authority is None or bridge_receipt is None: raise ToolError('PROVENANCE','Host-verified prompt receipt required')
    authority.consume(bridge_receipt,'verified-chatgpt-prompt',digest)
    guard_write('gpt_send_cdp.py',authority,approval,digest,binding_fingerprint(target_context))
    connection=Cdp(find_target_compat())
    try:
        # Project route is checked before touching the composer. Recent-list repair
        # is attempted only when the app exposes an ID-bound action and a separate grant.
        _require_route(connection,target_context,authority,route_repair_approval)
        if connection.evaluate(CHECK_EDITOR)!='found':
            raise ToolError('AGENT','Expected exactly one visible ChatGPT composer')
        current=connection.evaluate(READ_EDITOR)
        if not isinstance(current,str): raise ToolError('INPUT','Composer contents could not be read safely')
        if current.strip():
            if not force_clear: raise ToolError('DRAFT_PRESENT','Composer contains an existing draft; it was preserved')
            if connection.evaluate(CLEAR_EDITOR)!='cleared': raise ToolError('INPUT','Could not safely clear the approved composer')
        paste_text(connection,{'kind':'gpt-composer'},prompt,clipboard=clipboard)
        value=connection.evaluate(READ_EDITOR)
        if value!=prompt: raise ToolError('PASTE_MISMATCH','Composer readback differs; prompt was not submitted',4,status='verification_failed')
        # Recheck route after text entry and immediately before the send action.
        _require_route(connection,target_context,authority,route_repair_approval)
        if connection.evaluate(READ_EDITOR)!=prompt:
            raise ToolError('PASTE_MISMATCH','Composer changed before submission',4,status='verification_failed')
        submitted=connection.evaluate(SUBMIT_EDITOR)
        if submitted!='clicked': raise ToolError('EXECUTION','A unique supported submit control was not available')
        print(json.dumps({'ok':True,'status':'success','submit':submitted,'route':'verified',
                          'executionVerified':False},ensure_ascii=False))
        return 0
    finally:
        connection.close()


if __name__=='__main__': sys.exit(entry(main))
