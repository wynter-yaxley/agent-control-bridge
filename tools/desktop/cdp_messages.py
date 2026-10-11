#!/usr/bin/env python3
"""Bounded role/text/sourceMessageId extraction over CDP-visible DOM.

只读可见对话的受限字段（role/text/sourceMessageId）；不访问 Cookie/profile，
也不把可见 DOM 当作授权或模型真实性证明。
"""
import argparse, json, sys
from gpt_read_cdp import read_messages
from desktop_common import entry
def main():
    parser=argparse.ArgumentParser(description='Bounded role/text/sourceMessageId extraction')
    parser.add_argument('kind',choices=['webview','page']); args=parser.parse_args()
    print(json.dumps(read_messages(args.kind),ensure_ascii=False))
if __name__=='__main__': sys.exit(entry(main))
