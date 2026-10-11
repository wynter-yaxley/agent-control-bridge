"""Pure-function and fake-CDP tests for chatgpt_worker (no real instance, no real subprocess)."""
import unittest, sys, json, argparse
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chatgpt_worker as worker
import chatgpt_headless as headless

CONVERSATION_ID = '11111111-2222-3333-4444-555555555555'
CONVERSATION_URL = 'https://chatgpt.com/c/' + CONVERSATION_ID


class UnscriptedEvaluate(BaseException):
    """FakeConnection 遇到未脚本化的求值时抛出；BaseException 以穿透 wait_* 的瞬时异常兜底分支。"""


def extraction(messages):
    return json.dumps({'messages': messages, 'diagnostics': {'nodesScanned': 1, 'messagesFound': len(messages)}})


class FakeConnection:
    """按 JS 常量精确匹配返回脚本化结果；未脚本化的求值视为测试失败。
    脚本队列耗尽时粘住最后一个值（模拟轮询分支的稳态），而不是直接报错。"""
    def __init__(self, script=None):
        self.script = {key: list(value) for key, value in (script or {}).items()}
        self.last = {}
        self.calls = []
        self.closed = 0
    def evaluate(self, js):
        if js not in self.script:
            raise UnscriptedEvaluate('unexpected evaluate: ' + js[:60])
        self.calls.append(js)
        if self.script[js]:
            self.last[js] = self.script[js].pop(0)
        if js not in self.last:
            raise UnscriptedEvaluate('script exhausted: ' + js[:60])
        return self.last[js]
    def call(self, method, params):
        self.calls.append((method, params))
        return {}
    def close(self):
        self.closed += 1


class FakeProcess:
    def __init__(self, pid=777): self.pid = pid


def ns(**overrides):
    defaults = {'mode': 'ask', 'prompt': None, 'conversation': None, 'port': worker.DEFAULT_PORT,
                'profile': None, 'exe': None, 'timeout': None}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def run_capturing(fn, *args, **kwargs):
    buffer = StringIO()
    with redirect_stdout(buffer):
        result = fn(*args, **kwargs)
    return result, buffer.getvalue()


def single_json(output):
    lines = [line for line in output.splitlines() if line.strip()]
    assert len(lines) == 1, 'stdout must be exactly one JSON line, got: %r' % output
    return json.loads(lines[0])


class ArgumentParsingTests(unittest.TestCase):
    def test_parse_args_defaults_target_second_instance(self):
        args = worker.parse_args(['start'])
        self.assertEqual(args.mode, 'start')
        self.assertEqual(args.port, 9224)
        self.assertIsNone(args.conversation)
        self.assertIsNone(args.timeout)

    def test_parse_args_ask_keeps_prompt_optional_stdin_fallback(self):
        args = worker.parse_args(['ask'])
        self.assertEqual(args.mode, 'ask')
        self.assertIsNone(args.prompt)

    def test_parse_args_rejects_unknown_mode_as_structured_error(self):
        with self.assertRaises(worker.ToolError) as failure:
            worker.parse_args(['send'])
        self.assertEqual(failure.exception.code, 'INPUT')
        self.assertEqual(failure.exception.exit_code, 2)

    def test_parse_args_rejects_non_positive_timeout(self):
        for value in ('0', '-1'):
            with self.assertRaises(worker.ToolError) as failure:
                worker.parse_args(['ask', '--prompt', 'x', '--timeout', value])
            self.assertEqual(failure.exception.code, 'INPUT')

    def test_parse_args_rejects_out_of_range_port(self):
        for value in ('0', '65536'):
            with self.assertRaises(worker.ToolError) as failure:
                worker.parse_args(['start', '--port', value])
            self.assertEqual(failure.exception.code, 'INPUT')


