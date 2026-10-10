#!/usr/bin/env python3
import argparse, json, sys
from gpt_read_cdp import read_messages
from desktop_common import entry
def main():
    parser=argparse.ArgumentParser(description='Bounded role/text/sourceMessageId extraction')
    parser.add_argument('kind',choices=['webview','page']); args=parser.parse_args()
    print(json.dumps(read_messages(args.kind),ensure_ascii=False))
if __name__=='__main__': sys.exit(entry(main))
