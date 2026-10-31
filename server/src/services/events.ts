/**
 * Domain events → outbound webhooks.
 *
 * Deliveries are persisted first (transactional outbox), then attempted by the
 * background worker with exponential backoff, so a slow or failing subscriber
 * never blocks a request or loses an event.
 */
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { webhookSignature } from '../lib/crypto.js';
import { config } from '../config.js';

export type DomainEvent =
  | 'invoice.created'
  | 'invoice.sent'
  | 'invoice.paid'
  | 'invoice.voided'
  | 'invoice.reminder'
  | 'payment.received'
  | 'bill.created'
  | 'bill.paid'
  | 'expense.submitted'
  | 'expense.approved'
  | 'reconciliation.completed'
  | 'period.closed'
  | 'contact.created'
  | 'journal.posted'
  | 'import.completed'
  | 'report.generated';

export async function emitEvent(
  db: DB,
  tenantId: string,
  event: DomainEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const hooks = await db.all<{ id: string; url: string; secret: string; events: string }>(
    'SELECT id, url, secret, events FROM webhooks WHERE tenant_id = ? AND is_active = 1',
    [tenantId],
  );
  const now = new Date().toISOString();
  for (const hook of hooks) {
    const events = hook.events.split(',').map((e) => e.trim());
    if (!events.includes('*') && !events.includes(event)) continue;
    await db.run(
      `INSERT INTO webhook_deliveries (id, tenant_id, webhook_id, event, payload_json, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      [newId(), tenantId, hook.id, event, JSON.stringify({ event, tenantId, occurredAt: now, data: payload }), now, now],
    );
  }
}

export async function deliverPending(db: DB, limit = 25): Promise<number> {
  const now = new Date().toISOString();
  const deliveries = await db.all<{
    id: string;
    webhook_id: string;
    event: string;
    payload_json: string;
    attempts: number;
  }>(
    `SELECT d.id, d.webhook_id, d.event, d.payload_json, d.attempts
     FROM webhook_deliveries d
     WHERE d.status = 'pending' AND d.next_attempt_at <= ?
     ORDER BY d.next_attempt_at LIMIT ?`,
    [now, limit],
  );
  let delivered = 0;
  for (const delivery of deliveries) {
    const hook = await db.get<{ url: string; secret: string; is_active: number }>('SELECT * FROM webhooks WHERE id = ?', [
      delivery.webhook_id,
    ]);
    if (!hook || !hook.is_active) {
      await db.run(`UPDATE webhook_deliveries SET status = 'failed' WHERE id = ?`, [delivery.id]);
      continue;
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'LedgerLine-Webhooks/1.0',
          'x-ledgerline-event': delivery.event,
          'x-ledgerline-signature': `t=${timestamp},v1=${webhookSignature(hook.secret, timestamp, delivery.payload_json)}`,
        },
        body: delivery.payload_json,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        delivered += 1;
        await db.run(
          `UPDATE webhook_deliveries SET status = 'delivered', response_code = ?, attempts = attempts + 1, delivered_at = ? WHERE id = ?`,
          [res.status, new Date().toISOString(), delivery.id],
        );
      } else {
        await retry(db, delivery.id, delivery.attempts + 1, res.status);
      }
    } catch {
      await retry(db, delivery.id, delivery.attempts + 1, null);
    }
  }
  return delivered;
}

async function retry(db: DB, id: string, attempts: number, code: number | null): Promise<void> {
  const backoffMs = Math.min(60 * 60_000, 2 ** attempts * 15_000);
  const status = attempts >= 6 ? 'failed' : 'pending';
  await db.run(
    `UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ?, next_attempt_at = ? WHERE id = ?`,
    [status, attempts, code, new Date(Date.now() + backoffMs).toISOString(), id],
  );
}

export function webhookPayloadEventHeader(): string {
  return 'x-ledgerline-event';
}

export const WEBHOOK_EVENTS: DomainEvent[] = [
  'invoice.created',
  'invoice.sent',
  'invoice.paid',
  'invoice.voided',
  'invoice.reminder',
  'payment.received',
  'bill.created',
  'bill.paid',
  'expense.submitted',
  'expense.approved',
  'reconciliation.completed',
  'period.closed',
  'contact.created',
  'journal.posted',
  'import.completed',
  'report.generated',
];

export function publicApiBase(): string {
  return `${config.apiUrl.replace(/\/$/, '')}/api/v1`;
}