class PromptAndGateTests(unittest.TestCase):
    def test_resolve_prompt_prefers_flag_over_stdin(self):
        self.assertEqual(worker.resolve_prompt(ns(prompt='flag'), 'stdin text'), 'flag')
        self.assertEqual(worker.resolve_prompt(ns(prompt=None), 'stdin text'), 'stdin text')

    def test_resolve_prompt_rejects_empty_as_structured_error(self):
        with self.assertRaises(worker.ToolError) as failure:
            worker.resolve_prompt(ns(prompt=None), '   ')
        self.assertEqual(failure.exception.code, 'INPUT')
        self.assertEqual(failure.exception.exit_code, 2)

    def test_resolve_prompt_rejects_authentication_material(self):
        with self.assertRaises(worker.ToolError) as failure:
            worker.resolve_prompt(ns(prompt='sk-' + 'a' * 30), '')
        self.assertEqual(failure.exception.code, 'INPUT')

    def test_validate_conversation_id_rejects_path_injection(self):
        for value in (None, '', '../settings', 'bad id'):
            with self.assertRaises(worker.ToolError) as failure:
                worker.validate_conversation_id(value)
            self.assertEqual(failure.exception.code, 'INPUT')
        self.assertEqual(worker.validate_conversation_id(CONVERSATION_ID), CONVERSATION_ID)

    @unittest.skipIf(sys.platform == 'win32', 'gate only raises off the Windows host')
    def test_require_windows_fails_closed_off_windows(self):
        with self.assertRaises(worker.ToolError) as failure:
            worker.require_windows()
        self.assertEqual(failure.exception.code, 'DEPENDENCY')
        self.assertEqual(failure.exception.exit_code, 6)

    @unittest.skipIf(sys.platform == 'win32', 'gate test requires a non-Windows host')
    def test_main_refuses_to_start_off_windows(self):
        with self.assertRaises(worker.ToolError) as failure:
            worker.main(['start'])
        self.assertEqual(failure.exception.code, 'DEPENDENCY')


class LaunchArgsTests(unittest.TestCase):
    def test_hidden_launch_args_match_verified_second_instance_flags(self):
        args = worker.build_launch_args('C:\\app\\ChatGPT.exe', 9224, r'C:\p\profile', visible=False)
        self.assertEqual(args, ['C:\\app\\ChatGPT.exe', '--remote-debugging-port=9224',
                                '--remote-allow-origins=*', '--user-data-dir=C:\\p\\profile',
                                '--window-position=-2000,-2000'])

    def test_login_launch_args_leave_window_visible(self):
        args = worker.build_launch_args('C:\\app\\ChatGPT.exe', 9224, r'C:\p\profile', visible=True)
        self.assertNotIn('--window-position=-2000,-2000', args)
        self.assertIn('--remote-allow-origins=*', args)
        self.assertIn('--remote-debugging-port=9224', args)


class ListenerPidTests(unittest.TestCase):
    def run_netstat(self, stdout, raising=False):
        def fake_run(*args, **kwargs):
            if raising:
                raise OSError('netstat unavailable')
            return argparse.Namespace(stdout=stdout)
        with patch.object(worker.subprocess, 'run', side_effect=fake_run):
            return worker.listener_pid(9224)

    def test_parses_listening_pid_for_port(self):
        stdout = ('  TCP    127.0.0.1:9222      0.0.0.0:0    LISTENING    1234\r\n'
                  '  TCP    127.0.0.1:9224      0.0.0.0:0    LISTENING    4321\r\n')
        self.assertEqual(self.run_netstat(stdout), 4321)

    def test_returns_none_without_listener_or_pid(self):
        self.assertIsNone(self.run_netstat('  TCP    127.0.0.1:9222      0.0.0.0:0    LISTENING    1234\r\n'))
        self.assertIsNone(self.run_netstat('  TCP    127.0.0.1:9224      0.0.0.0:0    LISTENING    notapid\r\n'))
        self.assertIsNone(self.run_netstat('', raising=True))


