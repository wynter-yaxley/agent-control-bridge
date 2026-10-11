import sys, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from recovery import Recovery
from desktop_common import DesktopAuthority, ToolError, redact

# 新契约：remoteAllowOrigins 必须为显式受限 origin（拒绝通配符）
VALID_CONFIG = {
    'enabled': True,
    'cdpUrl': 'http://127.0.0.1:9222',
    'remoteAllowOrigins': 'http://127.0.0.1:9222',
    'python': 'python',
    'allowForegroundAutomation': True,
    'allowPhysicalInput': False,
}

class RecoveryTests(unittest.TestCase):
    def test_report_approval_restart_windows_cdp_and_mapping_sequence(self):
        authority=DesktopAuthority(); events=[]; state=['exited']
        def restart(args):
            self.assertEqual(args, ['--remote-debugging-port=9222', '--remote-allow-origins=http://127.0.0.1:9222'])
            events.append('restart'); state[0]='running'
        recovery=Recovery(authority, lambda event: events.append('report'), lambda: state[0], restart, lambda: events.append('mapping') or True)
        with patch('recovery.config', return_value=VALID_CONFIG):
            self.assertEqual(recovery.detect(), 'REPORTED')
            with self.assertRaises(ToolError):
                recovery.resume({'approved': True})
            self.assertEqual(recovery.resume(authority.approve(recovery.approval_operation)), 'READY')
            self.assertEqual(events, ['report', 'restart', 'mapping'])

    def test_unknown_or_running_process_never_restarted(self):
        authority=DesktopAuthority()
        recovery=Recovery(authority, lambda event: None, lambda: 'unknown', lambda args: self.fail('restart'), lambda: True)
        recovery.detect()
        with self.assertRaises(ToolError):
            recovery.resume(authority.approve(recovery.approval_operation))

    def test_mapping_failure_blocks_resume(self):
        authority=DesktopAuthority(); state=['exited']
        recovery=Recovery(authority, lambda event: None, lambda: state[0], lambda args: state.__setitem__(0, 'running'), lambda: False)
        with patch('recovery.config', return_value=VALID_CONFIG):
            recovery.detect()
            with self.assertRaises(ToolError):
                recovery.resume(authority.approve(recovery.approval_operation))
        self.assertEqual(recovery.state, 'MAPPING_BLOCKED')

    def test_verify_cdp_transient_failure_can_retry(self):
        # P3-01: CDP 重启后瞬时未就绪（probe 返回 unknown）不应永久卡死；重试可自愈到 READY
        authority=DesktopAuthority()
        probe_seq=['exited', 'exited', 'unknown', 'running']
        def probe():
            return probe_seq.pop(0) if probe_seq else 'running'
        recovery=Recovery(authority, lambda event: None, probe, lambda args: None, lambda: True)
        with patch('recovery.config', return_value=VALID_CONFIG):
            recovery.detect()
            approval=authority.approve(recovery.approval_operation)
            with self.assertRaises(ToolError):
                recovery.resume(approval)
            self.assertEqual(recovery.state, 'VERIFYING_CDP')
            self.assertEqual(recovery.resume(approval), 'READY')

    def test_missing_port_is_rejected_not_fallback_80(self):
        # P2-02: endpoint 无显式端口时必须拒绝，不得回退 80
        authority=DesktopAuthority(); state=['exited']
        no_port = dict(VALID_CONFIG, cdpUrl='http://127.0.0.1')
        recovery=Recovery(authority, lambda event: None, lambda: state[0], lambda args: self.fail('restart'), lambda: True)
        with patch('recovery.config', return_value=no_port):
            recovery.detect()
            with self.assertRaises(ToolError) as ctx:
                recovery.resume(authority.approve(recovery.approval_operation))
            self.assertIn('explicit port', str(ctx.exception))

    def test_desktop_messages_redact_nested_secret_fields(self):
        self.assertEqual(redact({'secret': 'synthetic-fixture', 'text': 'password=synthetic-fixture'})['secret'], '[REDACTED]')
