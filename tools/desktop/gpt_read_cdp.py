#!/usr/bin/env python3
"""Read visible authorized conversation only; no Cookie/profile access.

信任边界：只读 CDP 可见 DOM 的消息文本，不读取 Cookie/token/密码，也不把
可见 DOM 当作授权或模型真实性证明。选择器零命中时返回 unverified（fail-closed）。
"""
import argparse, json, sys
from desktop_common import Cdp, find_target, entry, ToolError, redact

# 结构化提取：H4.sr-only 是角色标记，正文 = 消息块克隆后移除角色标题的剩余内容。
# 不再用正则剥离前缀/时间戳（避免吞正文、误删合法内容）。
EXTRACT = """
(() => {
  const all = document.querySelectorAll('H4.sr-only');
  const msgs = [];
  all.forEach(h => {
    const t = h.textContent.trim();
    let role = 'unknown';
    if (t.includes('你说') || t.includes('你：')) role = 'user';
    else if (t.includes('ChatGPT')) role = 'assistant';
    if (role === 'unknown') return;
    const block = h.parentElement;
    if (!block) return;
    // 文档内 innerText：渲染文本（不含 display:none 隐藏元素、保留换行折叠）。
    // cloneNode 得到的游离节点 innerText 会退化为 textContent，混入隐藏元素。
    const fullText = block.innerText;
    const roleText = (h.innerText || h.textContent).trim();
    // H4 是块内第一个子元素（角色标题），精确移除其文本，不吞正文。
    let body = fullText;
    const start = fullText.indexOf(roleText);
    if (start === 0) body = fullText.slice(roleText.length);
    else if (start > 0 && start < 64) body = fullText.slice(start + roleText.length);
    body = body.trim();
    if (body) msgs.push({role, text: body, sourceMessageId: block.getAttribute('data-message-id') || null});
  });
  return JSON.stringify({messages: msgs, diagnostics: {nodesScanned: all.length, messagesFound: msgs.length}});
})()
"""

def read_messages(kind='webview'):
    connection=Cdp(find_target(kind))
    try: raw=connection.evaluate(EXTRACT)
    finally: connection.close()
    value=json.loads(raw or '{}')
    if not isinstance(value,dict): raise ToolError('INPUT','Message extraction returned an unexpected shape',2)
    messages=value.get('messages',[])
    diagnostics=value.get('diagnostics',{})
    if not isinstance(messages,list) or len(messages)>1000: raise ToolError('INPUT','Message limit exceeded',2)
    return {'messages':redact(messages),'diagnostics':diagnostics}

def main():
    parser=argparse.ArgumentParser(description='Read visible authorized conversation only; no Cookie/profile access')
    parser.add_argument('--last',action='store_true'); parser.add_argument('--json',action='store_true'); parser.add_argument('--kind',choices=['webview','page'],default='webview')
    args=parser.parse_args()
    result=read_messages(args.kind)
    messages=result['messages']; diagnostics=result['diagnostics']
    # P1-02: 区分合法空会话与选择器失效。选择器零命中即 unverified，不得报成功。
    if diagnostics.get('nodesScanned',0)==0:
        payload={'source':'visible-dom','modelVerified':False,'status':'unverified','reason':'selector_not_matched','messages':[],'diagnostics':diagnostics}
        print(json.dumps(payload,ensure_ascii=False)); return 4
    if args.last: messages=messages[-1:]
    status='empty' if not messages else 'ok'
    print(json.dumps({'source':'visible-dom','modelVerified':False,'status':status,'diagnostics':diagnostics,'messages':messages},ensure_ascii=False))
    return 0

if __name__=='__main__': sys.exit(entry(main))
