import type { DatabaseSync } from 'node:sqlite';
import { transaction, now } from './db.ts';
import { taskChanges } from './task-events.ts';
import { BridgeError } from './errors.ts';
import { withDeadline } from './deadline.ts';
export interface Notification { taskId: string; version: number; status: string; observedAt: string }
export class Watcher {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = true;
  private pending = false;
  private controller?: AbortController;
  private db: DatabaseSync;
  private notify?: (notification: Notification, signal: AbortSignal) => unknown;
  private notifying = false;
  readonly intervalMs: number;
  readonly blockedAfterMs: number;
  private listener = () => { void this.runOnce().then(() => this.flushNotifications()).catch(error => this.onError(error instanceof BridgeError ? error.code : 'DB')); };
  constructor(db: DatabaseSync, options: { intervalMs?: number; timeoutMs?: number; blockedAfterMs?: number; inspect?: (signal: AbortSignal) => Promise<void>; onError?: (code: string) => void; onNotification?: (notification: Notification, signal: AbortSignal) => unknown } = {}) {
    this.db = db; this.errorHandler = options.onError; this.notify = options.onNotification;
    this.intervalMs = options.intervalMs ?? 60000; this.options = options;
    this.blockedAfterMs=options.blockedAfterMs??600000;
    if(!Number.isInteger(this.blockedAfterMs)||this.blockedAfterMs<1||this.blockedAfterMs>86400000)throw new BridgeError('CONFIG','Invalid blocked reporting threshold');
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 1 || this.intervalMs > 3600000) throw new BridgeError('CONFIG', 'Invalid watcher interval');
    if (!Number.isInteger(options.timeoutMs ?? 10000) || (options.timeoutMs ?? 10000) < 1) throw new BridgeError('CONFIG', 'Invalid watcher timeout');
  }
  private options: { timeoutMs?: number; inspect?: (signal: AbortSignal) => Promise<void> };
  private onError(code: string) { /* fixed code only; no untrusted payload */ this.errorHandler?.(code); }
  private errorHandler?: (code: string) => void;
  start(): void {
    if (!this.stopped) return; this.stopped = false; taskChanges.on('changed', this.listener);
    this.timer = setInterval(this.listener, this.intervalMs); this.listener();
  }
  stop(): void { this.stopped = true; this.pending = false; this.controller?.abort(); if (this.timer) clearInterval(this.timer); taskChanges.off('changed', this.listener); }
  async flushNotifications(): Promise<void> {
    if (!this.notify || this.notifying) return;
    this.notifying = true;
    try {
      const rows = this.db.prepare('SELECT * FROM watcher_notifications WHERE delivered_at IS NULL ORDER BY observed_at,task_id LIMIT 100').all();
      for (const row of rows) {
        await withDeadline(async signal => this.notify!({ taskId: String(row.task_id), version: Number(row.version), status: String(row.status), observedAt: String(row.observed_at) }, signal), this.options.timeoutMs ?? 10000);
        this.db.prepare('UPDATE watcher_notifications SET delivered_at=? WHERE task_id=? AND completion_id=? AND status=? AND delivered_at IS NULL').run(now(), row.task_id, row.completion_id, row.status);
      }
    } finally { this.notifying = false; }
  }
  async runOnce(): Promise<Notification[]> {
    if (this.busy) { this.pending = true; return []; } this.busy = true;
    const controller = new AbortController(); this.controller = controller;
    const deadline = setTimeout(() => { controller.abort(); this.onError('TIMEOUT'); }, this.options.timeoutMs ?? 10000);
    try {
      const signal = controller.signal;
      if (this.options.inspect) await Promise.race([
        this.options.inspect(signal),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new BridgeError('TIMEOUT', 'Watcher inspection exceeded its budget')), { once: true })),
      ]);
      if (signal.aborted) throw new BridgeError('TIMEOUT', 'Watcher inspection exceeded its budget');
      const rows = this.db.prepare("SELECT id,version,status,COALESCE((SELECT MAX(events.id) FROM events WHERE task_id=tasks.id AND type IN ('executor_finished','verified_pass','verified_fail','cancelled')),0) AS completion_id FROM tasks WHERE status IN ('WAITING_APPROVAL','SUCCEEDED','FAILED','CANCELLED') ORDER BY updated_at,id").all();
      rows.push(...this.db.prepare("SELECT tasks.id,tasks.version,tasks.status,COALESCE(block_event.id,0) AS completion_id FROM tasks LEFT JOIN events block_event ON block_event.id=(SELECT MAX(events.id) FROM events WHERE task_id=tasks.id AND type='status:RUNNING->BLOCKED') WHERE tasks.status='BLOCKED' AND COALESCE(block_event.observed_at,tasks.updated_at)<=? ORDER BY tasks.updated_at,tasks.id").all(new Date(Date.now()-this.blockedAfterMs).toISOString()));
      return transaction(this.db, () => {
        const notifications: Notification[] = [];
        for (const row of rows) {
          const time = now();
          const result = this.db.prepare('INSERT OR IGNORE INTO watcher_notifications(task_id,version,status,observed_at,completion_id) VALUES(?,?,?,?,?)').run(row.id, row.version, row.status, time, row.completion_id);
          if (result.changes === 1) notifications.push({ taskId: String(row.id), version: Number(row.version), status: String(row.status), observedAt: time });
        } return notifications;
      });
    } finally {
      clearTimeout(deadline); this.controller = undefined;
      this.busy = false;
      if (this.pending && !this.stopped) { this.pending = false; queueMicrotask(this.listener); }
    }
  }
}
