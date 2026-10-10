#!/usr/bin/env python3
"""Approved Codex send with project-route and local-environment guards."""
import hashlib
import json
import os
import sys
from pathlib import Path

from clipboard_paste import paste_text
from desktop_common import Cdp, ToolError, config, entry, find_target, guard_write, validate_prompt
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
    force_clear='--force-clear' in args;prompt=' '.join(arg for arg in args if arg!='--force-clear')
    validate_prompt(prompt)
    digest=hashlib.sha256(prompt.encode()).hexdigest()
    if authority is None: raise ToolError('AUTH','Trusted host authority required')
    authority.consume(bridge_receipt,'verified-chatgpt-prompt',digest)
    guard_write('codex_send_cdp.py',authority,approval,digest,binding_fingerprint(target_context))
    connection=Cdp(find_codex_shell_compat())
    try:
        _require_route(connection,target_context,authority,route_repair_approval)
        if connection.evaluate(FIND_COMPOSER)!='focused': raise ToolError('AGENT','Expected exactly one focused Codex composer')
        metadata_reader=codex_metadata_reader or ((lambda:codex_metadata) if codex_metadata is not None else (lambda:_load_metadata(target_context)))
        metadata=metadata_reader()
        _require_local(connection,target_context,metadata,metadata_reader)
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
        print(json.dumps({'ok':True,'status':'success','submitted':True,'route':'verified',
                          'executionEnvironment':'local-codex','executionVerified':False},ensure_ascii=False))
        return 0
    finally: connection.close()


if __name__=='__main__': sys.exit(entry(main))