class StartTests(unittest.TestCase):
    def test_start_reuses_already_running_instance_without_launching(self):
        with patch.object(worker, 'version_reachable', return_value={'Browser': 'x'}), \
             patch.object(worker, 'listener_pid', return_value=4321), \
             patch.object(worker.subprocess, 'Popen', side_effect=AssertionError('must not launch')):
            code, output = run_capturing(worker.run_start, ns(mode='start'))
        self.assertEqual(code, 0)
        self.assertEqual(single_json(output), {'status': 'ok', 'pid': 4321, 'port': 9224, 'alreadyRunning': True})

    def test_start_launches_hidden_instance_with_verified_flags(self):
        calls = {}
        def fake_popen(command, **kwargs):
            calls['command'] = command
            calls['kwargs'] = kwargs
            return FakeProcess(777)
        versions = [None, {'Browser': 'x'}, {'Browser': 'x'}]
        with patch.object(worker, 'version_reachable', side_effect=lambda port: versions.pop(0)), \
             patch.object(worker.subprocess, 'Popen', side_effect=fake_popen):
            code, output = run_capturing(worker.run_start, ns(mode='start'))
        self.assertEqual(code, 0)
        self.assertEqual(single_json(output), {'status': 'ok', 'pid': 777, 'port': 9224, 'alreadyRunning': False})
        self.assertEqual(calls['command'], worker.build_launch_args(worker.resolve_exe(ns()), 9224,
                                                                    worker.resolve_profile(ns()), visible=False))
        self.assertEqual(calls['kwargs']['stdin'], worker.subprocess.DEVNULL)
        self.assertEqual(calls['kwargs']['stdout'], worker.subprocess.DEVNULL)
        self.assertEqual(calls['kwargs']['stderr'], worker.subprocess.DEVNULL)

    def test_start_times_out_when_debugging_port_never_opens(self):
        with patch.object(worker, 'version_reachable', return_value=None), \
             patch.object(worker.subprocess, 'Popen', return_value=FakeProcess(777)):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_start(ns(mode='start', timeout=0.01), poll=0)
        self.assertEqual(failure.exception.code, 'TIMEOUT')
        self.assertEqual(failure.exception.exit_code, 7)

    def test_ensure_running_passes_visible_flag_for_login(self):
        calls = []
        with patch.object(worker, 'version_reachable', side_effect=[None, {'Browser': 'x'}]), \
             patch.object(worker, 'launch', side_effect=lambda exe, port, profile, visible: calls.append(visible) or FakeProcess()):
            worker.ensure_running('exe', 9224, 'profile', visible=True, timeout=0.01, poll=0)
        self.assertEqual(calls, [True])

    def test_find_webview_ws_filters_chatgpt_targets_and_validates_endpoint(self):
        good = {'type': 'page', 'url': 'https://chatgpt.com/', 'webSocketDebuggerUrl': 'ws://127.0.0.1:9224/devtools/page/1'}
        with patch.object(worker, 'list_targets', return_value=[good]):
            self.assertEqual(worker.find_webview_ws(9224), good['webSocketDebuggerUrl'])

    def test_find_webview_ws_rejects_untrusted_endpoints_and_ambiguity(self):
        good = {'type': 'page', 'url': 'https://chatgpt.com/', 'webSocketDebuggerUrl': 'ws://127.0.0.1:9224/devtools/page/1'}
        evil = {'type': 'page', 'url': 'https://chatgpt.com/', 'webSocketDebuggerUrl': 'ws://evil.example:9224/x'}
        wrong_port = {'type': 'page', 'url': 'https://chatgpt.com/', 'webSocketDebuggerUrl': 'ws://127.0.0.1:9222/x'}
        with patch.object(worker, 'list_targets', return_value=[good, evil]):
            with self.assertRaises(worker.ToolError) as failure:
                worker.find_webview_ws(9224)
            self.assertEqual(failure.exception.code, 'AGENT')
        with patch.object(worker, 'list_targets', return_value=[dict(good, webSocketDebuggerUrl=wrong_port['webSocketDebuggerUrl'])]):
            with self.assertRaises(worker.ToolError) as failure:
                worker.find_webview_ws(9224)
            self.assertEqual(failure.exception.code, 'CONFIG')


class LoginTests(unittest.TestCase):
    def test_login_reports_success_once_detected(self):
        ensured = []
        with patch.object(worker, 'ensure_running',
                          side_effect=lambda exe, port, profile, visible: ensured.append(visible) or {'alreadyRunning': False, 'pid': 5}), \
             patch.object(worker, 'is_logged_in', side_effect=[False, True]):
            code, output = run_capturing(worker.run_login, ns(mode='login'), poll=0)
        self.assertEqual(code, 0)
        self.assertEqual(single_json(output), {'status': 'ok', 'loggedIn': True})
        self.assertEqual(ensured, [True])  # login 必须弹可见窗口

    def test_login_times_out_without_detection(self):
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': False, 'pid': 5}), \
             patch.object(worker, 'is_logged_in', return_value=False):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_login(ns(mode='login', timeout=0.01), poll=0)
        self.assertEqual(failure.exception.code, 'TIMEOUT')
        self.assertEqual(failure.exception.exit_code, 7)

    def test_login_waits_for_webview_before_declaring_logged_out(self):
        # find_webview_ws 失败（webview 尚未出现）一律视为未登录，不得误报成功
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': False, 'pid': 5}), \
             patch.object(worker, 'find_webview_ws', side_effect=worker.ToolError('AGENT', 'no target', 6)), \
             patch.object(worker.Cdp, 'evaluate', side_effect=AssertionError('no connection without a webview')):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_login(ns(mode='login', timeout=0.01), poll=0)
        self.assertEqual(failure.exception.code, 'TIMEOUT')


