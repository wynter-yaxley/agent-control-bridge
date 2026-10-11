"""Pure-function and fake-browser tests for chatgpt_headless (no real Chromium, no playwright import)."""
import unittest, sys, json, argparse
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import chatgpt_headless as headless

CONVERSATION_ID='11111111-2222-3333-4444-555555555555'
PAGE_URL='https://chatgpt.com/c/'+CONVERSATION_ID


class FakeStdin:
    def __init__(self,text=''): self.text=text
    def read(self): return self.text

class FakeKeyboard:
    def __init__(self): self.typed=[]; self.keys=[]
    def insert_text(self,text): self.typed.append(text)
    def press(self,key): self.keys.append(key)

class ScriptedPage:
    """按 JS 常量精确匹配返回脚本化结果；未脚本化的求值视为测试失败。"""
    def __init__(self,script,url=PAGE_URL):
        self.script={key:list(value) for key,value in script.items()}
        self.url=url; self.keyboard=FakeKeyboard(); self.goto_calls=[]
    def goto(self,target,**kwargs): self.goto_calls.append(target)
    def evaluate(self,js):
        if js not in self.script: raise AssertionError('unexpected evaluate: '+js[:60])
        return self.script[js].pop(0)

class FakeContext:
    def __init__(self,page): self.pages=[page]; self.closed=0
    def close(self): self.closed+=1
    def new_page(self): raise AssertionError('persistent context already has a page')

class FakePlaywright:
    def __init__(self): self.stopped=0
    def stop(self): self.stopped+=1

def fake_factory(page):
    """返回 (factory, playwright, context)；factory 记录 (profile, mode, channel) 调用。"""
    playwright,context,calls=FakePlaywright(),FakeContext(page),[]
    def factory(profile,mode,channel='chrome'):
        calls.append((profile,mode)); return playwright,context
    return factory,playwright,context,calls

def ns(**overrides):
    defaults={'mode':'ask','prompt':'hi','conversation':None,'profile':'/tmp/profile','timeout':None,'channel':'chrome'}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)

def run_capturing(fn,*args,**kwargs):
    buffer=StringIO()
    with redirect_stdout(buffer): result=fn(*args,**kwargs)
    return result,buffer.getvalue()


class ArgumentParsingTests(unittest.TestCase):
    def test_parse_args_defaults(self):
        args=headless.parse_args(['ask','--prompt','hi'])
        self.assertEqual(args.mode,'ask'); self.assertEqual(args.prompt,'hi')
        self.assertTrue(args.profile.endswith('chatgpt-headless-profile'))
        self.assertIsNone(args.conversation); self.assertIsNone(args.timeout)

    def test_parse_args_login_mode_has_no_prompt_requirement(self):
        args=headless.parse_args(['login'])
        self.assertEqual(args.mode,'login'); self.assertIsNone(args.prompt)

    def test_parse_args_rejects_unknown_mode_as_structured_error(self):
        with self.assertRaises(headless.ToolError) as failure: headless.parse_args(['send'])
        self.assertEqual(failure.exception.code,'INPUT'); self.assertEqual(failure.exception.exit_code,2)

    def test_parse_args_rejects_non_positive_timeout(self):
        for value in ('0','-1'):
            with self.assertRaises(headless.ToolError) as failure:
                headless.parse_args(['ask','--prompt','x','--timeout',value])
            self.assertEqual(failure.exception.code,'INPUT')


class PromptAndConversationTests(unittest.TestCase):
    def test_resolve_prompt_prefers_flag_over_stdin(self):
        self.assertEqual(headless.resolve_prompt(ns(prompt='flag'),'stdin text'),'flag')
        self.assertEqual(headless.resolve_prompt(ns(prompt=None),'stdin text'),'stdin text')

    def test_resolve_prompt_rejects_empty_as_structured_error(self):
        with self.assertRaises(headless.ToolError) as failure:
            headless.resolve_prompt(ns(prompt=None),'   ')
        self.assertEqual(failure.exception.code,'INPUT'); self.assertEqual(failure.exception.exit_code,2)

    def test_resolve_prompt_rejects_authentication_material(self):
        with self.assertRaises(headless.ToolError) as failure:
            headless.resolve_prompt(ns(prompt='sk-'+'a'*30),'')
        self.assertEqual(failure.exception.code,'INPUT')

    def test_validate_conversation_id_accepts_uuid_shape(self):
        self.assertEqual(headless.validate_conversation_id(CONVERSATION_ID),CONVERSATION_ID)

    def test_validate_conversation_id_rejects_path_injection_and_short_ids(self):
        for value in (None,'','../settings','abc','bad id'):
            with self.assertRaises(headless.ToolError) as failure:
                headless.validate_conversation_id(value)
            self.assertEqual(failure.exception.code,'INPUT')

    def test_conversation_url_and_extract_roundtrip(self):
        self.assertEqual(headless.conversation_url('abcdef12'),'https://chatgpt.com/c/abcdef12')
        self.assertEqual(headless.extract_conversation_id(PAGE_URL),CONVERSATION_ID)
        self.assertIsNone(headless.extract_conversation_id(headless.CHATGPT_URL))
        self.assertIsNone(headless.extract_conversation_id('https://evil.example/c/'+CONVERSATION_ID))
        self.assertIsNone(headless.extract_conversation_id(None))

    def test_launch_options_stay_headed_and_park_window_offscreen(self):
        for mode in ('login','ask'):
            options=headless.launch_options(mode)
            self.assertFalse(options['headless'])
        self.assertEqual(headless.launch_options('ask')['args'],['--window-position=-2000,-2000'])
        self.assertEqual(headless.launch_options('login')['args'],[])


