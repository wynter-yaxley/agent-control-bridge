import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_common as common
import desktop_rename as rename_module
from desktop_guards import (ROUTE_SNAPSHOT_JS, binding_fingerprint, classify_execution_target,
                            guard_local_codex_execution, guard_project_route, repair_project_route)
from clipboard_paste import paste_text
from desktop_rename import rename_session


class WorkaroundGuardContracts(unittest.TestCase):
    def test_project_route_rejects_recent_chat_without_verified_project_ownership(self):
        expected = {
            'mappingSource': 'bridge-registry', 'registered': True,
            'projectId': 'project-1',
            'workspacePath': r'D:\work\project-1',
            'projectRoot': r'D:\work\project-1',
            'conversationId': 'chat-1',
            'provider': 'gpt',
        }
        result = guard_project_route(expected, {
            'conversationId': 'chat-1', 'projectId': None,
            'listKind': 'recent', 'workspacePath': None,
        })
        self.assertEqual(result['status'], 'unsupported')
        self.assertNotEqual(result.get('actualOwnership'), 'project-1')

    def test_project_route_repair_requires_fresh_application_readback(self):
        expected={'mappingSource':'bridge-registry','registered':True,'provider':'gpt',
                  'projectId':'project-1','workspacePath':r'D:\work\project-1',
                  'projectRoot':r'D:\work\project-1','conversationId':'chat-1'}
        before={'conversationId':'chat-1','projectId':None,'listKind':'recent'}
        repaired={'conversationId':'chat-1','projectId':'project-1','workspacePath':r'D:\work\project-1'}
        result=guard_project_route(expected,before,repair=lambda *_:repaired)
        self.assertEqual(result['status'],'success')
        self.assertEqual(result['code'],'ROUTE_REPAIRED_AND_VERIFIED')
        failed=guard_project_route(expected,before,repair=lambda *_:{**repaired,'projectId':'other'})
        self.assertEqual(failed['status'],'verification_failed')
        mismatch=guard_project_route(expected,{**repaired,'workspacePath':r'D:\other'})
        self.assertEqual(mismatch['code'],'WORKSPACE_MISMATCH')
        missing=guard_project_route(expected,{key:value for key,value in repaired.items() if key!='workspacePath'})
        self.assertEqual(missing['code'],'WORKSPACE_EVIDENCE_MISSING')

    def test_project_route_repair_clicks_only_bound_ui_actions_then_rereads(self):
        expected={'mappingSource':'bridge-registry','registered':True,'provider':'gpt',
                  'projectId':'project-1','workspacePath':r'D:\work\project-1',
                  'projectRoot':r'D:\work\project-1','conversationId':'chat-1'}
        before={'conversationId':'chat-1','projectId':None,'listKind':'recent',
                'moveAction':{'supported':True,'conversationId':'chat-1'}}
        class Connection:
            def __init__(self):self.calls=[]
            def evaluate(self,expression):
                self.calls.append(expression)
                if 'ACB_PROJECT_REPAIR_OPEN' in expression:return 'menu-opened'
                if 'ACB_PROJECT_REPAIR_SELECT' in expression:return 'move-requested'
                if expression==ROUTE_SNAPSHOT_JS:return json.dumps({'conversationId':'chat-1','projectId':'project-1','workspacePath':r'D:\work\project-1'})
                return None
        connection=Connection();authority=common.DesktopAuthority()
        approval=authority.approve('project_route_repair',binding=binding_fingerprint(expected))
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}):
            result=repair_project_route(connection,expected,before,authority,approval)
        self.assertEqual(result['projectId'],'project-1')
        self.assertEqual(len(connection.calls),3)

    def test_ordinary_chat_cannot_gain_project_ownership_from_title(self):
        expected={'mappingSource':'bridge-registry','registered':True,'provider':'gpt',
                  'projectId':None,'workspacePath':None,'projectRoot':None,'conversationId':'chat-ordinary'}
        result=guard_project_route(expected,{'conversationId':'chat-ordinary','projectId':None,
                                             'workspacePath':None,'title':'project-1'})
        self.assertEqual(result['status'],'success')
        wrong=guard_project_route(expected,{'conversationId':'chat-ordinary','projectId':'project-1','title':'project-1'})
        self.assertEqual(wrong['status'],'blocked')

    def test_execution_guard_fails_closed_for_work_unknown_and_path_conflict(self):
        expected = {'mappingSource':'bridge-registry','registered':True,'provider':'codex',
                    'projectRoot':r'D:\work\project-1','projectId': 'project-1', 'workspacePath': r'D:\work\project-1',
                    'conversationId': 'thread-1'}
        cases = [
            {'surface': 'webview', 'modeAttribute': 'work-cloud', 'workspacePath': '/mnt/data',
             'conversationId': 'thread-1', 'projectId': 'project-1'},
            {'surface': 'unknown', 'modeAttribute': None, 'workspacePath': None,
             'conversationId': 'thread-1', 'projectId': 'project-1'},
            {'surface': 'codex-desktop', 'modeAttribute': 'codex-local', 'composerState':'ready','workspacePath': r'D:\other',
             'conversationId': 'thread-1', 'projectId': 'project-1'},
        ]
        for evidence in cases:
            with self.subTest(evidence=evidence):
                self.assertNotEqual(guard_local_codex_execution(expected, evidence, {'verified': True})['status'], 'success')

    def test_local_execution_requires_matching_app_metadata_and_fresh_recheck(self):
        expected = {'mappingSource':'bridge-registry','registered':True,'provider':'codex',
                    'projectRoot':r'D:\work\project-1','projectId': 'project-1', 'workspacePath': r'D:\work\project-1',
                    'conversationId': 'thread-1'}
        evidence = {'surface': 'codex-desktop', 'modeAttribute': 'codex-local','composerState':'ready',
                    'workspacePath': r'D:\work\project-1', 'conversationId': 'thread-1',
                    'projectId': 'project-1'}
        metadata = {'source':'codex-app-state','observed': True, 'projectId': 'project-1',
                    'workspacePath': r'D:\work\project-1', 'conversationId': 'thread-1'}
        sequence = iter([{**evidence, 'modeAttribute': 'work-cloud'}])
        result = guard_local_codex_execution(expected, evidence, metadata, reread=lambda: next(sequence))
        self.assertNotEqual(result['status'], 'success')
        self.assertEqual(result['classification'],'cloud_work')
        stable={'surface':'codex-desktop','modeAttribute':None,'composerState':'ready',
                'workspacePath':r'D:\work\project-1','conversationId':'thread-1','projectId':'project-1'}
        result=guard_local_codex_execution(expected,stable,metadata,reread=lambda:stable,metadata_reread=lambda:metadata)
        self.assertEqual(result['status'],'success')

    def test_execution_classification_keeps_ui_evidence_untrusted_and_requires_corroboration(self):
        self.assertEqual(classify_execution_target({'surface':'chatgpt-web','conversationId':'c'})['classification'],'ordinary_gpt')
        self.assertEqual(classify_execution_target({'surface':'chatgpt-web','badgeText':'Work · 云端环境'})['classification'],'cloud_work')
        local=classify_execution_target({'surface':'codex-desktop','modeAttribute':'codex-local'})
        self.assertEqual(local['classification'],'local_codex')
        self.assertFalse(local['trusted'])
        self.assertEqual(classify_execution_target({'surface':'unknown'})['classification'],'unknown')

    def test_clipboard_paste_reads_back_exact_text_and_restores_prior_contents(self):
        class Clipboard:
            value = 'user clipboard'

            def snapshot(self): return self.value
            def write(self, value): self.value = value
            def restore(self, value): self.value = value

        class Connection:
            def __init__(self, clipboard): self.value = ''; self.calls = []; self.clipboard=clipboard
            def evaluate(self, expression):
                self.calls.append(expression)
                if 'ACB_FOCUS' in expression: return json.dumps({'found':True,'editable':True,'focused':True})
                if 'ACB_READ' in expression: return json.dumps({'found':True,'editable':True,'focused':True,'value':self.value})
                return json.dumps({'found':True,'editable':True,'focused':True})
            def call(self, method, params):
                self.calls.append((method, params))
                if method == 'Input.dispatchKeyEvent' and params.get('code') == 'KeyV' and params.get('type')=='keyDown': self.value = self.clipboard.value

        clipboard = Clipboard()
        connection = Connection(clipboard)
        result = paste_text(connection, {'kind': 'rename', 'conversationId': 'chat-1'}, 'New title', clipboard=clipboard)
        self.assertEqual(result['status'], 'success')
        self.assertEqual(clipboard.value, 'user clipboard')
        self.assertTrue(any(call[0] == 'Input.dispatchKeyEvent' for call in connection.calls if isinstance(call, tuple)))

    def test_clipboard_restore_failure_is_reported_after_verified_paste(self):
        class Clipboard:
            value='previous'
            def snapshot(self):return self.value
            def write(self,value):self.value=value
            def restore(self,value):raise OSError('restore denied')
        class Connection:
            value=''
            def evaluate(self,expression):
                if 'ACB_READ' in expression:return json.dumps({'found':True,'editable':True,'focused':True,'value':self.value})
                return json.dumps({'found':True,'editable':True,'focused':True})
            def call(self,method,params):
                if params.get('code')=='KeyV' and params.get('type')=='keyDown':self.value='new title'
        with self.assertRaises(common.ToolError) as failure:
            paste_text(Connection(),{'kind':'rename','conversationId':'chat-1'},'new title',clipboard=Clipboard())
        self.assertEqual(failure.exception.code,'CLIPBOARD_RESTORE_FAILED')

    def test_rename_preparation_does_not_auto_submit_even_when_ui_offers_submit_controls(self):
        states=[
            {'conversationId':'chat-1','oldTitle':'Old title','editing':True,'editorValue':'Old title','rowTitle':'Old title','capabilities':{'enter':True,'blur':True}},
            {'conversationId':'chat-1','oldTitle':'Old title','editing':True,'editorValue':'New title','rowTitle':'Old title','focused':True,'capabilities':{'enter':True,'blur':True}},
        ]
        writes=[];actions=[]
        def writer(_connection,conversation_id,title):
            writes.append((conversation_id,title))
            return {'conversationId':conversation_id,'found':True,'editorValue':title,'inputEventDispatched':True,'focused':True}
        result=rename_session(Mock(), 'chat-1','New title',write_operation=writer,
                              state_reader=lambda:states[min(len(writes),1)],action=actions.append)
        self.assertEqual(result['status'],'awaiting_human_enter')
        self.assertEqual(result['renameState'],'awaiting human Enter')
        self.assertEqual(writes,[('chat-1','New title')])
        self.assertEqual(actions,[])
        self.assertFalse(result['saved'])

    def test_rename_readback_mismatch_is_failure_and_never_triggers_key_action(self):
        state={'conversationId':'chat-1','oldTitle':'Old title','editing':True,'editorValue':'Old title','rowTitle':'Old title'}
        actions=[]
        result=rename_session(Mock(),'chat-1','New title',
            write_operation=lambda *_:{'conversationId':'chat-1','found':True,'editorValue':'New title','inputEventDispatched':True,'focused':True},
            state_reader=lambda:state.copy(),action=actions.append)
        self.assertEqual(result['status'],'verification_failed')
        self.assertEqual(result['code'],'RENAME_INPUT_MISMATCH')
        self.assertEqual(actions,[])

    def test_rename_does_not_use_clipboard_or_automated_submit_channels(self):
        source=Path(rename_module.__file__).read_text(encoding='utf-8')
        for forbidden in ['Input.'+'dispatchKeyEvent','Keyboard'+'Event','Send'+'Keys(','paste_'+'text']:
            self.assertNotIn(forbidden,source)

    def test_rename_native_setter_uses_prototype_and_bubbling_input_event(self):
        script=rename_module._js('chat-1','SET','New title')
        self.assertIn("Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set",script)
        self.assertIn("Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set",script)
        self.assertIn("new Event('input', { bubbles: true })",script)

    def test_rename_preparation_returns_awaiting_human_enter_without_key_events(self):
        states=[
            {'conversationId':'chat-1','oldTitle':'Old','editing':True,'editorValue':'Old','rowTitle':'Old'},
            {'conversationId':'chat-1','oldTitle':'Old','editing':True,'editorValue':'New','rowTitle':'Old','focused':True},
        ]
        actions=[]
        result=rename_session(Mock(),'chat-1','New',state_reader=lambda:states[-1],
                              write_operation=lambda _,conversation_id,title:{'conversationId':conversation_id,'found':True,'editorValue':title,'inputEventDispatched':True,'focused':True},
                              action=actions.append)
        self.assertEqual(result['status'],'awaiting_human_enter')
        self.assertEqual(result['code'],'RENAME_PREPARED')
        self.assertEqual(result['renameState'],'awaiting human Enter')
        self.assertEqual(actions,[])
        self.assertNotEqual(result['code'],'RENAME_VERIFIED')

    def test_rename_write_readback_mismatch_never_reports_prepared_or_success(self):
        state={'conversationId':'chat-1','oldTitle':'Old','editing':True,'editorValue':'Old','rowTitle':'Old'}
        result=rename_session(Mock(),'chat-1','New',state_reader=lambda:state.copy(),
                              write_operation=lambda _,conversation_id,title:{'conversationId':conversation_id,'found':True,'editorValue':title,'inputEventDispatched':True,'focused':True},
                              action=lambda _:self.fail('unexpected key action'))
        self.assertEqual(result['status'],'verification_failed')
        self.assertEqual(result['code'],'RENAME_INPUT_MISMATCH')

    def test_human_submission_verification_requires_closed_editor_and_matching_row_title(self):
        self.assertTrue(hasattr(rename_module,'verify_rename_session'))
        pending={'conversationId':'chat-1','oldTitle':'Old','editing':True,'editorValue':'New','rowTitle':'Old'}
        result=rename_module.verify_rename_session(Mock(),'chat-1','New',state_reader=lambda:pending)
        self.assertEqual(result['status'],'awaiting_human_enter')
        confirmed={'conversationId':'chat-1','oldTitle':'New','editing':False,'editorValue':None,'rowTitle':'New'}
        reads=[]
        result=rename_module.verify_rename_session(Mock(),'chat-1','New',state_reader=lambda:reads.append(confirmed) or confirmed)
        self.assertEqual(result['status'],'success')
        self.assertEqual(result['code'],'RENAME_CONFIRMED')
        self.assertEqual(result['confirmation'],'two fresh application row-title reads after human submission')
        self.assertEqual(len(reads),2)
        wrong={**confirmed,'conversationId':'another-chat'}
        self.assertEqual(rename_module.verify_rename_session(Mock(),'chat-1','New',state_reader=lambda:wrong)['status'],'verification_failed')


if __name__ == '__main__':
    unittest.main()
