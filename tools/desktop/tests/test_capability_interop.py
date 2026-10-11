import os
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_common as common
from capability import verify

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SECRET = 'interop-secret-' + 'x' * 26

GEN_SCRIPT = r"""
import { issueCapability } from ${MODULE_URL};
const token = issueCapability({ operation: '${OP}', binding: '${BIND}', promptHash: '${HASH}' }, '${SECRET}');
process.stdout.write(token);
"""


@unittest.skipUnless(shutil.which('node'), 'node is not available')
class CapabilityInteropTests(unittest.TestCase):
    """证明 Node issueCapability 与 Python verify 的 HMAC/序列化完全兼容。"""

    def _node_token(self, operation='codex_send', binding='task-1', prompt_hash='abc123'):
        module_url = (PROJECT_ROOT / 'src' / 'desktop-ipc.ts').as_uri()
        script = GEN_SCRIPT.replace('${MODULE_URL}', json.dumps(module_url)).replace('${OP}', operation).replace('${BIND}', binding).replace('${HASH}', prompt_hash).replace('${SECRET}', SECRET)
        with tempfile.NamedTemporaryFile('w', suffix='.mts', delete=False) as f:
            f.write(script)
            path = f.name
        try:
            result = subprocess.run(
                ['node', '--experimental-strip-types', path],
                cwd=str(PROJECT_ROOT), capture_output=True, text=True, timeout=30,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if result.returncode != 0:
                self.fail('Node capability generator failed; private subprocess diagnostics omitted')
            return result.stdout.strip()
        finally:
            os.unlink(path)

    def test_node_token_verifies_in_python(self):
        with patch.dict(os.environ, {'ACB_IPC_SECRET': SECRET}):
            token = self._node_token()
            payload = verify(token, 'codex_send', 'task-1')
        self.assertEqual(payload['operation'], 'codex_send')
        self.assertEqual(payload['promptHash'], 'abc123')
        self.assertTrue(payload['nonce'])

    def test_node_token_with_wrong_binding_rejected(self):
        with patch.dict(os.environ, {'ACB_IPC_SECRET': SECRET}):
            token = self._node_token()
            with self.assertRaises(common.ToolError) as e:
                verify(token, 'codex_send', 'other-binding')
        self.assertEqual(e.exception.code, 'AUTH')


if __name__ == '__main__':
    unittest.main()
