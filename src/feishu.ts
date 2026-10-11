import { BridgeError } from './errors.ts';
import { withDeadline } from './deadline.ts';
import { MessageDeliveryError, type NotificationSender } from './notification-delivery.ts';

export interface FeishuCredentials { app_id: string; app_secret: string }
export interface FeishuCheckOptions {
  apiOrigin: string; timeoutMs: number; fetchFn?: typeof fetch;
  messageTest?: { recipientOpenId: string; idempotencyKey: string; text: string };
}

// Existing Hermes gateways may install this sender; it does not create another
// event consumer, acquire login state, or persist supplied credentials.
export function createFeishuMessageSender(credentials: FeishuCredentials, options: FeishuCheckOptions): NotificationSender {
  if (!['https://open.feishu.cn','https://open.larksuite.com'].includes(options.apiOrigin)) throw new BridgeError('CONFIG','Only official Feishu/Lark HTTPS origins are supported');
  if (!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>60000) throw new BridgeError('CONFIG','Invalid Feishu request budget');
  if (!credentials || !/^cli_[a-z0-9]{8,64}$/i.test(credentials.app_id) || typeof credentials.app_secret!=='string' || credentials.app_secret.length<8 || credentials.app_secret.length>1024) throw new BridgeError('INPUT','Invalid application credential shape');
  return {
    async send(input, signal) {
      if (signal.aborted) throw new MessageDeliveryError('rejected');
      if (!['open_id','chat_id'].includes(input.destination.type) || !(input.destination.type === 'open_id' ? /^ou_[a-z0-9]{8,64}$/i : /^oc_[a-z0-9]{8,64}$/i).test(input.destination.id) || !/^[a-z0-9-]{8,50}$/i.test(input.idempotencyKey) || !input.text.trim() || input.text.length>4096) throw new MessageDeliveryError('rejected');
      let token: string;
      try {
        const auth=await jsonRequest(`${options.apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app_id:credentials.app_id,app_secret:credentials.app_secret})},options,signal);
        if (!auth.ok || auth.body.code!==0 || typeof auth.body.tenant_access_token!=='string' || !auth.body.tenant_access_token || auth.body.tenant_access_token.length>8192) throw new MessageDeliveryError('rejected');
        token=auth.body.tenant_access_token;
      } catch { throw new MessageDeliveryError('rejected'); }
      if (signal.aborted) throw new MessageDeliveryError('rejected');
      try {
        const response=await jsonRequest(`${options.apiOrigin}/open-apis/im/v1/messages?receive_id_type=${input.destination.type}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({receive_id:input.destination.id,msg_type:'text',content:JSON.stringify({text:input.text}),uuid:input.idempotencyKey})},options,signal);
        if (!response.ok || response.body.code!==0) throw new MessageDeliveryError('unknown');
        const data=response.body.data as Record<string,unknown> | undefined;
        if (!data || typeof data.message_id!=='string' || !/^om_[a-z0-9]{8,128}$/i.test(data.message_id)) throw new MessageDeliveryError('unknown');
        return {messageId:data.message_id};
      } catch { throw new MessageDeliveryError('unknown'); }
    },
  };
}
export interface FeishuStage {
  status: 'PASS' | 'FAIL' | 'NOT_TESTED';
  httpStatus?: number;
  apiCode?: number | null;
  errorCode?: 'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE';
}
export interface FeishuCheckResult {
  ok: boolean;
  authentication: FeishuStage & { validitySeconds?: number | null };
  bot: FeishuStage & { name?: string; hasOpenId?: boolean; activateStatus?: number | null };
  messaging: FeishuStage & { messageId?: string };
  incomingEvents: 'NOT_TESTED';
  realAgentInvoked: false;
}

const integer = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;
async function jsonRequest(url: string, init: RequestInit, options: FeishuCheckOptions, parentSignal?: AbortSignal): Promise<{ httpStatus: number; ok: boolean; body: Record<string, unknown> }> {
  return withDeadline(async signal => {
    const response = await (options.fetchFn ?? fetch)(url, { ...init, redirect: 'error', signal: parentSignal ? AbortSignal.any([signal,parentSignal]) : signal });
    const reader = response.body?.getReader();
    if (!reader) throw new BridgeError('IO', 'Invalid Feishu response');
    let size=0;const chunks: Uint8Array[]=[];
    try {
      for (;;) {
        const value=await reader.read();if(value.done)break;
        size+=value.value.byteLength;
        if(size>262144){await reader.cancel();throw new BridgeError('IO','Feishu response exceeds its bound');}
        chunks.push(value.value);
      }
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BridgeError('IO','Invalid Feishu response'); }
    if (!body || typeof body!=='object' || Array.isArray(body)) throw new BridgeError('IO','Invalid Feishu response');
    return {httpStatus:response.status,ok:response.ok,body:body as Record<string, unknown>};
  }, options.timeoutMs);
}

