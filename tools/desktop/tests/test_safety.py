import unittest, sys, json, tempfile, subprocess, importlib.util, os
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import desktop_common as common
import desktop_rename
import gpt_send_cdp, codex_send_cdp

class DesktopSafetyTests(unittest.TestCase):
    def test_default_blocks_before_target_or_input_access(self):
        with patch.object(common,'config',return_value={'enabled':False,'allowForegroundAutomation':False}):
            with self.assertRaises(common.ToolError): common.guard_write('gpt-send')
        with patch.object(sys,'argv',['codex-send','raw text']):
            with self.assertRaises(common.ToolError) as failure: codex_send_cdp.main()
            self.assertEqual(failure.exception.code,'PROVENANCE')

    def test_configuration_and_forged_object_do_not_authorize(self):
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}):
            with self.assertRaises(common.ToolError): common.guard_write('gpt-send')
            authority=common.DesktopAuthority()
            with self.assertRaises(common.ToolError): common.guard_write('gpt-send',authority,common.Handle())
            approval=authority.approve('gpt-send')
            common.guard_write('gpt-send',authority,approval)
            with self.assertRaises(common.ToolError): common.guard_write('gpt-send',authority,approval)

    def test_rename_preparation_keeps_target_bound_desktop_authority(self):
        target={'mappingSource':'bridge-registry','registered':True,'provider':'gpt','projectId':'p1',
                'workspacePath':r'D:\work\p1','projectRoot':r'D:\work\p1','conversationId':'chat-123'}
        authority=common.DesktopAuthority()
        approval=authority.approve('rename_session',binding='wrong-target')
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}), \
             patch.object(desktop_rename,'find_target',side_effect=AssertionError('target lookup must follow authority check')), \
             patch.object(sys,'argv',['gpt-rename','New title']):
            with self.assertRaises(common.ToolError) as failure:
                desktop_rename.main(authority,approval,target)
        self.assertEqual(failure.exception.code,'AUTH')

    def test_rename_help_states_physical_enter_and_separate_verification(self):
        root=Path(__file__).resolve().parents[1]
        result=subprocess.run([sys.executable,str(root/'gpt-rename'),'--help'],capture_output=True,text=True,timeout=5,
                              env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('human physical Enter keypress',result.stdout)
        self.assertIn('gpt-rename --verify <expected-title>',result.stdout)
        self.assertIn('hands off the final commit to the user',result.stdout)

    def test_remote_and_credential_endpoints_rejected(self):
        for endpoint in ['http://example.com:9222','http://user:pass@localhost:9222','https://localhost:9222']:
            with patch.dict('os.environ',{'ACB_CDP_URL':endpoint}):
                with self.assertRaises(common.ToolError): common.config()

    def test_target_origin_and_ambiguous_target_rejected(self):
        with patch.object(common,'targets',return_value=[{'type':'webview','url':'https://chatgpt.com.evil.example','webSocketDebuggerUrl':'ws://127.0.0.1:9222/x'}]):
            with self.assertRaises(common.ToolError): common.find_target('webview')
        target={'type':'webview','url':'https://chatgpt.com/c/test','webSocketDebuggerUrl':'ws://remote.example:9222/x'}
        with patch.object(common,'targets',return_value=[target]):
            with self.assertRaises(common.ToolError): common.find_target('webview')
        with patch.object(common,'targets',return_value=[target,target]):
            with self.assertRaises(common.ToolError): common.find_target('webview')

    def test_all_compatibility_tools_help_without_network(self):
        root=Path(__file__).resolve().parents[1]
        for name in ['gpt-read','gpt-send','gpt-rename','route-execution-guard','codex-send','codex-status','codex-continue','relay.py','cdp_messages.py','probe_targets.py']:
            result=subprocess.run([sys.executable,str(root/name),'--help'],capture_output=True,text=True,timeout=5,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
            self.assertEqual(result.returncode,0,(name,result.stderr))

    def test_raw_copied_prompt_cannot_enter_codex(self):
        root=Path(__file__).resolve().parents[1]
        for command in [[str(root/'codex-send'),'self-declared ChatGPT prompt'],[str(root/'codex-continue'),'thread','raw prompt','--confirm']]:
            result=subprocess.run([sys.executable,*command],capture_output=True,text=True,timeout=5,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
            self.assertNotEqual(result.returncode,0);self.assertIn('PROVENANCE',result.stderr)
        # relay gpt2codex 现在只读候选（REVIEW_REQUIRED，不自动发送）；裸 CLI 无 CDP/凭证时失败
        result=subprocess.run([sys.executable,str(root/'relay.py'),'gpt2codex'],capture_output=True,text=True,timeout=5,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
        self.assertNotEqual(result.returncode,0)

    def test_no_os_input_or_global_focus_apis(self):
        root=Path(__file__).resolve().parents[1]
        forbidden=['Set'+'CursorPos','Send'+'Input','SetForeground'+'Window','pyauto'+'gui','shell='+'True']
        for path in root.iterdir():
            if path.suffix=='.py' or path.name in ['codex-status','codex-continue']:
                for pattern in forbidden:self.assertNotIn(pattern,path.read_text(encoding='utf-8'),(path.name,pattern))

if __name__=='__main__': unittest.main()
