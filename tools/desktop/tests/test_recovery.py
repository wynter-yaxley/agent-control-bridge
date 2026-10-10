import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from recovery import Recovery
from desktop_common import DesktopAuthority, ToolError, redact
class RecoveryTests(unittest.TestCase):
 def test_report_approval_restart_windows_cdp_and_mapping_sequence(self):
  authority=DesktopAuthority();events=[];state=['exited']
  def restart(args):
   self.assertEqual(args,['--remote-debugging-port=9222','--remote-allow-origins=*']);events.append('restart');state[0]='running'
  recovery=Recovery(authority,lambda event:events.append('report'),lambda:state[0],restart,lambda:events.append('mapping') or True)
  self.assertEqual(recovery.detect(),'REPORTED')
  with self.assertRaises(ToolError):recovery.resume({'approved':True})
  self.assertEqual(recovery.resume(authority.approve(recovery.approval_operation)),'READY');self.assertEqual(events,['report','restart','mapping'])
 def test_unknown_or_running_process_never_restarted(self):
  authority=DesktopAuthority();recovery=Recovery(authority,lambda event:None,lambda:'unknown',lambda args:self.fail('restart'),lambda:True)
  recovery.detect()
  with self.assertRaises(ToolError):recovery.resume(authority.approve(recovery.approval_operation))
 def test_mapping_failure_blocks_resume(self):
  authority=DesktopAuthority();state=['exited'];recovery=Recovery(authority,lambda event:None,lambda:state[0],lambda args:state.__setitem__(0,'running'),lambda:False)
  recovery.detect()
  with self.assertRaises(ToolError):recovery.resume(authority.approve(recovery.approval_operation))
  self.assertEqual(recovery.state,'MAPPING_BLOCKED')
 def test_desktop_messages_redact_nested_secret_fields(self):
  self.assertEqual(redact({'secret':'synthetic-fixture','text':'password=synthetic-fixture'})['secret'],'[REDACTED]')
