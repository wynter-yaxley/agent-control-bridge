"""Prepare and verify ChatGPT renames; a human must commit with physical Enter."""
import hashlib
import json
import sys
import time

from desktop_common import Cdp, ToolError, entry, find_target, guard_write, redact, RENAME_WAIT_SECONDS


def _js(target_id, operation, new_title=None):
    """Build a target-ID-bound UI read, open, or native value-setter + input-event sync."""
    value=json.dumps(target_id,separators=(',',':'))
    title=json.dumps(new_title,separators=(',',':'),ensure_ascii=False)
    body={
      'READ': '',
      'OPEN': r"""if(input.length===0){
 const menus=[...row.querySelectorAll('button[aria-haspopup="menu"],button[data-action="conversation-menu"]')].filter(visible);
 if(menus.length!==1)return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:false,openResult:'menu-unsupported'});
 menus[0].click();
 const items=[...document.querySelectorAll('[role="menuitem"]')].filter(visible).filter(e=>/^(rename|重命名)$/i.test((e.getAttribute('aria-label')||e.textContent||'').trim()));
 if(items.length!==1)return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:false,openResult:'rename-action-unsupported'});
 items[0].click();
 }""",
      'SET': r"""if(input.length!==1||!(input[0] instanceof HTMLInputElement||input[0] instanceof HTMLTextAreaElement))
   return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:input.length===1,writeError:'editable-control-unsupported'});
 const control=input[0];
 const setter=control instanceof HTMLInputElement
   ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
   : Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
 if(typeof setter!=='function')return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:true,writeError:'native-value-setter-unavailable'});
 control.focus();
 if(document.activeElement!==control)return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:true,writeError:'rename-input-focus-failed'});
 setter.call(control,requestedTitle);
 control.dispatchEvent(new Event('input', { bubbles: true }));
 return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:true,editorValue:control.value,inputEventDispatched:true,focused:document.activeElement===control});""",
    }.get(operation)
    if body is None:
        raise ToolError('INPUT','Unsupported rename UI operation',2)
    return r"""/* ACB_RENAME_%s */
(() => {
 const id=%s;
 const requestedTitle=%s;
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const rows=[...document.querySelectorAll('[data-conversation-id]')].filter(e=>e.dataset.conversationId===id&&visible(e));
 if(rows.length!==1)return JSON.stringify({conversationId:id,found:false,ambiguous:rows.length>1});
 const row=rows[0];
 const input=[...row.querySelectorAll('input[aria-label="Rename"],input[aria-label="重命名"],input[data-rename-input],textarea[aria-label="Rename"],textarea[aria-label="重命名"],textarea[data-rename-input]')].filter(visible);
 const titleNode=row.querySelector('[data-conversation-title], [data-testid="conversation-title"]');
 const title=(titleNode&&(titleNode.dataset.conversationTitle||titleNode.textContent)||row.dataset.title||'').trim();
 %s
 return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:input.length===1,
   editorValue:input.length===1?input[0].value:null,rowTitle:title,focused:input.length===1&&document.activeElement===input[0]});
})()
""" % (operation, value, title, body)


def _read_state(connection, conversation_id, state_reader=None):
    try:
        value=state_reader() if state_reader is not None else connection.evaluate(_js(conversation_id,'READ'))
        if isinstance(value,str): value=json.loads(value)
        return value if isinstance(value,dict) else {}
    except Exception:
        return {}


def _valid_title(title):
    return isinstance(title,str) and bool(title.strip()) and len(title)<=200 and '\x00' not in title and redact(title)==title


