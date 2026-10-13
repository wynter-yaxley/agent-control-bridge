import hashlib
import unittest
from unittest.mock import patch
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpt_read_cdp


class SnapshotTest(unittest.TestCase):
    def test_exact_visible_identity_and_body_hash_without_generation_authority(self):
        value = {'conversationId': 'fixture-gpt', 'browserTitle': 'fixture-project', 'responseInProgress': False,
                 'messages': [{'role': 'assistant', 'text': '完整回复', 'sourceMessageId': 'fixture-message'}],
                 'diagnostics': {'nodesScanned': 1}}
        with patch.object(gpt_read_cdp, 'find_target', return_value='fixture'), patch.object(gpt_read_cdp, 'Cdp') as client:
            client.return_value.evaluate.return_value = json.dumps(value)
            snapshot = gpt_read_cdp.read_messages(conversation_id='fixture-gpt')
            self.assertEqual(snapshot['messages'][0]['hash'], hashlib.sha256('完整回复'.encode()).hexdigest())
            self.assertFalse(snapshot['completionVerified'])
            self.assertIsNone(snapshot['actualModel'])
            with self.assertRaises(gpt_read_cdp.ToolError):
                gpt_read_cdp.read_messages(conversation_id='other-gpt')
            client.return_value.close.assert_called()
