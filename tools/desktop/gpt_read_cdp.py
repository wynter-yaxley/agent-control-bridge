#!/usr/bin/env python3
import argparse, json, sys
from desktop_common import Cdp, find_target, entry, ToolError, redact
EXTRACT = """
(() => {
  const msgs = [];
  document.querySelectorAll('H4.sr-only').forEach(h => {
    const t = h.textContent.trim();
    let role = 'unknown';
    if (t.includes('你说') || t.includes('你：')) role = 'user';
    else if (t.includes('ChatGPT')) role = 'assistant';
    const block = h.parentElement;
    if (block) {
      let body = block.innerText.replace(/^[\\s\\S]*?(?:你说：|ChatGPT 说：)\\s*/, '').trim();
      body = body.replace(/\\n\\d{1,2}:\\d{2}\\s*$/, '').trim();
      if (body && role !== 'unknown') msgs.push({role, text: body, sourceMessageId: block.getAttribute('data-message-id') || null});
    }
  });
  return JSON.stringify(msgs);
})()
"""

def read_messages(kind='webview'):
    connection=Cdp(find_target(kind))
    try: raw=connection.evaluate(EXTRACT)
    finally: connection.close()
    value=json.loads(raw or '[]')
    if not isinstance(value,list) or len(value)>1000: raise ToolError('INPUT','Message limit exceeded',2)
    return redact(value)
def main():
    parser=argparse.ArgumentParser(description='Read visible authorized conversation only; no Cookie/profile access')
    parser.add_argument('--last',action='store_true'); parser.add_argument('--json',action='store_true'); parser.add_argument('--kind',choices=['webview','page'],default='webview')
    args=parser.parse_args(); messages=read_messages(args.kind)
    if args.last: messages=messages[-1:]
    print(json.dumps({'source':'visible-dom','modelVerified':False,'messages':messages},ensure_ascii=False))
if __name__=='__main__': sys.exit(entry(main))