def rename_session(connection, conversation_id, new_title,
                   state_reader=None, write_operation=None, action=None,
                   max_wait_seconds=RENAME_WAIT_SECONDS):
    """Prepare a rename and hand off its final physical-Enter commit to a human."""
    if not isinstance(conversation_id,str) or not conversation_id.strip():
        return {'status':'blocked','code':'TARGET_MISSING','renameState':'rename failed','error':'Target conversation identity is required'}
    if not _valid_title(new_title):
        return {'status':'blocked','code':'TITLE_INVALID','renameState':'rename failed','error':'New title must contain 1..200 safe characters with non-blank content'}

    initial=_read_state(connection,conversation_id,state_reader)
    if initial.get('conversationId')!=conversation_id:
        return {'status':'blocked','code':'TARGET_MISMATCH','renameState':'rename failed','error':'Target conversation row could not be uniquely verified'}
    old_title=initial.get('oldTitle')
    if not isinstance(old_title,str) or not old_title:
        return {'status':'verification_failed','code':'ORIGINAL_TITLE_UNKNOWN','renameState':'rename failed','error':'Original title could not be read safely'}
    if initial.get('editing') is not True:
        try:
            opened=action('OPEN') if action else connection.evaluate(_js(conversation_id,'OPEN'))
            if isinstance(opened,str): opened=json.loads(opened)
        except Exception:
            opened={}
        deadline=time.monotonic()+max(0.05,min(float(max_wait_seconds),2.0))
        while True:
            initial=_read_state(connection,conversation_id,state_reader)
            if initial.get('conversationId')!=conversation_id or initial.get('oldTitle')!=old_title:
                return {'status':'blocked','code':'UI_CHANGED','renameState':'rename failed','error':'Target changed while opening rename controls','oldTitle':old_title}
            if initial.get('editing') is True or time.monotonic()>=deadline: break
            time.sleep(0.05)
        if initial.get('editing') is not True:
            return {'status':'unsupported','code':'RENAME_UI_UNSUPPORTED','renameState':'rename failed',
                    'error':(opened or {}).get('openResult','No supported rename control is available'),'oldTitle':old_title}

    before_write=_read_state(connection,conversation_id,state_reader)
    if before_write.get('conversationId')!=conversation_id or before_write.get('editing') is not True:
        return {'status':'blocked','code':'RENAME_TARGET_CHANGED','renameState':'rename failed',
                'error':'Target identity or rename editor changed before writing','oldTitle':old_title,'lastState':before_write}
    try:
        write_result=write_operation(connection,conversation_id,new_title) if write_operation else connection.evaluate(_js(conversation_id,'SET',new_title))
        if isinstance(write_result,str): write_result=json.loads(write_result)
    except Exception:
        return {'status':'verification_failed','code':'RENAME_WRITE_FAILED','renameState':'rename failed',
                'error':'Native value setter operation failed; no commit was attempted','oldTitle':old_title,
                'lastState':_read_state(connection,conversation_id,state_reader)}
    if not isinstance(write_result,dict) or write_result.get('conversationId')!=conversation_id or write_result.get('found') is not True or write_result.get('inputEventDispatched') is not True or write_result.get('focused') is not True or write_result.get('editorValue')!=new_title:
        return {'status':'verification_failed','code':'RENAME_WRITE_UNVERIFIED','renameState':'rename failed',
                'error':'Native setter or immediate DOM readback did not verify the exact requested title',
                'oldTitle':old_title,'lastState':write_result if isinstance(write_result,dict) else {}}

    typed=_read_state(connection,conversation_id,state_reader)
    if typed.get('conversationId')!=conversation_id or typed.get('editing') is not True or typed.get('focused') is not True or typed.get('editorValue')!=new_title:
        return {'status':'verification_failed','code':'RENAME_INPUT_MISMATCH','renameState':'rename failed',
                'error':'A fresh DOM read did not show the exact requested value in the target editor; commit was not attempted',
                'oldTitle':old_title,'lastState':typed}
    return {'status':'awaiting_human_enter','code':'RENAME_PREPARED','renameState':'awaiting human Enter',
            'conversationId':conversation_id,'oldTitle':old_title,'preparedTitle':new_title,
            'inputValueVerified':True,'commit':'User must press physical Enter in the target rename input',
            'saved':False}


