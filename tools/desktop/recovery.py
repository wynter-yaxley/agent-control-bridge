"""Restart workflow for a trusted host. CLI only diagnoses; never restarts or focuses an app."""
import argparse, json, subprocess, sys, uuid
from pathlib import Path
from urllib.parse import urlparse
from desktop_common import config, targets, ToolError, entry

class Recovery:
    def __init__(self, authority, notify, probe, restart, restore_mapping):
        self.authority=authority; self.notify=notify; self.probe=probe
        self.restart=restart; self.restore_mapping=restore_mapping; self.state='HEALTHY'
        self.approval_operation=None
    def detect(self):
        # A failed CDP probe alone cannot establish an application crash.
        observation=self.probe()
        if observation=='running': return self.state
        if observation not in ('exited','unknown'): raise ToolError('INPUT','Invalid process observation',2)
        if self.state=='REPORTED': return self.state
        self.approval_operation='chatgpt-restart:'+uuid.uuid4().hex
        self.state='REPORTED'; self.notify({'event':'application_unavailable','crashConfirmed':observation=='exited','requiresApproval':True})
        return self.state
    def resume(self, approval):
        if self.state == 'REPORTED':
            self.authority.consume(approval,self.approval_operation)
            if self.probe()!='exited': raise ToolError('AGENT','Process exit unconfirmed; do not restart a running application',6)
            # 先做配置/端口校验，失败时不改变状态（避免卡在 RESTARTING 无法自愈）
            settings=config(); endpoint=urlparse(settings['cdpUrl']);
            if endpoint.port is None:
                raise ToolError('CONFIG','CDP endpoint must specify an explicit port; refusing to fall back to 80',2)
            self.state='RESTARTING'
            self.restart(['--remote-debugging-port='+str(endpoint.port),'--remote-allow-origins='+settings['remoteAllowOrigins']])
            self.state='VERIFYING_CDP'
        elif self.state in ('VERIFYING_CDP','MAPPING_BLOCKED'):
            # 重试路径：重启已发生且授权已消费，只重试 verify/restore（临时故障可自愈）
            pass
        else:
            raise ToolError('STATE','Detect and report before recovery',4)
        if self.probe()!='running': raise ToolError('AGENT','Restart or CDP availability not verified',6)
        if not self.restore_mapping():
            self.state='MAPPING_BLOCKED'; raise ToolError('PROVENANCE','Restore the registered GPT conversation before delivery')
        self.state='READY'; return self.state

def start_authorized_executable(executable, args):
    """Called only by trusted host after Recovery consumed explicit per-incident approval."""
    if sys.platform!='win32': raise ToolError('DEPENDENCY','Desktop recovery requires Windows-side Python',6)
    path=Path(executable).resolve()
    if not path.is_file() or path.suffix.lower()!='.exe': raise ToolError('CONFIG','Configure the installed application executable',2)
    subprocess.Popen([str(path),*args],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                     shell=False,creationflags=subprocess.CREATE_NO_WINDOW)

def main():
    parser=argparse.ArgumentParser(description='Windows-side read-only CDP check; no application launch or restart')
    parser.add_argument('--check-cdp',action='store_true'); args=parser.parse_args()
    if not args.check_cdp: parser.print_help(); return 0
    if sys.platform!='win32': raise ToolError('DEPENDENCY','Use Windows-side Python; WSL loopback may be a different network namespace',6)
    available=targets()
    print(json.dumps({'cdpReachable':True,'targetCount':len(available),'modelVerified':False,'mappingRestored':False}))
if __name__=='__main__': sys.exit(entry(main))
