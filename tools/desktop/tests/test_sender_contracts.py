import unittest, sys, json, io, hashlib, tempfile, os
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import desktop_common as common
from desktop_guards import EXECUTION_SNAPSHOT_JS, ROUTE_SNAPSHOT_JS, binding_fingerprint
import gpt_send_cdp as gpt
import codex_send_cdp as codex

PROJECT_PATH=r'D:\\work\\project-a'

def context(provider,conversation):
    return {'mappingSource':'bridge-registry','registered':True,'provider':provider,
            'projectId':'project-a','workspacePath':PROJECT_PATH,'projectRoot':PROJECT_PATH,
            'conversationId':conversation}

class Clipboard:
    def __init__(self,value='preserved user clipboard'):self.value=value;self.restored=False
    def snapshot(self):return self.value
    def write(self,value):self.value=value
    def restore(self,value):self.value=value;self.restored=True

class FakeGpt:
    def __init__(self, submit='clicked', clipboard=None): self.closed=0;self.submit=submit;self.calls=[];self.clipboard=clipboard;self.text=''
    def evaluate(self, expression):
        self.calls.append(expression)
        if expression==ROUTE_SNAPSHOT_JS:return json.dumps({'conversationId':'chat-1','projectId':'project-a','workspacePath':PROJECT_PATH})
        if expression==gpt.CHECK_EDITOR:return 'found'
        if expression==gpt.READ_EDITOR:return self.text
        if 'ACB_FOCUS' in expression:return json.dumps({'found':True,'editable':True,'focused':True})
        if 'ACB_READ' in expression:return json.dumps({'found':True,'editable':True,'focused':True,'value':self.text})
        if expression==gpt.SUBMIT_EDITOR:return self.submit
        if 'send-button' in expression:return self.submit
        return json.dumps({'found':True,'editable':True,'focused':True})
    def call(self,method,params):
        self.calls.append((method,params))
        if method=='Input.dispatchKeyEvent' and params.get('code')=='KeyV' and params.get('type')=='keyDown':self.text=self.clipboard.value
    def close(self):self.closed+=1

