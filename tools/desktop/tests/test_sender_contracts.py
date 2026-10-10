import unittest, sys, json, io, hashlib, tempfile, os
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import desktop_common as common
import gpt_send_cdp as gpt
import codex_send_cdp as codex

class FakeGpt:
    def __init__(self, submit='clicked'): self.closed=0;self.submit=submit;self.calls=[]
    def evaluate(self, expression):
        self.calls.append(expression)
        if expression==gpt.CHECK_EDITOR:return 'found'
        if "execCommand('insertText'" in expression:return 'ok:[TEST] generated requirement'
        if 'send-button' in expression:return self.submit
        return ''
    def close(self):self.closed+=1

class FakeCodex:
    def __init__(self, mismatch=False):self.closed=0;self.calls=[];self.text='';self.mismatch=mismatch
    def evaluate(self,expression):
        if expression==codex.FIND_COMPOSER:return 'focused'
        if expression==codex.READ_COMPOSER:return self.text
        return 'cleared'
    def call(self,method,params):
        self.calls.append((method,params))
        if method=='Input.insertText':self.text='wrong content' if self.mismatch else params['text']
        return {'result':{}}
    def close(self):self.closed+=1

class SenderContracts(unittest.TestCase):
    def test_authorized_gpt_submission_preserves_algorithm_without_live_input(self):
        authority=common.DesktopAuthority();approval=authority.approve('gpt_send_cdp.py');fake=FakeGpt();out=io.StringIO()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send','[TEST] generated requirement']),redirect_stdout(out):
            self.assertEqual(gpt.main(authority,approval),None)
        self.assertEqual(fake.closed,1);self.assertIn('"executionVerified": false',out.getvalue());self.assertTrue(any('send-button' in call for call in fake.calls))
        with self.assertRaises(common.ToolError):authority.consume(approval,'gpt_send_cdp.py')

    def test_missing_submit_is_failure_and_closes_connection(self):
        authority=common.DesktopAuthority();approval=authority.approve('gpt_send_cdp.py');fake=FakeGpt('no-submit')
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(gpt,'find_target_compat',return_value='mock'),patch.object(gpt,'Cdp',return_value=fake),patch.object(sys,'argv',['gpt-send','[TEST] generated requirement']),redirect_stdout(io.StringIO()):
            with self.assertRaises(common.ToolError) as failure:gpt.main(authority,approval)
        self.assertEqual(failure.exception.code,'EXECUTION');self.assertEqual(fake.closed,1)

    def codex_run(self,mismatch=False):
        prompt='[TEST] trusted generated engineering prompt';digest=hashlib.sha256(prompt.encode()).hexdigest()
        authority=common.DesktopAuthority();approval=authority.approve('codex_send_cdp.py',digest);receipt=authority.approve('verified-chatgpt-prompt',digest);fake=FakeCodex(mismatch);out=io.StringIO()
        with patch.object(common,'config',return_value={'enabled':True,'allowForegroundAutomation':True}),patch.object(codex,'find_codex_shell_compat',return_value='mock'),patch.object(codex,'Cdp',return_value=fake),patch.object(sys,'argv',['codex-send',prompt]),redirect_stdout(out):
            if mismatch:
                with self.assertRaises(SystemExit) as failure:codex.main(authority,approval,receipt)
                self.assertEqual(failure.exception.code,4)
            else:codex.main(authority,approval,receipt)
        self.assertEqual(fake.closed,1)
        return fake,out.getvalue()

    def test_codex_requires_provenance_then_matches_before_mock_submission(self):
        fake,out=self.codex_run();self.assertEqual([x[0] for x in fake.calls],['Input.insertText','Input.dispatchKeyEvent','Input.dispatchKeyEvent']);self.assertIn('"executionVerified": false',out)

    def test_codex_mismatch_never_submits(self):
        fake,_=self.codex_run(True);self.assertEqual([x[0] for x in fake.calls],['Input.insertText'])

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
