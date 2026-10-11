#!/usr/bin/env python3
"""Read-only relay candidate extraction; never treat user text or self-declared source as trusted prompt.

Visible DOM 只能提供候选，不能验证模型真实性。自动 Codex 转发被拒绝；
生产环境归属验证由可信主机的 PromptPipeline 完成。
"""
import argparse, json, sys
from gpt_read_cdp import read_messages
from desktop_common import ToolError, entry
def main():
    parser=argparse.ArgumentParser(description='Read relay candidates; never treat user text or self-declared source as trusted prompt')
    parser.add_argument('direction',choices=['gpt2codex','codex2gpt']); args=parser.parse_args()
    if args.direction=='gpt2codex':
        # 只读候选，不自动发送：真实 Codex 投递必须经受控 IPC 能力凭证（Node 签发）。
        messages=[m for m in read_messages('webview')['messages'] if m.get('role')=='user']
        if not messages: raise ToolError('AGENT','No user message available',6)
        print(json.dumps({'deliveryStatus':'REVIEW_REQUIRED','direction':'gpt2codex','source':'gpt-user','automaticSend':False,'message':messages[-1]},ensure_ascii=False))
        return 0
    messages=[m for m in read_messages('page')['messages'] if m.get('role')=='assistant']
    if not messages: raise ToolError('AGENT','No assistant output available',6)
    print(json.dumps({'deliveryStatus':'REVIEW_REQUIRED','direction':'codex2gpt','source':'codex-output','automaticSend':False,'message':messages[-1]},ensure_ascii=False))
    return 0
if __name__=='__main__': sys.exit(entry(main))
