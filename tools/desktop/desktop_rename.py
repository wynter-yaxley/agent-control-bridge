"""One-shot, verified rename operation over the existing authorized CDP target."""
import json
import hashlib
import sys
import time

from clipboard_paste import paste_text
from desktop_common import Cdp, ToolError, entry, find_target, guard_write, redact


def _js(target_id, operation):
    value=json.dumps(target_id,separators=(',',':'))
    return r"""/* ACB_RENAME_%s */
(() => {
 const id=%s;
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 const rows=[...document.querySelectorAll('[data-conversation-id]')].filter(e=>e.dataset.conversationId===id&&visible(e));
 if(rows.length!==1)return JSON.stringify({conversationId:id,found:false,ambiguous:rows.length>1});
 const row=rows[0];
 const input=[...row.querySelectorAll('input[aria-label="Rename"],input[aria-label="重命名"],input[data-rename-input]')].filter(visible);
 const titleNode=row.querySelector('[data-conversation-title], [data-testid="conversation-title"]');
 const title=(titleNode&&(titleNode.dataset.conversationTitle||titleNode.textContent)||row.dataset.title||'').trim();
 %s
 const save=[...row.querySelectorAll('button,[role="button"]')].filter(visible).filter(e=>/^(save|rename|done|保存|重命名|完成)$/i.test((e.getAttribute('aria-label')||e.textContent||'').trim()));
 return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:input.length===1,
   editorValue:input.length===1?input[0].value:null,rowTitle:title,
   capabilities:{enter:true,blur:input.length===1,saveButton:save.length===1}});
})()
""" % (operation, value, {
        'OPEN': r"""if(input.length===0){
 const menus=[...row.querySelectorAll('button[aria-haspopup="menu"],button[data-action="conversation-menu"]')].filter(visible);
 if(menus.length!==1)return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:false,openResult:'menu-unsupported'});
 menus[0].click();
 const items=[...document.querySelectorAll('[role="menuitem"]')].filter(visible).filter(e=>/^(rename|重命名)$/i.test((e.getAttribute('aria-label')||e.textContent||'').trim()));
 if(items.length!==1)return JSON.stringify({conversationId:id,found:true,oldTitle:title,editing:false,openResult:'rename-action-unsupported'});
 items[0].click();
 }""",
        'READ': '',
        'ESCAPE': r"""if(input.length===1){input[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));}""",
        'ENTER': r"""if(input.length===1){input[0].focus();input[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));input[0].dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));}""",
        'BLUR': r"""if(input.length===1)input[0].blur();""",
        'SAVE': r"""if(input.length===1&&save.length===1)save[0].click();""",
    }[operation])