class FakeCodex:
    def __init__(self, mismatch=False, clipboard=None, execution_sequence=None, route=None, enter_behavior=None):self.closed=0;self.calls=[];self.text='';self.mismatch=mismatch;self.clipboard=clipboard;self.execution_sequence=list(execution_sequence or []);self.route=route or {'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH};self.messages=[];self.enter_behavior=enter_behavior
    def evaluate(self,expression):
        if expression==ROUTE_SNAPSHOT_JS:return json.dumps(self.route)
        if expression==EXECUTION_SNAPSHOT_JS:
            state=self.execution_sequence.pop(0) if self.execution_sequence else {'surface':'codex-desktop','modeAttribute':'codex-local','workspacePath':PROJECT_PATH,'conversationId':'thread-1','projectId':'project-a','composerState':'ready'}
            return json.dumps(state)
        if expression==codex.FIND_COMPOSER:return 'focused'
        if expression==codex.READ_COMPOSER:return self.text
        if expression==codex.READ_MESSAGES_JS:return json.dumps({'messages':self.messages,'diagnostics':{'nodesScanned':len(self.messages),'messagesFound':len(self.messages)}})
        if 'ACB_FOCUS' in expression:return json.dumps({'found':True,'editable':True,'focused':True})
        if 'ACB_READ' in expression:return json.dumps({'found':True,'editable':True,'focused':True,'value':self.text})
        return json.dumps({'found':True,'editable':True,'focused':True})
    def call(self,method,params):
        self.calls.append((method,params))
        if method=='Input.dispatchKeyEvent' and params.get('code')=='KeyV' and params.get('type')=='keyDown':self.text='wrong content' if self.mismatch else self.clipboard.value
        if method=='Input.dispatchKeyEvent' and params.get('code')=='Enter' and params.get('type')=='keyDown':
            if self.enter_behavior=='ignored':
                pass
            elif self.enter_behavior=='mismatch':
                self.messages.append({'role':'user','text':'DIFFERENT CONTENT','sourceMessageId':f'msg-{len(self.messages)+1}'})
            else:
                self.messages.append({'role':'user','text':self.text,'sourceMessageId':f'msg-{len(self.messages)+1}'})
        return {'result':{}}
    def close(self):self.closed+=1

class SenderContracts(unittest.TestCase):
    def test_authorized_gpt_submission_preserves_algorithm_without_live_input(self):
        prompt='[TEST] generated requirement';mapping=context('gpt','chat-1');clipboard=Clipboard();authority=common.DesktopAuthority();approval=authority.approve('gpt_send_cdp.py',hashlib.sha256(prompt.encode()).hexdigest(),binding_fingerprint(mapping));receipt=authority.approve('verified-chatgpt-prompt',hashlib.sha256(prompt.encode()).hexdigest());fake=FakeGpt(clipboard=clipboard);out=io.StringIO()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send',prompt]),redirect_stdout(out):
            self.assertEqual(gpt.main(authority,approval,receipt,mapping,clipboard=clipboard),0)
        self.assertEqual(fake.closed,1);self.assertIn('"executionVerified": false',out.getvalue());self.assertTrue(any('send-button' in call for call in fake.calls))
        self.assertTrue(clipboard.restored)
        with self.assertRaises(common.ToolError):authority.consume(approval,'gpt_send_cdp.py',hashlib.sha256(prompt.encode()).hexdigest(),binding_fingerprint(mapping))

    def test_missing_submit_is_failure_and_closes_connection(self):
        prompt='[TEST] generated requirement';mapping=context('gpt','chat-1');digest=hashlib.sha256(prompt.encode()).hexdigest();authority=common.DesktopAuthority();approval=authority.approve('gpt_send_cdp.py',digest,binding_fingerprint(mapping));receipt=authority.approve('verified-chatgpt-prompt',digest);clipboard=Clipboard();fake=FakeGpt('no-submit',clipboard)
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:gpt.main(authority,approval,receipt,mapping,clipboard=clipboard)
        self.assertEqual(failure.exception.code,'EXECUTION');self.assertEqual(fake.closed,1)

    def codex_run(self,mismatch=False):
        prompt='[TEST] trusted generated engineering prompt';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('codex','thread-1');clipboard=Clipboard()
        metadata={'source':'codex-app-state','observed':True,'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH}
        authority=common.DesktopAuthority();approval=authority.approve('codex_send_cdp.py',digest,binding_fingerprint(mapping));receipt=authority.approve('verified-chatgpt-prompt',digest);fake=FakeCodex(mismatch,clipboard);out=io.StringIO()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(out):
            if mismatch:
                with self.assertRaises(common.ToolError) as failure:codex.main(authority,approval,receipt,mapping,clipboard=clipboard,codex_metadata=metadata)
                self.assertEqual(failure.exception.code,'PASTE_MISMATCH')
            else:codex.main(authority,approval,receipt,mapping,clipboard=clipboard,codex_metadata=metadata)
        self.assertEqual(fake.closed,1)
        return fake,out.getvalue()

    def codex_behavior_run(self,enter_behavior):
        prompt='[TEST] trusted generated engineering prompt';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('codex','thread-1');clipboard=Clipboard()
        metadata={'source':'codex-app-state','observed':True,'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH}
        authority=common.DesktopAuthority();approval=authority.approve('codex_send_cdp.py',digest,binding_fingerprint(mapping));receipt=authority.approve('verified-chatgpt-prompt',digest);fake=FakeCodex(False,clipboard,enter_behavior=enter_behavior);out=io.StringIO()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(out):
            ret=codex.main(authority,approval,receipt,mapping,clipboard=clipboard,codex_metadata=metadata)
        self.assertEqual(fake.closed,1)
        return ret,out.getvalue(),fake

    def test_codex_submit_verified_when_new_message_matches(self):
        ret,out,_=self.codex_behavior_run(None)
        self.assertEqual(ret,0);self.assertIn('"submissionVerified": true',out);self.assertIn('"ok": true',out)

    def test_codex_submit_unverified_when_enter_ignored(self):
        with patch('time.sleep',return_value=None),patch('time.monotonic',side_effect=[0,1,10000]):
            ret,out,_=self.codex_behavior_run('ignored')
        self.assertEqual(ret,6);self.assertIn('"submission_unverified"',out);self.assertIn('"submissionVerified": false',out)

    def test_codex_submit_unverified_when_new_message_differs(self):
        # 新 user 消息已出现但内容不精确匹配（DOM 渲染差异）→ 降级 unverified，不报 mismatch
        ret,out,_=self.codex_behavior_run('mismatch')
        self.assertEqual(ret,6);self.assertIn('"submission_unverified"',out)

    def test_codex_requires_provenance_then_matches_before_mock_submission(self):
        fake,out=self.codex_run();self.assertTrue(any(x[0]=='Input.dispatchKeyEvent' and x[1].get('code')=='KeyV' for x in fake.calls));self.assertIn('"executionVerified": false',out)

    def test_codex_mismatch_never_submits(self):
        fake,_=self.codex_run(True);self.assertEqual(len([x for x in fake.calls if x[0]=='Input.dispatchKeyEvent' and x[1].get('code')=='KeyV' and x[1].get('type')=='keyDown']),1)

    def test_gpt_paste_mismatch_does_not_submit(self):
        prompt='[TEST] generated requirement';mapping=context('gpt','chat-1');digest=hashlib.sha256(prompt.encode()).hexdigest();authority=common.DesktopAuthority();approval=authority.approve('gpt_send_cdp.py',digest,binding_fingerprint(mapping));receipt=authority.approve('verified-chatgpt-prompt',digest);clipboard=Clipboard();fake=FakeGpt(clipboard=clipboard)
        original=fake.call
        def altered(method,params):
            result=original(method,params)
            if method=='Input.dispatchKeyEvent' and params.get('code')=='KeyV' and params.get('type')=='keyDown':fake.text=' wrong content '
            return result
        fake.call=altered
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:gpt.main(authority,approval,receipt,mapping,clipboard=clipboard)
        self.assertEqual(failure.exception.code,'PASTE_MISMATCH');self.assertEqual(fake.closed,1);self.assertFalse(any('send-button' in call for call in fake.calls))

    def test_codex_whitespace_mutation_does_not_submit(self):
        prompt='[TEST] trusted generated engineering prompt';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('codex','thread-1');clipboard=Clipboard();authority=common.DesktopAuthority();fake=FakeCodex(clipboard=clipboard)
        original=fake.call
        def altered(method,params):
            result=original(method,params)
            if method=='Input.dispatchKeyEvent' and params.get('code')=='KeyV' and params.get('type')=='keyDown':fake.text=' '+fake.text+' '
            return result
        fake.call=altered
        metadata={'source':'codex-app-state','observed':True,'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH}
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:codex.main(authority,authority.approve('codex_send_cdp.py',digest,binding_fingerprint(mapping)),authority.approve('verified-chatgpt-prompt',digest),mapping,clipboard=clipboard,codex_metadata=metadata)
        self.assertEqual(failure.exception.code,'PASTE_MISMATCH');self.assertEqual(fake.closed,1);self.assertEqual(len([x for x in fake.calls if x[0]=='Input.dispatchKeyEvent' and x[1].get('code')=='KeyV' and x[1].get('type')=='keyDown']),1)

    def test_cloud_work_is_blocked_before_local_composer_is_touched(self):
        prompt='[TEST] trusted local task';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('codex','thread-1');clipboard=Clipboard()
        metadata={'source':'codex-app-state','observed':True,'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH}
        work={'surface':'chatgpt-web','modeAttribute':'work-cloud','workspacePath':'/mnt/data','conversationId':'thread-1','projectId':'project-a'}
        fake=FakeCodex(clipboard=clipboard,execution_sequence=[work]);authority=common.DesktopAuthority()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:codex.main(authority,authority.approve('codex_send_cdp.py',digest,binding_fingerprint(mapping)),authority.approve('verified-chatgpt-prompt',digest),mapping,clipboard=clipboard,codex_metadata=metadata)
        self.assertEqual(failure.exception.code,'CLOUD_WORK_BLOCKED')
        self.assertFalse(any(x[0]=='Input.dispatchKeyEvent' for x in fake.calls if isinstance(x,tuple)))
        self.assertEqual(fake.closed,1)

    def test_execution_mode_switch_after_paste_blocks_submit(self):
        prompt='[TEST] trusted local task';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('codex','thread-1');clipboard=Clipboard()
        local={'surface':'codex-desktop','modeAttribute':'codex-local','workspacePath':PROJECT_PATH,'conversationId':'thread-1','projectId':'project-a','composerState':'ready'}
        work={'surface':'chatgpt-web','modeAttribute':'work-cloud','workspacePath':'/mnt/data','conversationId':'thread-1','projectId':'project-a'}
        # Initial check + fresh check, then the post-paste check and its fresh read sees Work.
        fake=FakeCodex(clipboard=clipboard,execution_sequence=[local,local,local,work]);authority=common.DesktopAuthority()
        metadata={'source':'codex-app-state','observed':True,'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH}
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:codex.main(authority,authority.approve('codex_send_cdp.py',digest,binding_fingerprint(mapping)),authority.approve('verified-chatgpt-prompt',digest),mapping,clipboard=clipboard,codex_metadata=metadata)
        self.assertEqual(failure.exception.code,'EXECUTION_STATE_CHANGED')
        self.assertFalse(any(call[0]=='Input.dispatchKeyEvent' and call[1].get('key')=='Enter' for call in fake.calls))

    def test_codex_app_state_change_after_paste_blocks_submit(self):
        prompt='[TEST] trusted local task';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('codex','thread-1');clipboard=Clipboard()
        metadata={'source':'codex-app-state','observed':True,'conversationId':'thread-1','projectId':'project-a','workspacePath':PROJECT_PATH}
        changed={**metadata,'workspacePath':r'D:\other'};states=iter([metadata,metadata,changed])
        fake=FakeCodex(clipboard=clipboard);authority=common.DesktopAuthority()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:codex.main(authority,authority.approve('codex_send_cdp.py',digest,binding_fingerprint(mapping)),authority.approve('verified-chatgpt-prompt',digest),mapping,clipboard=clipboard,codex_metadata_reader=lambda:next(states))
        self.assertEqual(failure.exception.code,'EXECUTION_STATE_CHANGED')
        self.assertFalse(any(call[0]=='Input.dispatchKeyEvent' and call[1].get('key')=='Enter' for call in fake.calls))

    def test_project_route_drift_blocks_gpt_before_clipboard_paste(self):
        prompt='[TEST] generated project requirement';digest=hashlib.sha256(prompt.encode()).hexdigest();mapping=context('gpt','chat-1');clipboard=Clipboard()
        fake=FakeGpt(clipboard=clipboard)
        fake.evaluate=lambda expression: json.dumps({'conversationId':'chat-1','projectId':None,'listKind':'recent'}) if expression==ROUTE_SNAPSHOT_JS else (_ for _ in ()).throw(AssertionError('composer touched'))
        authority=common.DesktopAuthority()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:gpt.main(authority,authority.approve('gpt_send_cdp.py',digest,binding_fingerprint(mapping)),authority.approve('verified-chatgpt-prompt',digest),mapping,clipboard=clipboard)
        self.assertEqual(failure.exception.code,'PROJECT_REPAIR_UNSUPPORTED')
        self.assertEqual(clipboard.value,'preserved user clipboard')

    def test_missing_gpt_editor_never_creates_an_unregistered_conversation(self):
        prompt='[TEST] generated requirement';mapping=context('gpt','chat-1');digest=hashlib.sha256(prompt.encode()).hexdigest();authority=common.DesktopAuthority();approval=authority.approve('gpt_send_cdp.py',digest,binding_fingerprint(mapping));receipt=authority.approve('verified-chatgpt-prompt',digest);clipboard=Clipboard();fake=FakeGpt(clipboard=clipboard)
        def absent(expression):
            fake.calls.append(expression)
            if expression==ROUTE_SNAPSHOT_JS:return json.dumps({'conversationId':'chat-1','projectId':'project-a','workspacePath':PROJECT_PATH})
            return 'none'
        fake.evaluate=absent
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send',prompt]),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:gpt.main(authority,approval,receipt,mapping,clipboard=clipboard)
        self.assertEqual(failure.exception.code,'AGENT');self.assertEqual(fake.closed,1);self.assertEqual(fake.calls,[ROUTE_SNAPSHOT_JS,gpt.CHECK_EDITOR])

    def test_python_configuration_rejects_invalid_origin_flags_and_unknown_fields(self):
        with tempfile.TemporaryDirectory(prefix='acb-python-config-') as folder:
            path=Path(folder)/'config.json'
            for desktop in [{'remoteAllowOrigins':'https://external.example'},{'allowPhysicalInput':True},{'enabled':'true'},{'unknown':True},{'cdpUrl':'http://localhost:99999'}]:
                path.write_text(json.dumps({'desktop':desktop}),encoding='utf-8')
                with patch.dict(os.environ,{'ACB_CONFIG':str(path)},clear=True):
                    with self.assertRaises(common.ToolError) as failure:common.config()
                    self.assertEqual(failure.exception.code,'CONFIG')
            path.write_text(json.dumps({'desktop':{'cdpUrl':'http://localhost:9333','remoteAllowOrigins':'http://localhost:9333'}}),encoding='utf-8')
            with patch.dict(os.environ,{'ACB_CONFIG':str(path)},clear=True):self.assertEqual(common.config()['remoteAllowOrigins'],'http://localhost:9333')

if __name__=='__main__':unittest.main()
