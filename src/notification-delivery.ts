import type { DatabaseSync } from 'node:sqlite';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { NotificationOutbox } from './outbox.ts';
import { now, transaction } from './db.ts';
import { promptHash } from './prompts.ts';
import { BridgeError, classifyError } from './errors.ts';
import { requireNoSecrets } from './security.ts';
import { withDeadline } from './deadline.ts';

export interface NotificationDestination { type: 'open_id' | 'chat_id'; id: string }
export interface NotificationSender {
  send(input: { destination: NotificationDestination; text: string; idempotencyKey: string }, signal: AbortSignal): Promise<{ messageId: string }>;
}
export class MessageDeliveryError extends BridgeError {
  readonly outcome: 'rejected' | 'unknown';
  constructor(outcome: 'rejected' | 'unknown', code: 'IO' | 'TIMEOUT' = 'IO') {
    super(code, outcome === 'rejected' ? 'Message was rejected before delivery' : 'Message delivery outcome requires reconciliation');
    this.outcome = outcome;
  }
}

// The trusted Hermes host installs recipient routing and a sender. Neither is
// accepted from a model tool argument. An unknown send is never replayed.
export class NotificationDispatcher {
  private readonly outbox: NotificationOutbox;
  private readonly db: DatabaseSync;
  private readonly authority: CallerAuthority;
  private readonly context: CallerContext;
  private readonly sender: NotificationSender;
  private readonly options: { timeoutMs: number; leaseMs: number;
    route: (payload: unknown) => NotificationDestination; render: (payload: unknown) => string };
  constructor(db: DatabaseSync, authority: CallerAuthority,
    context: CallerContext, sender: NotificationSender,
    options: { timeoutMs: number; leaseMs: number;
      route: (payload: unknown) => NotificationDestination; render: (payload: unknown) => string }) {
    this.db=db; this.authority=authority; this.context=context; this.sender=sender; this.options=options;
    this.outbox = new NotificationOutbox(db, authority);
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || !Number.isInteger(options.leaseMs) || options.leaseMs <= options.timeoutMs || options.leaseMs > 300000) throw new BridgeError('CONFIG', 'Notification lease must exceed its send budget');
  }
  async flush(limit = 20): Promise<{ acknowledged: number; blocked: number }> {
    const caller = this.authority.resolve(this.context);
    if (!caller?.controller || caller.executor !== 'hermes') throw new BridgeError('AUTH', 'Trusted Hermes controller required');
    let acknowledged = 0, blocked = 0;
    for (const item of this.outbox.pull(this.context, limit, this.options.leaseMs)) {
      let ownsSend = false;
      try {
        const destination = this.options.route(item.payload), text = this.options.render(item.payload);
        if (!destination || !['open_id', 'chat_id'].includes(destination.type) ||
          !(destination.type === 'open_id' ? /^ou_[a-z0-9]{8,64}$/i : /^oc_[a-z0-9]{8,64}$/i).test(destination.id) ||
          typeof text !== 'string' || !text.trim() || text.length > 4096) throw new BridgeError('INPUT', 'Invalid authorized notification route');
        requireNoSecrets(text);
        const destinationHash = promptHash(JSON.stringify(destination)), contentHash = promptHash(text);
        const previous = transaction(this.db, () => {
          const row = this.db.prepare('SELECT * FROM notification_delivery WHERE notification_id=?').get(item.id);
          if (row) {
            if (row.principal !== caller.principal || row.destination_hash !== destinationHash || row.content_hash !== contentHash) throw new BridgeError('CONFLICT', 'Notification route or content changed');
            return row;
          }
          this.db.prepare("INSERT INTO notification_delivery(notification_id,principal,destination_hash,content_hash,state,updated_at) VALUES(?,?,?,?,'SENDING',?)").run(item.id, caller.principal, destinationHash, contentHash, now());
          ownsSend = true;
          return null;
        });
        if (previous) {
          if (previous.state === 'SENT' && typeof previous.receipt_id === 'string') {
            this.outbox.acknowledge(item.id, previous.receipt_id, this.context); acknowledged++;
          } else blocked++;
          continue;
        }
        const receipt = await withDeadline(signal => this.sender.send({ destination, text, idempotencyKey: item.id }, signal), this.options.timeoutMs);
        if (!receipt || typeof receipt.messageId !== 'string' || !/^om_[a-z0-9]{8,128}$/i.test(receipt.messageId)) throw new MessageDeliveryError('unknown');
        transaction(this.db, () => {
          if (this.db.prepare("UPDATE notification_delivery SET state='SENT',receipt_id=?,updated_at=? WHERE notification_id=? AND state='SENDING'").run(receipt.messageId, now(), item.id).changes !== 1) throw new BridgeError('CONFLICT', 'Notification send ownership changed');
        });
        this.outbox.acknowledge(item.id, receipt.messageId, this.context); acknowledged++;
      } catch (error) {
        if (ownsSend) this.db.prepare("UPDATE notification_delivery SET state=?,error_code=?,updated_at=? WHERE notification_id=? AND state='SENDING'").run(error instanceof MessageDeliveryError && error.outcome === 'rejected' ? 'REJECTED' : 'UNCERTAIN', classifyError(error).code, now(), item.id);
        blocked++;
      }
    }
    return { acknowledged, blocked };
  }
}