class AskFlowTests(unittest.TestCase):
    def scripted_connection(self, prompt='hi', reply='回复内容'):
        return FakeConnection({
            worker.CHECK_EDITOR: ['found', 'found'],
            worker.EXTRACT: [extraction([{'role': 'assistant', 'text': 'old'}]),
                             extraction([{'role': 'assistant', 'text': 'old'},
                                         {'role': 'assistant', 'text': reply}]),
                             extraction([{'role': 'assistant', 'text': 'old'},
                                         {'role': 'assistant', 'text': reply}])],
            worker.READ_EDITOR: ['', prompt],
            worker.SUBMIT_EDITOR: ['clicked'],
            worker.STOP_ACTIVE_JS: [False, False],
        })

    def test_ask_happy_path_emits_single_json_reply(self):
        connection = self.scripted_connection()
        pasted = []
        def fake_paste(conn, target, text, **kwargs):
            pasted.append(text)
            return {'status': 'success'}
        ensured = []
        with patch.object(worker, 'ensure_running',
                          side_effect=lambda exe, port, profile, visible: ensured.append(visible) or {'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'paste_text', side_effect=fake_paste), \
             patch.object(worker, 'Cdp', return_value=connection):
            code, output = run_capturing(worker.run_ask, ns(mode='ask', prompt='hi'), 'hi',
                                         editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(code, 0)
        self.assertEqual(single_json(output), {'status': 'ok', 'reply': '回复内容'})
        self.assertEqual(ensured, [False])  # ask 模式窗口必须隐藏
        self.assertEqual(pasted, ['hi'])
        self.assertNotIn(('Page.navigate', {'url': CONVERSATION_URL}), connection.calls)
        self.assertEqual(connection.closed, 1)

    def test_ask_navigates_to_conversation_when_id_given(self):
        connection = self.scripted_connection()
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'paste_text', return_value={'status': 'success'}), \
             patch.object(worker, 'Cdp', return_value=connection):
            code, output = run_capturing(worker.run_ask, ns(mode='ask', prompt='hi', conversation=CONVERSATION_ID),
                                         'hi', editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(code, 0)
        self.assertIn(('Page.navigate', {'url': CONVERSATION_URL}), connection.calls)

    def test_ask_validates_conversation_id_before_touching_the_instance(self):
        with patch.object(worker, 'ensure_running', side_effect=AssertionError('must not launch')):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask', conversation='bad id'), 'hi')
        self.assertEqual(failure.exception.code, 'INPUT')

    def test_ask_fails_closed_when_composer_never_appears(self):
        connection = FakeConnection({worker.CHECK_EDITOR: ['none']})
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'Cdp', return_value=connection):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask'), 'hi', editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(failure.exception.code, 'TIMEOUT')
        self.assertEqual(failure.exception.exit_code, 7)
        self.assertEqual(connection.closed, 1)

    def test_ask_rejects_ambiguous_composer(self):
        connection = FakeConnection({worker.CHECK_EDITOR: ['ambiguous']})
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'Cdp', return_value=connection):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask'), 'hi', editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(failure.exception.code, 'AGENT')
        self.assertEqual(failure.exception.exit_code, 6)

    def test_ask_refuses_to_submit_over_an_existing_draft(self):
        connection = FakeConnection({worker.CHECK_EDITOR: ['found', 'found'],
                                     worker.EXTRACT: [extraction([{'role': 'assistant', 'text': 'old'}])],
                                     worker.READ_EDITOR: ['draft text']})
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'Cdp', return_value=connection):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask'), 'hi', editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(failure.exception.code, 'DRAFT_PRESENT')

    def test_ask_rejects_readback_mismatch_before_submitting(self):
        connection = FakeConnection({worker.CHECK_EDITOR: ['found', 'found'],
                                     worker.EXTRACT: [extraction([{'role': 'assistant', 'text': 'old'}])],
                                     worker.READ_EDITOR: ['', 'tampered']})
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'paste_text', return_value={'status': 'success'}), \
             patch.object(worker, 'Cdp', return_value=connection):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask'), 'hi', editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(failure.exception.code, 'PASTE_MISMATCH')
        self.assertNotIn(worker.SUBMIT_EDITOR, connection.calls)

    def test_ask_fails_when_no_unique_submit_button(self):
        connection = FakeConnection({worker.CHECK_EDITOR: ['found', 'found'],
                                     worker.EXTRACT: [extraction([{'role': 'assistant', 'text': 'old'}])],
                                     worker.READ_EDITOR: ['', 'hi'],
                                     worker.SUBMIT_EDITOR: ['no-submit']})
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'paste_text', return_value={'status': 'success'}), \
             patch.object(worker, 'Cdp', return_value=connection):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask'), 'hi', editor_timeout=0.01, reply_timeout=1)
        self.assertEqual(failure.exception.code, 'EXECUTION')

    def test_ask_times_out_when_reply_never_arrives(self):
        connection = FakeConnection({
            worker.CHECK_EDITOR: ['found', 'found'],
            worker.EXTRACT: [extraction([{'role': 'assistant', 'text': 'old'}]),
                             extraction([{'role': 'assistant', 'text': 'old'}]),
                             extraction([{'role': 'assistant', 'text': 'old'}])],
            worker.READ_EDITOR: ['', 'hi'],
            worker.SUBMIT_EDITOR: ['clicked'],
            worker.STOP_ACTIVE_JS: [False, False],
        })
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'paste_text', return_value={'status': 'success'}), \
             patch.object(worker, 'Cdp', return_value=connection):
            with self.assertRaises(worker.ToolError) as failure:
                worker.run_ask(ns(mode='ask'), 'hi', editor_timeout=0.01, reply_timeout=0.02)
        self.assertEqual(failure.exception.code, 'TIMEOUT')
        self.assertEqual(failure.exception.exit_code, 7)
        self.assertEqual(connection.closed, 1)

    def test_ask_uses_ask_timeout_default_when_timeout_flag_absent(self):
        # 不传 --timeout 时必须使用 ASK_TIMEOUT_SECONDS 兜底，而不是无限等待
        seen = {}
        def spy_wait(connection, baseline, timeout, poll=worker.POLL_INTERVAL_SECONDS):
            seen['timeout'] = timeout
            raise worker.ToolError('TIMEOUT', 'stop', 7)
        with patch.object(worker, 'ensure_running', return_value={'alreadyRunning': True, 'pid': 5}), \
             patch.object(worker, 'wait_for_webview', return_value='ws://127.0.0.1:9224/devtools/page/1'), \
             patch.object(worker, 'paste_text', return_value={'status': 'success'}), \
             patch.object(worker, 'Cdp', return_value=FakeConnection({worker.CHECK_EDITOR: ['found', 'found'],
                                                                      worker.EXTRACT: [extraction([])],
                                                                      worker.READ_EDITOR: ['', 'hi'],
                                                                      worker.SUBMIT_EDITOR: ['clicked']})), \
             patch.object(worker, 'wait_for_reply', side_effect=spy_wait):
            with self.assertRaises(worker.ToolError):
                worker.run_ask(ns(mode='ask', timeout=None), 'hi')
        self.assertEqual(seen['timeout'], worker.ASK_TIMEOUT_SECONDS)


class ParseExtractionTests(unittest.TestCase):
    def test_counts_only_assistant_messages_with_text(self):
        raw = extraction([{'role': 'user', 'text': 'q'}, {'role': 'assistant', 'text': 'a'},
                          {'role': 'assistant', 'text': ''}, {'role': 'assistant'}])
        self.assertEqual(worker.parse_extraction(raw), (1, 'a'))

    def test_rejects_unexpected_shape(self):
        for raw in (None, '[', '{"messages": 5}', '{"messages": "x"}'):
            with self.assertRaises(worker.ToolError) as failure:
                worker.parse_extraction(raw)
            self.assertEqual(failure.exception.code, 'AGENT')

    def test_empty_conversation_yields_zero_baseline(self):
        self.assertEqual(worker.parse_extraction('{}'), (0, None))


if __name__ == '__main__':
    unittest.main()
