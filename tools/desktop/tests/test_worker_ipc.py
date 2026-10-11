import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_common as common
import worker_ipc
from capability import issue

SECRET = 'test-secret-' + 'x' * 30


class WorkerIpcTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, {'ACB_IPC_SECRET': SECRET})
        self._env.start()
        self._tmp = tempfile.TemporaryDirectory()
        self._nonce_env = patch.dict(os.environ, {'ACB_NONCE_STORE': os.path.join(self._tmp.name, 'nonces.json')})
        self._nonce_env.start()

    def tearDown(self):
        self._nonce_env.stop()
        self._tmp.cleanup()
        self._env.stop()

    def test_missing_fields_rejected(self):
        with self.assertRaises(common.ToolError):
            worker_ipc.handle({'requestId': 'r1'})

    def test_invalid_capability_rejected(self):
        req = {'requestId': 'r1', 'operation': 'codex_send', 'capability': 'not-a-token', 'binding': 'b1'}
        with self.assertRaises(common.ToolError) as e:
            worker_ipc.handle(req)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_wrong_operation_rejected(self):
        token = issue({'operation': 'gpt_send', 'binding': 'b1'}, secret=SECRET)
        req = {'requestId': 'r1', 'operation': 'codex_send', 'capability': token, 'binding': 'b1'}
        with self.assertRaises(common.ToolError) as e:
            worker_ipc.handle(req)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_valid_request_dispatches(self):
        token = issue({'operation': 'codex_send', 'binding': 'b1'}, secret=SECRET)
        req = {'requestId': 'r1', 'operation': 'codex_send', 'capability': token, 'binding': 'b1',
               'prompt': 'hello', 'targetContext': {}}
        with patch.object(worker_ipc, '_dispatch', return_value=(0, {'operation': 'codex_send'})) as dispatch:
            exit_code, result = worker_ipc.handle(req)
        self.assertEqual(exit_code, 0)
        self.assertTrue(dispatch.called)

    def test_replay_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'b1'}, secret=SECRET)
        req = {'requestId': 'r1', 'operation': 'codex_send', 'capability': token, 'binding': 'b1',
               'prompt': 'hello', 'targetContext': {}}
        with patch.object(worker_ipc, '_dispatch', return_value=(0, {})):
            worker_ipc.handle(req)
        with patch.object(worker_ipc, '_dispatch', return_value=(0, {})):
            with self.assertRaises(common.ToolError) as e:
                worker_ipc.handle(req)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_prompt_hash_mismatch_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'b1', 'promptHash': 'deadbeef'}, secret=SECRET)
        req = {'requestId': 'r1', 'operation': 'codex_send', 'capability': token, 'binding': 'b1',
               'prompt': 'hello', 'targetContext': {}}
        with patch.object(worker_ipc, '_dispatch', return_value=(0, {})):
            with self.assertRaises(common.ToolError) as e:
                worker_ipc.handle(req)
        self.assertEqual(e.exception.code, 'AUTH')


if __name__ == '__main__':
    unittest.main()