def rename_session(connection, conversation_id, new_title, clipboard=None,
                   state_reader=None, paste_operation=None, action=None, pre_submit=None,
                   max_wait_seconds=0.75):
    """Rename a conversation; success requires two fresh row-title observations."""
    if not isinstance(conversation_id,str) or not conversation_id.strip():
        return {'status':'blocked','code':'TARGET_MISSING','error':'Target conversation identity is required'}
    if not isinstance(new_title,str) or not new_title.strip() or len(new_title)>200 or '\x00' in new_title:
        return {'status':'blocked','code':'TITLE_INVALID','error':'New title must contain 1..200 non-whitespace characters'}
    if redact(new_title)!=new_title:
        return {'status':'blocked','code':'TITLE_UNSAFE','error':'New title contains a control character or authentication material'}
    reader=state_reader or (lambda: connection.evaluate(_js(conversation_id,'READ')))
    paste=paste_operation or paste_text
    def read_state():
        try:
            value=reader()
            if isinstance(value,str): value=json.loads(value)
            return value if isinstance(value,dict) else {}
        except Exception: return {}
    initial=read_state()
    if initial.get('conversationId')!=conversation_id:
        return {'status':'blocked','code':'TARGET_MISMATCH','error':'Target conversation row could not be uniquely verified'}
    old_title=initial.get('oldTitle')
    if not isinstance(old_title,str) or not old_title:
        return {'status':'verification_failed','code':'ORIGINAL_TITLE_UNKNOWN','error':'Original title could not be read safely'}
    if initial.get('editing') is not True:
        try:
            opened=action('OPEN') if action else connection.evaluate(_js(conversation_id,'OPEN'))
            if isinstance(opened,str): opened=json.loads(opened)
        except Exception:
            opened={}
        deadline=time.monotonic()+max(0.05,min(float(max_wait_seconds),2.0))
        while True:
            initial=read_state()
            if initial.get('conversationId')!=conversation_id or initial.get('oldTitle')!=old_title:
                return {'status':'blocked','code':'UI_CHANGED','error':'Target changed while opening rename controls','oldTitle':old_title}
            if initial.get('editing') is True or time.monotonic()>=deadline: break
            time.sleep(0.05)
        if initial.get('editing') is not True:
            return {'status':'unsupported','code':'RENAME_UI_UNSUPPORTED',
                    'error':(opened or {}).get('openResult','No supported rename control is available'),
                    'oldTitle':old_title,'attemptedStrategies':[],'lastState':initial}
    try:
        paste(connection,{'kind':'rename','conversationId':conversation_id},new_title,clipboard=clipboard)
    except ToolError as error:
        try:
            if action: action('ESCAPE')
            else: connection.evaluate(_js(conversation_id,'ESCAPE'))
        except Exception: pass
        return {'status':error.status if error.status in ('blocked','unsupported','verification_failed') else 'verification_failed',
                'code':error.code,'error':str(error),'oldTitle':old_title,'attemptedStrategies':[],
                'lastState':read_state(),'details':error.details}
    typed=read_state()
    if typed.get('conversationId')!=conversation_id or typed.get('editing') is not True or typed.get('editorValue')!=new_title:
        try:
            if typed.get('conversationId')==conversation_id:
                if action: action('ESCAPE')
                else: connection.evaluate(_js(conversation_id,'ESCAPE'))
        except Exception: pass
        return {'status':'verification_failed','code':'RENAME_INPUT_MISMATCH',
                'error':'Renaming editor did not contain the exact requested title; submission was stopped',
                'oldTitle':old_title,'attemptedStrategies':[],'lastState':typed}

    capabilities=typed.get('capabilities') if isinstance(typed.get('capabilities'),dict) else {}
    strategies=[]
    if capabilities.get('saveButton') is True: strategies.append(('save-button','SAVE'))
    if capabilities.get('enter') is True: strategies.append(('enter','ENTER'))
    if capabilities.get('blur') is True: strategies.append(('blur','BLUR'))
    attempted=[]; last=typed; deadline=time.monotonic()+max(0.05,min(float(max_wait_seconds),2.0))
    for name, operation in strategies[:3]:
        if pre_submit is not None:
            try: route=pre_submit()
            except Exception: route=None
            if not isinstance(route,dict) or route.get('status')!='success':
                try:
                    if action: action('ESCAPE')
                    else: connection.evaluate(_js(conversation_id,'ESCAPE'))
                except Exception: pass
                return {'status':'blocked','code':'PROJECT_ROUTE_CHANGED',
                        'error':'Conversation route changed before rename submission',
                        'oldTitle':old_title,'attemptedStrategies':attempted,'lastState':read_state()}
        attempted.append(name)
        try:
            if action: action(operation)
            else: connection.evaluate(_js(conversation_id,operation))
        except Exception: pass
        # A small state-driven poll budget; no repeated click/key submission.
        while True:
            last=read_state()
            if last.get('conversationId')!=conversation_id:
                return {'status':'verification_failed','code':'TARGET_CHANGED',
                        'error':'Conversation identity changed during rename','oldTitle':old_title,
                        'attemptedStrategies':attempted,'lastState':last}
            if last.get('editing') is not True and last.get('rowTitle')==new_title: break
            if time.monotonic()>=deadline: break
            time.sleep(0.05)
        if last.get('editing') is not True and last.get('rowTitle')==new_title:
            confirmed=read_state()
            if confirmed.get('conversationId')==conversation_id and confirmed.get('editing') is not True and confirmed.get('rowTitle')==new_title:
                return {'status':'success','code':'RENAME_VERIFIED','conversationId':conversation_id,
                        'oldTitle':old_title,'newTitle':new_title,'attemptedStrategies':attempted,
                        'confirmation':'two fresh application row-title reads','persistence':'not independently verified after reload'}
        # The state did not commit; next method is allowed only if the editor remains active.
        if last.get('editing') is not True: break
    try:
        if action: action('ESCAPE')
        else: connection.evaluate(_js(conversation_id,'ESCAPE'))
    except Exception: pass
    final=read_state()
    return {'status':'verification_failed','code':'RENAME_NOT_CONFIRMED',
            'error':'No available submit strategy produced a confirmed title update',
            'conversationId':conversation_id,'oldTitle':old_title,
            'attemptedStrategies':attempted,'lastState':final,
            'originalTitleRestored':final.get('rowTitle')==old_title}


def main(authority=None, approval=None, target_context=None, clipboard=None):
    if '--help' in sys.argv:
        print('Trusted host API only; one-time target-bound approval required.'); return 0
    if not isinstance(target_context,dict) or not target_context.get('conversationId'):
        raise ToolError('AUTH','Trusted host target context required')
    if len(sys.argv)!=2: raise ToolError('INPUT','Supply exactly one new title',2)
    title=sys.argv[1]
    if not title.strip() or len(title)>200 or '\x00' in title: raise ToolError('INPUT','New title must contain 1..200 non-whitespace characters',2)
    if redact(title)!=title: raise ToolError('INPUT','New title contains a control character or authentication material',2)
    digest=hashlib.sha256(title.encode('utf-8')).hexdigest()
    from desktop_guards import binding_fingerprint, guard_project_route, read_project_route
    guard_write('rename_session',authority,approval,digest,binding_fingerprint(target_context))
    connection=Cdp(find_target('webview'))
    try:
        def route_check():
            return guard_project_route(target_context,read_project_route(connection),provider='gpt')
        before=route_check()
        if before.get('status')!='success':
            result={'status':before.get('status','blocked'),'code':before.get('code','PROJECT_ROUTE_BLOCKED'),
                    'error':before.get('reason','Target route is not verified'),'oldTitle':None,
                    'attemptedStrategies':[],'lastState':{'route':before}}
        else:
            result=rename_session(connection,target_context['conversationId'],title,clipboard=clipboard,
                                  pre_submit=route_check)
    finally: connection.close()
    print(json.dumps(redact(result),ensure_ascii=False))
    return 0 if result.get('status')=='success' else 4


if __name__=='__main__': sys.exit(entry(main))
