import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { NotificationOutbox, enqueueNotification } from '../src/outbox.ts';

test('outbox: external receipt required; expired delivery can be replayed after restart', t => {
  const f = fixture(); t.after(() => f.db.close());
  const caller = f.reviewer, principal = f.authority.resolve(caller)!.principal;
  const outbox = new NotificationOutbox(f.db, f.authority), id = enqueueNotification(f.db, principal, 'fixture-notice', { state: 'BLOCKED' });
  assert.equal(enqueueNotification(f.db, principal, 'fixture-notice', { state: 'BLOCKED' }), id);
  const first = outbox.pull(caller); assert.equal(first.length, 1); assert.equal(first[0].attempts, 1);
  assert.equal(outbox.pull(caller).length, 0); assert.throws(() => outbox.acknowledge(id, '', caller), /receipt/);
  f.db.prepare("UPDATE notification_outbox SET lease_until='2000-01-01' WHERE id=?").run(id);
  const restarted = f.authority.issue({ principal, instance: 'restarted', executor: 'hermes', reviewer: false, controller: true });
  assert.equal(new NotificationOutbox(f.db, f.authority).pull(restarted)[0].attempts, 2);
  assert.throws(() => outbox.acknowledge(id, 'fixture-feishu-message', caller), /instance/);
  outbox.acknowledge(id, 'fixture-feishu-message', restarted); outbox.acknowledge(id, 'fixture-feishu-message', restarted);
  assert.equal(outbox.pull(restarted).length, 0); assert.equal(f.db.prepare('SELECT state FROM notification_outbox WHERE id=?').get(id)!.state, 'ACKED');
});