def verify_rename_session(connection, conversation_id, expected_title, state_reader=None):
    """Read-only confirmation to call after the user physically presses Enter."""
    if not isinstance(conversation_id,str) or not conversation_id.strip() or not _valid_title(expected_title):
        return {'status':'blocked','code':'VERIFY_INPUT_INVALID','renameState':'rename failed','error':'A verified conversation identity and safe expected title are required'}
    first=_read_state(connection,conversation_id,state_reader)
    if first.get('conversationId')!=conversation_id:
        return {'status':'verification_failed','code':'TARGET_MISMATCH','renameState':'rename failed','error':'Target conversation identity could not be verified','lastState':first}
    if first.get('editing') is True:
        if first.get('editorValue')==expected_title:
            return {'status':'awaiting_human_enter','code':'AWAITING_HUMAN_ENTER','renameState':'awaiting human Enter','saved':False,'lastState':first}
        return {'status':'verification_failed','code':'EDITOR_VALUE_MISMATCH','renameState':'rename failed','error':'The active editor does not contain the requested title','lastState':first}
    if first.get('rowTitle')!=expected_title:
        return {'status':'verification_failed','code':'RENAME_NOT_CONFIRMED','renameState':'rename failed','error':'Application row title has not changed to the requested title','lastState':first}
    second=_read_state(connection,conversation_id,state_reader)
    if second.get('conversationId')!=conversation_id or second.get('editing') is True or second.get('rowTitle')!=expected_title:
        return {'status':'verification_failed','code':'RENAME_CONFIRMATION_UNSTABLE','renameState':'rename failed','error':'A second application read did not confirm the updated title','lastState':second}
    return {'status':'success','code':'RENAME_CONFIRMED','renameState':'rename confirmed','conversationId':conversation_id,
            'newTitle':expected_title,'confirmation':'two fresh application row-title reads after human submission'}


def main(authority=None, approval=None, target_context=None):
    if '--help' in sys.argv:
        print('Prepare: gpt-rename <new-title>. Verify after the user presses physical Enter: gpt-rename --verify <expected-title>. The tool never generates Enter.')
        print('Chat renaming requires a human physical Enter keypress to commit. Automated, synthetic, CDP-generated, or SendKeys Enter events are not reliably accepted by the current ChatGPT desktop application. The tool prepares the rename UI and input value, then hands off the final commit to the user.')
        return 0
    if not isinstance(target_context,dict) or not target_context.get('conversationId'):
        raise ToolError('AUTH','Trusted host target context required')
    verify_mode=len(sys.argv)==3 and sys.argv[1]=='--verify'
    if verify_mode:
        title=sys.argv[2]
    elif len(sys.argv)==2:
        title=sys.argv[1]
    else:
        raise ToolError('INPUT','Supply one new title, or --verify and the expected title',2)
    if not _valid_title(title):
        raise ToolError('INPUT','New title must contain 1..200 safe characters with non-blank content',2)
    digest=hashlib.sha256(title.encode('utf-8')).hexdigest()
    from desktop_guards import binding_fingerprint, guard_project_route, read_project_route
    if verify_mode:
        if authority is None: raise ToolError('AUTH','Trusted host verification handle required')
        authority.consume(approval,'verify_rename_session',digest,binding_fingerprint(target_context))
    else:
        guard_write('rename_session',authority,approval,digest,binding_fingerprint(target_context))
    connection=Cdp(find_target('webview'))
    try:
        route=guard_project_route(target_context,read_project_route(connection),provider='gpt')
        if route.get('status')!='success':
            result={'status':route.get('status','blocked'),'code':route.get('code','PROJECT_ROUTE_BLOCKED'),
                    'renameState':'rename failed','error':route.get('reason','Target route is not verified')}
        elif verify_mode:
            result=verify_rename_session(connection,target_context['conversationId'],title)
        else:
            result=rename_session(connection,target_context['conversationId'],title,write_operation=None)
    finally:
        connection.close()
    print(json.dumps(redact(result),ensure_ascii=False))
    return 0 if result.get('status') in ('success','awaiting_human_enter') else 4


if __name__=='__main__': sys.exit(entry(main))
