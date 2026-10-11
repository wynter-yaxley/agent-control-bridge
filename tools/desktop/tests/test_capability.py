import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_common as common
from capability import NonceStore, issue, verify

SECRET = 'test-secret-' + 'x' * 30  # >=32 chars


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, {'ACB_IPC_SECRET': SECRET})
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def test_issue_and_verify_roundtrip(self):
        token = issue({'operation': 'codex_send', 'binding': 'task-1', 'promptHash': 'abc'}, secret=SECRET)
        payload = verify(token, 'codex_send', 'task-1', secret=SECRET)
        self.assertEqual(payload['operation'], 'codex_send')
        self.assertEqual(payload['promptHash'], 'abc')
        self.assertTrue(isinstance(payload['nonce'], str) and payload['nonce'])
        self.assertTrue(payload['expiresAt'] > 0)

    def test_wrong_binding_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'task-1'}, secret=SECRET)
        with self.assertRaises(common.ToolError) as e:
            verify(token, 'codex_send', 'task-2', secret=SECRET)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_wrong_operation_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'task-1'}, secret=SECRET)
        with self.assertRaises(common.ToolError):
            verify(token, 'gpt_send', 'task-1', secret=SECRET)

    def test_tampered_token_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'task-1'}, secret=SECRET)
        tampered = token[:-1] + ('0' if token[-1] != '0' else '1')
        with self.assertRaises(common.ToolError) as e:
            verify(tampered, 'codex_send', 'task-1', secret=SECRET)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_expired_token_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'task-1'}, secret=SECRET, ttl_seconds=-10)
        with self.assertRaises(common.ToolError) as e:
            verify(token, 'codex_send', 'task-1', secret=SECRET)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_wrong_secret_rejected(self):
        token = issue({'operation': 'codex_send', 'binding': 'task-1'}, secret=SECRET)
        with self.assertRaises(common.ToolError) as e:
            verify(token, 'codex_send', 'task-1', secret='z' * 40)
        self.assertEqual(e.exception.code, 'AUTH')

    def test_nonce_replay_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            store = NonceStore(os.path.join(folder, 'nonces.json'))
            store.consume('nonce-1')
            with self.assertRaises(common.ToolError) as e:
                store.consume('nonce-1')
            self.assertEqual(e.exception.code, 'AUTH')

    def test_nonce_store_survives_reopen(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, 'nonces.json')
            NonceStore(path).consume('persisted-nonce')
            with self.assertRaises(common.ToolError):
                NonceStore(path).consume('persisted-nonce')


if __name__ == '__main__':
    unittest.main()