class AskFlowTests(unittest.TestCase):
    def scripted(self,submit='clicked'):
        return ScriptedPage({
            headless.FIND_EDITOR_JS:['found'],
            headless.FOCUS_EDITOR_JS:['focused'],
            headless.READ_EDITOR_JS:['hi'],
            headless.READ_REPLIES_JS:[json.dumps({'count':0,'text':''}),
                                      json.dumps({'count':1,'text':'回复内容'}),
                                      json.dumps({'count':1,'text':'回复内容'})],
            headless.SUBMIT_EDITOR_JS:[submit],
            headless.STOP_ACTIVE_JS:[False,False],
        })

    def test_ask_happy_path_emits_single_json_result(self):
        factory,playwright,context,calls=fake_factory(self.scripted())
        code,output=run_capturing(headless.run_ask,ns(),('hi'),context_factory=factory,poll=0,
                                  editor_timeout=0.01,reply_timeout=1)
        self.assertEqual(code,0)
        lines=[line for line in output.splitlines() if line.strip()]
        self.assertEqual(len(lines),1)
        data=json.loads(lines[0])
        self.assertEqual(data['status'],'ok'); self.assertEqual(data['reply'],'回复内容')
        self.assertEqual(data['conversationId'],CONVERSATION_ID); self.assertEqual(data['url'],PAGE_URL)
        self.assertEqual(calls,[('/tmp/profile','ask')])
        self.assertEqual(context.pages[0].goto_calls,['https://chatgpt.com/'])
        self.assertEqual(context.pages[0].keyboard.typed,['hi'])
        self.assertEqual(context.pages[0].keyboard.keys,[])  # 唯一发送按钮可用时不按 Enter
        self.assertEqual(context.closed,1); self.assertEqual(playwright.stopped,1)

    def test_ask_falls_back_to_enter_when_no_unique_send_button(self):
        factory,playwright,context,calls=fake_factory(self.scripted(submit='no-submit'))
        code,output=run_capturing(headless.run_ask,ns(),('hi'),context_factory=factory,poll=0,
                                  editor_timeout=0.01,reply_timeout=1)
        self.assertEqual(code,0)
        self.assertEqual(context.pages[0].keyboard.keys,['Enter'])

    def test_ask_validates_conversation_id_before_touching_browser(self):
        def factory(profile,mode,channel='chrome'): raise AssertionError('browser must not launch')
        with self.assertRaises(headless.ToolError) as failure:
            headless.run_ask(ns(conversation='bad id'),'hi',context_factory=factory)
        self.assertEqual(failure.exception.code,'INPUT')

    def test_ask_fails_closed_when_composer_never_appears(self):
        page=ScriptedPage({headless.FIND_EDITOR_JS:['none']})
        factory,playwright,context,calls=fake_factory(page)
        with self.assertRaises(headless.ToolError) as failure:
            headless.run_ask(ns(),'hi',context_factory=factory,poll=0,editor_timeout=0.01,reply_timeout=1)
        self.assertEqual(failure.exception.code,'TIMEOUT'); self.assertEqual(failure.exception.exit_code,7)
        self.assertEqual(context.closed,1); self.assertEqual(playwright.stopped,1)

    def test_ask_rejects_ambiguous_composer(self):
        page=ScriptedPage({headless.FIND_EDITOR_JS:['ambiguous']})
        factory,playwright,context,calls=fake_factory(page)
        with self.assertRaises(headless.ToolError) as failure:
            headless.run_ask(ns(),'hi',context_factory=factory,poll=0,editor_timeout=0.01,reply_timeout=1)
        self.assertEqual(failure.exception.code,'AGENT'); self.assertEqual(failure.exception.exit_code,6)

    def test_ask_rejects_readback_mismatch_before_submitting(self):
        page=ScriptedPage({headless.FIND_EDITOR_JS:['found'],headless.FOCUS_EDITOR_JS:['focused'],
                           headless.READ_EDITOR_JS:['tampered']})
        factory,playwright,context,calls=fake_factory(page)
        with self.assertRaises(headless.ToolError) as failure:
            headless.run_ask(ns(),'hi',context_factory=factory,poll=0,editor_timeout=0.01,reply_timeout=1)
        self.assertEqual(failure.exception.code,'INPUT'); self.assertEqual(failure.exception.exit_code,4)
        self.assertEqual(context.pages[0].keyboard.keys,[])

    def test_ask_times_out_when_reply_never_arrives(self):
        page=ScriptedPage({headless.FIND_EDITOR_JS:['found'],headless.FOCUS_EDITOR_JS:['focused'],
                           headless.READ_EDITOR_JS:['hi'],
                           headless.READ_REPLIES_JS:[json.dumps({'count':0,'text':''}),
                                                     json.dumps({'count':0,'text':''})],
                           headless.SUBMIT_EDITOR_JS:['clicked'],headless.STOP_ACTIVE_JS:[False]})
        factory,playwright,context,calls=fake_factory(page)
        with self.assertRaises(headless.ToolError) as failure:
            headless.run_ask(ns(),'hi',context_factory=factory,poll=0,editor_timeout=0.01,reply_timeout=0.02)
        self.assertEqual(failure.exception.code,'TIMEOUT'); self.assertEqual(failure.exception.exit_code,7)
        self.assertEqual(context.closed,1); self.assertEqual(playwright.stopped,1)


