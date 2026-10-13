#!/usr/bin/env python3
"""Read visible authorized conversation only; no Cookie/profile access.

信任边界：只读 CDP 可见 DOM 的消息文本，不读取 Cookie/token/密码，也不把
可见 DOM 当作授权或模型真实性证明。选择器零命中时返回 unverified（fail-closed）。
"""
import argparse, hashlib, json, os, sys
from desktop_common import Cdp, find_target, entry, ToolError, redact

# 结构化提取：H4.sr-only 是角色标记，正文 = 消息块克隆后移除角色标题的剩余内容。
# 不再用正则剥离前缀/时间戳（避免吞正文、误删合法内容）。
EXTRACT = r"""
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
    const message = block.matches('[data-message-id]') ? block : block.querySelector('[data-message-id]');
    if (body) msgs.push({role, text: body, sourceMessageId: message ? message.getAttribute('data-message-id') : null, complete:role==='assistant' && !!message && message.getAttribute('data-is-streaming')==='false'});
  });
  const match=location.pathname.match(/\/c\/([A-Za-z0-9-]+)/);
  const stops=[...document.querySelectorAll('[data-testid="stop-button"]')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);
  return JSON.stringify({messages: msgs, conversationId:match?match[1]:null, browserTitle:document.title,
    responseInProgress:stops.length>0, diagnostics: {nodesScanned: all.length, messagesFound: msgs.length}});
})()
"""

def read_messages(kind='webview', conversation_id=None):
    connection=Cdp(find_target(kind))
    try: raw=connection.evaluate(EXTRACT)
    finally: connection.close()
    value=json.loads(raw or '{}')
    if not isinstance(value,dict): raise ToolError('INPUT','Message extraction returned an unexpected shape',2)
    messages=value.get('messages',[])
    diagnostics=value.get('diagnostics',{})
    if not isinstance(messages,list) or len(messages)>1000: raise ToolError('INPUT','Message limit exceeded',2)
    result={'messages':redact(messages),'diagnostics':diagnostics}
    if conversation_id is not None:
        if value.get('conversationId')!=conversation_id: raise ToolError('PROVENANCE','Visible conversation differs from the registered GPT',3)
        for message in result['messages']:
            message['hash']=hashlib.sha256(message['text'].encode('utf-8')).hexdigest()
        result.update({'conversationId':conversation_id,'browserTitle':redact(value.get('browserTitle')),
                       'responseInProgress':value.get('responseInProgress'),'kind':'unknown',
                       'actualModel':None,'actualReasoningEffort':None,'completionVerified':value.get('responseInProgress') is False and any(m.get('role')=='assistant' and m.get('complete') is True for m in messages)})
    return result

def main():
    parser=argparse.ArgumentParser(description='Read visible authorized conversation only; no Cookie/profile access')
    parser.add_argument('--last',action='store_true'); parser.add_argument('--json',action='store_true'); parser.add_argument('--kind',choices=['webview','page'],default='webview')
    parser.add_argument('--conversation'); parser.add_argument('--config'); parser.add_argument('--endpoint')
    args=parser.parse_args()
    if args.config: os.environ['ACB_CONFIG']=args.config
    if args.endpoint: os.environ['ACB_CDP_URL']=args.endpoint
    result=read_messages(args.kind,args.conversation)
    messages=result['messages']; diagnostics=result['diagnostics']
    # P1-02: 区分合法空会话与选择器失效。选择器零命中即 unverified，不得报成功。
    if diagnostics.get('nodesScanned',0)==0:
        payload={'source':'visible-dom','modelVerified':False,'status':'unverified','reason':'selector_not_matched','messages':[],'diagnostics':diagnostics}
        print(json.dumps(payload,ensure_ascii=False)); return 4
    if args.last: messages=messages[-1:]
    status='empty' if not messages else 'ok'
    print(json.dumps({**result,'source':'visible-dom','modelVerified':False,'status':status,'diagnostics':diagnostics,'messages':messages},ensure_ascii=False))
    return 0

if __name__=='__main__': sys.exit(entry(main))
