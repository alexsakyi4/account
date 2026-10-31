import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createTestApp, registerCompany, authed, createCustomer, accountId, today, type Session, type TestContext } from '../helpers.js';
import { runDueWork, nextDate } from '../../server/src/jobs/worker';

type Received = { headers: Record<string, string | string[] | undefined>; body: string };

describe('background jobs', () => {
  let ctx: TestContext;
  let session: Session;
  const received: Received[] = [];
  let receiver: Server;
  let receiverUrl = '';
  let failNext = false;

  beforeAll(async () => {
    ctx = await createTestApp();
    session = await registerCompany(ctx, 'Jobs Co');
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = failNext ? 500 : 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
    if (ctx) await ctx.close();
  });

  it('creates recurring invoices when the schedule falls due', async () => {
    const customer = await createCustomer(ctx, session, 'Retainer Client');
    const income = await accountId(ctx, session, '4000');
    const profile = await authed(ctx, session, 'POST', '/recurring-invoices', {
      name: 'Monthly retainer',
      contactId: customer,
      frequency: 'monthly',
      intervalCount: 1,
      nextDate: today(),
      autoSend: true,
      lines: [{ description: 'Retainer', quantity: 1, unitPrice: 250_000, accountId: income }],
    });
    expect(profile.statusCode).toBe(201);

    const stats = await runDueWork(ctx.db, new Date());
    expect(stats.recurring).toBe(1);
    expect(stats.errors).toBe(0);

    const invoices = await ctx.db.all<{ number: string; status: string; total: number }>(
      'SELECT number, status, total FROM invoices WHERE tenant_id = ? ORDER BY number',
      [session.tenantId],
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('sent');
    expect(invoices[0].total).toBe(250_000);

    const row = await ctx.db.get<{ next_date: string; last_invoice_id: string; last_run_at: string }>(
      'SELECT next_date, last_invoice_id, last_run_at FROM recurring_invoices WHERE id = ?',
      [profile.json().id],
    );
    expect(row?.next_date).toBe(nextDate(today(), 'monthly'));
    expect(row?.last_invoice_id).toBeTruthy();

    // Second pass on the same day must not duplicate the invoice.
    const again = await runDueWork(ctx.db, new Date());
    expect(again.recurring).toBe(0);
    expect(await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ?', [session.tenantId])).toEqual({ n: 1 });
  });

  it('signs and delivers webhook events, retrying on failure', async () => {
    const hook = await authed(ctx, session, 'POST', '/webhooks', { url: receiverUrl, events: ['invoice.created', 'invoice.reminder'] });
    expect(hook.statusCode).toBe(201);
    const secret = hook.json().secret as string;

    const customer = await createCustomer(ctx, session, 'Hooked Customer');
    const income = await accountId(ctx, session, '4000');
    const invoice = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customer,
      issueDate: today(),
      status: 'draft',
      lines: [{ description: 'Hooked work', quantity: 1, unitPrice: 40_000, accountId: income }],
    });
    expect(invoice.statusCode).toBe(201);

    failNext = true;
    const first = await runDueWork(ctx.db, new Date());
    expect(first.webhooks).toBe(0); // delivery attempted but the receiver returned 500
    const pending = await ctx.db.get<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_deliveries WHERE event = 'invoice.created' AND tenant_id = ? ORDER BY created_at DESC`,
      [session.tenantId],
    );
    expect(pending?.status).toBe('pending');
    expect(pending?.attempts).toBe(1);

    failNext = false;
    await ctx.db.run('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE event = ?', [new Date(Date.now() - 1000).toISOString(), 'invoice.created']);
    const second = await runDueWork(ctx.db, new Date());
    expect(second.webhooks).toBe(1);

    const delivered = await ctx.db.get<{ status: string; response_code: number }>(
      `SELECT status, response_code FROM webhook_deliveries WHERE event = 'invoice.created' AND tenant_id = ?`,
      [session.tenantId],
    );
    expect(delivered).toEqual({ status: 'delivered', response_code: 200 });

    const delivery = received.filter((r) => r.headers['x-ledgerline-event'] === 'invoice.created').at(-1);
    expect(delivery).toBeTruthy();
    const payload = JSON.parse(delivery!.body) as { event: string; data: { invoiceId: string } };
    expect(payload.event).toBe('invoice.created');
    expect(payload.data.invoiceId).toBe(invoice.json().id);
    expect(delivery!.headers['user-agent']).toBe('LedgerLine-Webhooks/1.0');

    const signature = String(delivery!.headers['x-ledgerline-signature']);
    const [t, v] = signature.split(',');
    const timestamp = t.replace('t=', '');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${delivery!.body}`).digest('hex');
    expect(v).toBe(`v1=${expected}`);
  });

  it('emails overdue reminders once per cooldown window', async () => {
    const customerId = await createCustomer(ctx, session, 'Late Payer');
    const income = await accountId(ctx, session, '4000');
    const invoice = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      dueDate: today(),
      autoPost: true,
      lines: [{ description: 'Overdue work', quantity: 1, unitPrice: 90_000, accountId: income }],
    });
    expect(invoice.statusCode).toBe(201);

    const tomorrow = new Date(Date.now() + 24 * 3600_000);
    const stats = await runDueWork(ctx.db, tomorrow);
    expect(stats.reminders).toBe(1);

    const reminder = await ctx.db.get<{ status: string }>('SELECT status FROM invoice_reminders WHERE invoice_id = ?', [invoice.json().id]);
    expect(reminder?.status).toBe('sent');
    const row = await ctx.db.get<{ reminder_count: number }>('SELECT reminder_count FROM invoices WHERE id = ?', [invoice.json().id]);
    expect(row?.reminder_count).toBe(1);

    // Cooldown: another run a minute later sends nothing.
    const again = await runDueWork(ctx.db, new Date(tomorrow.getTime() + 60_000));
    expect(again.reminders).toBe(0);
  });

  it('runs scheduled reports and emails the CSV payload', async () => {
    const schedule = await authed(ctx, session, 'POST', '/reports/schedules', {
      reportType: 'profit-and-loss',
      name: 'Weekly P&L',
      frequency: 'weekly',
      recipients: 'owner@example.com',
      format: 'csv',
    });
    expect(schedule.statusCode).toBeLessThan(300);
    // Schedules created through the API are due in the future; replay one that fell due.
    await ctx.db.run('UPDATE report_schedules SET next_run_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      schedule.json().id,
    ]);

    const stats = await runDueWork(ctx.db, new Date());
    expect(stats.schedules).toBe(1);

    const row = await ctx.db.get<{ last_run_at: string | null; next_run_at: string }>(
      'SELECT last_run_at, next_run_at FROM report_schedules WHERE id = ?',
      [schedule.json().id],
    );
    expect(row?.last_run_at).toBeTruthy();
    expect(row!.next_run_at > new Date().toISOString()).toBe(true);

    const email = await ctx.db.get<{ title: string; body: string }>(
      `SELECT title, body FROM notifications WHERE tenant_id = ? AND level = 'email' AND title LIKE '%Weekly P&L%'`,
      [session.tenantId],
    );
    expect(email?.body).toContain('owner@example.com');
  });
});
