import type { DatabaseSync } from 'node:sqlite';
import { CallerAuthority, type CallerContext } from './caller.ts';
import { now, transaction, uuid } from './db.ts';
import { BridgeError } from './errors.ts';
import { requireNoSecrets } from './security.ts';

export function enqueueNotification(db: DatabaseSync, principal: string, key: string, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (!serialized || serialized.length > 65536 || !principal || !key) throw new BridgeError('INPUT', 'Invalid notification');
  requireNoSecrets(serialized);
  const existing = db.prepare('SELECT id,principal,payload FROM notification_outbox WHERE dedupe_key=?').get(key);
  if (existing) {
    if (existing.principal !== principal || existing.payload !== serialized) throw new BridgeError('CONFLICT', 'Notification key was reused with different content');
    return String(existing.id);
  }
  const id = uuid();
  db.prepare("INSERT INTO notification_outbox(id,dedupe_key,principal,payload,state,created_at) VALUES(?,?,?,?,'PENDING',?)").run(id, key, principal, serialized, now());
  return id;
}

export class NotificationOutbox {
  private readonly db: DatabaseSync;
  private readonly authority: CallerAuthority;
  constructor(db: DatabaseSync, authority: CallerAuthority) { this.db = db; this.authority = authority; }
  status(context: CallerContext): { states: Record<string,number>; unresolvedDeliveries: { id: string; state: string; errorCode: string | null }[] } {
    const caller=this.authority.resolve(context);
    if(!caller?.controller)throw new BridgeError('AUTH','Trusted controller required');
    const rows=this.db.prepare('SELECT state,COUNT(*) count FROM notification_outbox WHERE principal=? GROUP BY state').all(caller.principal);
    const unresolved=this.db.prepare("SELECT d.notification_id,d.state,d.error_code FROM notification_delivery d JOIN notification_outbox n ON n.id=d.notification_id WHERE d.principal=? AND n.state!='ACKED' AND d.state!='SENT' ORDER BY d.updated_at,d.notification_id LIMIT 100").all(caller.principal);
    return {states:Object.fromEntries(rows.map(row=>[String(row.state),Number(row.count)])),unresolvedDeliveries:unresolved.map(row=>({id:String(row.notification_id),state:String(row.state),errorCode:row.error_code===null?null:String(row.error_code)}))};
  }
  pull(context: CallerContext, limit = 20, leaseMs = 30000): { id: string; payload: unknown; attempts: number }[] {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted controller required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300000) throw new BridgeError('INPUT', 'Invalid notification budget');
    return transaction(this.db, () => {
      const time = now();
      const rows = this.db.prepare("SELECT id,payload,attempts FROM notification_outbox WHERE principal=? AND (state='PENDING' OR (state='INFLIGHT' AND lease_until<=?)) AND NOT EXISTS(SELECT 1 FROM notification_delivery d WHERE d.notification_id=notification_outbox.id AND d.state!='SENT') ORDER BY created_at,id LIMIT ?").all(caller.principal, time, limit);
      const expiry = new Date(Date.now() + leaseMs).toISOString();
      for (const row of rows) this.db.prepare("UPDATE notification_outbox SET state='INFLIGHT',holder=?,instance=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(caller.principal, caller.instance, expiry, row.id);
      return rows.map(row => ({ id: String(row.id), payload: JSON.parse(String(row.payload)) as unknown, attempts: Number(row.attempts) + 1 }));
    });
  }
  acknowledge(id: string, receiptId: string, context: CallerContext): void {
    const caller = this.authority.resolve(context);
    if (!caller?.controller) throw new BridgeError('AUTH', 'Trusted controller required');
    if (typeof receiptId !== 'string' || !receiptId.trim() || receiptId.length > 4096) throw new BridgeError('INPUT', 'A real external message receipt is required');
    requireNoSecrets(receiptId);
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM notification_outbox WHERE id=? AND principal=?').get(id, caller.principal);
      if (!row) throw new BridgeError('NOT_FOUND', 'Notification not found');
      if (row.state === 'ACKED') {
        if (row.receipt_id !== receiptId) throw new BridgeError('CONFLICT', 'Notification already has another receipt');
        return;
      }
      if (row.state !== 'INFLIGHT' || row.holder !== caller.principal || row.instance !== caller.instance || String(row.lease_until) <= now()) throw new BridgeError('OWNER', 'Notification lease is not held by this instance');
      this.db.prepare("UPDATE notification_outbox SET state='ACKED',receipt_id=?,acknowledged_at=?,lease_until=NULL WHERE id=?").run(receiptId, now(), id);
    });
  }
}