class LoginFlowTests(unittest.TestCase):
    def test_login_reports_success_once_detected(self):
        factory,playwright,context,calls=fake_factory(ScriptedPage({headless.LOGGED_IN_JS:[True]}))
        code,output=run_capturing(headless.run_login,ns(),context_factory=factory,poll=0)
        self.assertEqual(code,0)
        lines=[line for line in output.splitlines() if line.strip()]
        self.assertEqual(lines,[json.dumps({'status':'ok','loggedIn':True})])
        self.assertEqual(calls,[('/tmp/profile','login')])
        self.assertEqual(context.pages[0].goto_calls,['https://chatgpt.com/'])
        self.assertEqual(context.closed,1); self.assertEqual(playwright.stopped,1)

    def test_login_times_out_without_detection(self):
        factory,playwright,context,calls=fake_factory(ScriptedPage({headless.LOGGED_IN_JS:[False]}))
        with self.assertRaises(headless.ToolError) as failure:
            headless.run_login(ns(timeout=0.01),context_factory=factory,poll=0)
        self.assertEqual(failure.exception.code,'TIMEOUT'); self.assertEqual(failure.exception.exit_code,7)
        self.assertEqual(context.closed,1); self.assertEqual(playwright.stopped,1)


class MainEntrypointTests(unittest.TestCase):
    def test_main_dispatches_ask_with_resolved_prompt(self):
        with patch.object(headless,'run_ask') as fake:
            self.assertEqual(headless.main(['ask','--prompt','hi']),fake.return_value)
        args,_=fake.call_args
        self.assertEqual(args[0].mode,'ask'); self.assertEqual(args[1],'hi')

    def test_main_dispatches_login_without_prompt_resolution(self):
        with patch.object(headless,'run_login') as fake:
            self.assertEqual(headless.main(['login']),fake.return_value)
        args,_=fake.call_args
        self.assertEqual(args[0].mode,'login')

    def test_main_ask_reads_prompt_from_stdin(self):
        with patch.object(headless,'run_ask') as fake, patch.object(sys,'stdin',FakeStdin('来自 stdin')):
            headless.main(['ask'])
        args,_=fake.call_args
        self.assertEqual(args[1],'来自 stdin')

    def test_main_ask_fails_closed_when_prompt_missing_everywhere(self):
        with patch.object(sys,'stdin',FakeStdin('   ')):
            with self.assertRaises(headless.ToolError) as failure:
                headless.main(['ask'])
        self.assertEqual(failure.exception.code,'INPUT'); self.assertEqual(failure.exception.exit_code,2)


if __name__=='__main__': unittest.main()