// Credentials and issued tokens are request-local only. Return allowlisted facts,
// never raw responses, headers, request bodies or authentication diagnostics.
export async function checkFeishuApp(credentials: FeishuCredentials, options: FeishuCheckOptions): Promise<FeishuCheckResult> {
  if (!['https://open.feishu.cn','https://open.larksuite.com'].includes(options.apiOrigin)) throw new BridgeError('CONFIG','Only official Feishu/Lark HTTPS origins are supported');
  if (!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>60000) throw new BridgeError('CONFIG','Invalid Feishu request budget');
  if (!credentials || !/^cli_[a-z0-9]{8,64}$/i.test(credentials.app_id) || typeof credentials.app_secret!=='string' || credentials.app_secret.length<8 || credentials.app_secret.length>1024) throw new BridgeError('INPUT','Invalid application credential shape');
  const message=options.messageTest;
  if(message && (!/^ou_[a-z0-9]{8,64}$/i.test(message.recipientOpenId)||!/^[a-z0-9-]{8,50}$/i.test(message.idempotencyKey)||!message.text.trim()||message.text.length>4096))throw new BridgeError('INPUT','Invalid explicit message test');
  const result: FeishuCheckResult={ok:false,authentication:{status:'NOT_TESTED'},bot:{status:'NOT_TESTED'},messaging:{status:'NOT_TESTED'},incomingEvents:'NOT_TESTED',realAgentInvoked:false};
  let stage: 'authentication' | 'bot' | 'messaging'='authentication';
  try {
    const authentication=await jsonRequest(`${options.apiOrigin}/open-apis/auth/v3/tenant_access_token/internal`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(credentials)},options);
    const token=authentication.body.tenant_access_token;
    const authenticated=authentication.ok && authentication.body.code===0 && typeof token==='string' && token.length>0 && token.length<=8192;
    result.authentication={status:authenticated?'PASS':'FAIL',httpStatus:authentication.httpStatus,apiCode:integer(authentication.body.code),validitySeconds:integer(authentication.body.expire)};
    if (!authenticated) return result;
    stage='bot';
    const response=await jsonRequest(`${options.apiOrigin}/open-apis/bot/v3/info`,{method:'GET',headers:{authorization:`Bearer ${token}`}},options);
    const raw=response.body.bot;
    const bot=raw && typeof raw==='object' && !Array.isArray(raw)?raw as Record<string, unknown>:{};
    const hasOpenId=typeof bot.open_id==='string' && bot.open_id.length>0 && bot.open_id.length<=1024;
    const verified=response.ok && response.body.code===0 && hasOpenId;
    const redactExact=(value:string)=>[credentials.app_secret,token as string].reduce((text,secret)=>text.split(secret).join('[REDACTED]'),value).replace(/[\x00-\x1f\x7f]/g,'').slice(0,128);
    result.bot={status:verified?'PASS':'FAIL',httpStatus:response.httpStatus,apiCode:integer(response.body.code),hasOpenId,activateStatus:integer(bot.activate_status),...(typeof bot.app_name==='string'?{name:redactExact(bot.app_name)}:{})};
    result.ok=verified;
    if(verified && message){
      stage='messaging';result.ok=false;
      const sent=await jsonRequest(`${options.apiOrigin}/open-apis/im/v1/messages?receive_id_type=open_id`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({receive_id:message.recipientOpenId,msg_type:'text',content:JSON.stringify({text:message.text}),uuid:message.idempotencyKey})},options);
      const raw=sent.body.data;const data=raw && typeof raw==='object' && !Array.isArray(raw)?raw as Record<string,unknown>:{};
      const messageId=typeof data.message_id==='string' && /^om_[a-z0-9]{8,128}$/i.test(data.message_id)?data.message_id:null;
      result.ok=sent.ok && sent.body.code===0 && messageId!==null;
      result.messaging={status:result.ok?'PASS':'FAIL',httpStatus:sent.httpStatus,apiCode:integer(sent.body.code),...(messageId?{messageId}: {})};
    }
    return result;
  } catch (error) {
    result[stage]={status:'FAIL',errorCode:error instanceof BridgeError?(error.code==='TIMEOUT'?'TIMEOUT':'INVALID_RESPONSE'):'NETWORK'};
    return result;
  }
}
