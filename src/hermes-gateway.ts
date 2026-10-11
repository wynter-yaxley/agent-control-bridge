import { BackgroundBridge } from './background.ts';
import { BridgeError } from './errors.ts';
import { requireNoSecrets } from './security.ts';

export interface FeishuMessageIdentity { senderOpenId: string; chatId: string; chatType: 'p2p' | 'group'; messageId: string }
export interface HermesEventPolicy {
  // Installed by the existing authenticated gateway. Return null for an
  // unauthorized sender/chat; never derive authority from message content.
  projectForMessage(identity: FeishuMessageIdentity): string | null;
}

function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INPUT','Invalid Feishu message envelope');
  return value as Record<string,unknown>;
}

// Call only from an existing Hermes gateway's verified Feishu event callback.
// This library has no public webhook or independent WebSocket consumer.
export class HermesGatewayAdapter {
  private readonly bridge: BackgroundBridge;
  private readonly policy: HermesEventPolicy;
  constructor(bridge: BackgroundBridge, policy: HermesEventPolicy) { this.bridge=bridge; this.policy=policy; }
  accept(event: unknown): ReturnType<BackgroundBridge['submit']> {
    const root=object(event), header=object(root.header), payload=object(root.event);
    if (root.schema!=='2.0' || header.event_type!=='im.message.receive_v1') throw new BridgeError('INPUT','Only Feishu v2 message events are supported');
    const sender=object(payload.sender), senderId=object(sender.sender_id), message=object(payload.message);
    if (sender.sender_type!=='user' || message.message_type!=='text' || !['p2p','group'].includes(String(message.chat_type)) ||
      typeof message.message_id!=='string' || !/^om_[a-z0-9]{8,128}$/i.test(message.message_id) ||
      typeof senderId.open_id!=='string' || !/^ou_[a-z0-9]{8,64}$/i.test(senderId.open_id) ||
      typeof message.chat_id!=='string' || !/^oc_[a-z0-9]{8,64}$/i.test(message.chat_id)) throw new BridgeError('INPUT','Unsupported Feishu sender or message');
    const identity: FeishuMessageIdentity={senderOpenId:senderId.open_id,chatId:message.chat_id,chatType:message.chat_type as 'p2p'|'group',messageId:message.message_id};
    const projectId=this.policy.projectForMessage(identity);
    if (typeof projectId!=='string' || !projectId.trim()) throw new BridgeError('AUTH','Feishu sender/chat has no authorized project');
    if (typeof message.content!=='string' || message.content.length>65536) throw new BridgeError('INPUT','Invalid Feishu text content');
    let content: Record<string,unknown>;
    try { content=object(JSON.parse(message.content)); } catch { throw new BridgeError('INPUT','Invalid Feishu text content'); }
    if (typeof content.text!=='string' || !content.text.trim() || content.text.length>65536) throw new BridgeError('INPUT','Empty or excessive Feishu text');
    requireNoSecrets(content.text);
    return this.bridge.submit({eventKey:`feishu:${message.message_id}`,projectId,title:content.text.split(/[\r\n]/,1)[0].slice(0,256) || 'Feishu requirement',requirement:content.text});
  }
}
