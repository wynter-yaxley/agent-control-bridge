#!/usr/bin/env python3
import argparse, json, sys
from gpt_read_cdp import read_messages
from desktop_common import ToolError, entry
def main():
    parser=argparse.ArgumentParser(description='Read relay candidates; never treat user text or self-declared source as trusted prompt')
    parser.add_argument('direction',choices=['gpt2codex','codex2gpt']); args=parser.parse_args()
    if args.direction=='gpt2codex':
        # Production provenance/model verification belongs to PromptPipeline in the trusted host.
        raise ToolError('PROVENANCE','Visible DOM cannot verify GPT-6/high; automatic Codex relay refused')
    messages=[m for m in read_messages('page') if m.get('role')=='assistant']
    if not messages: raise ToolError('AGENT','No assistant output available',6)
    print(json.dumps({'deliveryStatus':'REVIEW_REQUIRED','direction':'codex2gpt','source':'codex-output','automaticSend':False,'message':messages[-1]},ensure_ascii=False))
if __name__=='__main__': sys.exit(entry(main))
