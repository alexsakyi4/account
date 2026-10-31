/**
 * Background worker. Runs as part of the API process for single-container
 * deployments; set WORKER_MODE=standalone (or scale the worker Deployment) to
 * run it separately. All work is claim-based in the database, so any number of
 * stateless app servers and workers can run concurrently.
 */
import type { DB } from '../db/driver.js';
import { config } from '../config.js';
import { iso, daysAhead } from '../services/provisioning.js';
import { createInvoice, postInvoice } from '../services/documents.js';
import { emitEvent, deliverPending } from '../services/events.js';
import { sendEmail, invoiceEmail } from '../services/email.js';
import { toCsv } from '../lib/csv.js';
import { fromMinor } from '../lib/money.js';
import { profitAndLoss, balanceSheet, aging, trialBalance, cashFlow } from '../domain/reports.js';

export interface WorkerStats {
  webhooks: number;
  recurring: number;
  reminders: number;
  schedules: number;
  errors: number;
}

export async function runDueWork(db: DB, now = new Date()): Promise<WorkerStats> {
  const stats: WorkerStats = { webhooks: 0, recurring: 0, reminders: 0, schedules: 0, errors: 0 };
  try {
    stats.webhooks = await deliverPending(db);
  } catch (err) {
    stats.errors += 1;
    console.error('webhook delivery failed', err);
  }
  try {
    stats.recurring = await runRecurringInvoices(db, now);
  } catch (err) {
    stats.errors += 1;
    console.error('recurring invoice job failed', err);
  }
  try {
    stats.reminders = await sendReminders(db, now);
  } catch (err) {
    stats.errors += 1;
    console.error('reminder job failed', err);
  }
  try {
    stats.schedules = await runReportSchedules(db, now);
  } catch (err) {
    stats.errors += 1;
    console.error('report schedule job failed', err);
  }
  return stats;
}

export function nextDate(date: string, frequency: string, interval = 1): string {
  const d = new Date(`${date}T00:00:00Z`);
  const n = Math.max(1, interval);
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + n);
  else if (frequency === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else if (frequency === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d);
}

export async function runRecurringInvoices(db: DB, now = new Date()): Promise<number> {
  const today = iso(now);
  const due = await db.all<{
    id: string;
    tenant_id: string;
    name: string;
    contact_id: string;
    frequency: string;
    interval_count: number;
    next_date: string;
    end_date: string | null;
    template_json: string;
    auto_send: number;
  }>(
    `SELECT * FROM recurring_invoices WHERE status = 'active' AND next_date <= ? ORDER BY next_date LIMIT 50`,
    [today],
  );
  let created = 0;
  for (const profile of due) {
    const template = JSON.parse(profile.template_json) as {
      lines: Array<{ description: string; quantity: number; unitPrice: number; accountId: string; taxCodeId?: string | null }>;
      memo?: string;
      terms?: string;
    };
    const tenant = await db.get<{ settings_json: string | null }>('SELECT settings_json FROM tenants WHERE id = ?', [profile.tenant_id]);
    const userId = (await db.get<{ id: string }>('SELECT id FROM users WHERE id = (SELECT user_id FROM memberships WHERE tenant_id = ? ORDER BY created_at LIMIT 1)', [profile.tenant_id]))?.id ?? null;
    void tenant;
    const invoiceId = await createInvoice(db, profile.tenant_id, userId, {
      contactId: profile.contact_id,
      issueDate: iso(now),
      lines: template.lines,
      memo: template.memo ?? `Recurring: ${profile.name}`,
      terms: template.terms,
      status: 'draft',
    });
    if (profile.auto_send) await postInvoice(db, profile.tenant_id, invoiceId, userId);
    await db.run(
      `UPDATE recurring_invoices SET next_date = ?, last_invoice_id = ?, last_run_at = ? WHERE id = ?`,
      [nextDate(profile.next_date, profile.frequency, profile.interval_count), invoiceId, now.toISOString(), profile.id],
    );
    const end = profile.end_date;
    const newNext = nextDate(profile.next_date, profile.frequency, profile.interval_count);
    if (end && newNext > end) await db.run(`UPDATE recurring_invoices SET status = 'ended' WHERE id = ?`, [profile.id]);
    await emitEvent(db, profile.tenant_id, 'invoice.created', { invoiceId, recurringId: profile.id });
    created += 1;
  }
  return created;
}

export async function sendReminders(db: DB, now = new Date()): Promise<number> {
  const today = iso(now);
  const invoices = await db.all<{
    id: string;
    tenant_id: string;
    number: string;
    contact_id: string;
    contact_name: string;
    contact_email: string | null;
    due_date: string;
    balance: number;
    currency: string;
    reminder_count: number;
    last_reminder_at: string | null;
    payment_link_token: string | null;
    tenant_name: string;
    settings_json: string | null;
  }>(
    `SELECT i.id, i.tenant_id, i.number, i.contact_id, c.name AS contact_name, c.email AS contact_email,
            i.due_date, i.balance, i.currency, i.reminder_count, i.last_reminder_at, i.payment_link_token,
            t.name AS tenant_name, t.settings_json
     FROM invoices i
     JOIN contacts c ON c.id = i.contact_id
     JOIN tenants t ON t.id = i.tenant_id
     WHERE i.kind = 'invoice' AND i.status IN ('sent','partial','overdue') AND i.balance > 0
       AND i.due_date < ? AND i.reminder_count < 3
       AND (i.last_reminder_at IS NULL OR i.last_reminder_at < ?)
     LIMIT 50`,
    [today, new Date(Date.now() - 3 * 86_400_000).toISOString()],
  );
  let sent = 0;
  for (const invoice of invoices) {
    if (!invoice.contact_email) continue;
    const message = invoiceEmail({
      companyName: invoice.tenant_name,
      customerName: invoice.contact_name,
      number: invoice.number,
      total: new Intl.NumberFormat('en-US', { style: 'currency', currency: invoice.currency }).format(fromMinor(invoice.balance)),
      dueDate: invoice.due_date,
      link: `${config.appUrl}/pay/${invoice.payment_link_token ?? invoice.id}`,
      message: `This is a friendly reminder that invoice ${invoice.number} was due on ${invoice.due_date}.`,
    });
    await sendEmail(db, invoice.tenant_id, { ...message, to: invoice.contact_email });
    await db.run(
      `INSERT INTO invoice_reminders (id, tenant_id, invoice_id, reminder_type, status, sent_at, message)
       VALUES (?, ?, ?, 'overdue', 'sent', ?, ?)`,
      [crypto.randomUUID(), invoice.tenant_id, invoice.id, now.toISOString(), message.subject],
    );
    await db.run(`UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?`, [
      now.toISOString(),
      invoice.id,
    ]);
    await emitEvent(db, invoice.tenant_id, 'invoice.reminder', { invoiceId: invoice.id, number: invoice.number });
    sent += 1;
  }
  return sent;
}

export async function runReportSchedules(db: DB, now = new Date()): Promise<number> {
  const due = await db.all<{
    id: string;
    tenant_id: string;
    report_type: string;
    name: string;
    frequency: string;
    params_json: string | null;
    recipients: string | null;
    format: string;
    next_run_at: string;
  }>("SELECT * FROM report_schedules WHERE status = 'active' AND next_run_at <= ? LIMIT 20", [now.toISOString()]);
  let ran = 0;
  for (const schedule of due) {
    const params = schedule.params_json ? (JSON.parse(schedule.params_json) as { from?: string; to?: string }) : {};
    const to = params.to ?? iso(now);
    const from = params.from ?? iso(new Date(now.getTime() - 30 * 86_400_000));
    const report = await buildReport(db, schedule.tenant_id, schedule.report_type, from, to);
    const rows = report.sections.flatMap((s) => s.lines.map((l) => ({ Section: s.label, Account: `${l.code} ${l.name}`.trim(), Amount: fromMinor(l.amount).toFixed(2) })));
    const csv = toCsv(rows);
    const tenant = await db.get<{ name: string }>('SELECT name FROM tenants WHERE id = ?', [schedule.tenant_id]);
    for (const recipient of (schedule.recipients ?? '').split(',').map((r) => r.trim()).filter(Boolean)) {
      await sendEmail(db, schedule.tenant_id, {
        to: recipient,
        subject: `${tenant?.name ?? 'LedgerLine'} — ${schedule.name}`,
        text: `Scheduled ${schedule.report_type} report for ${from} to ${to}.`,
        attachmentName: `${schedule.report_type}-${to}.csv`,
        attachment: Buffer.from(csv),
      });
    }
    await db.run('UPDATE report_schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?', [
      now.toISOString(),
      nextScheduleRun(schedule.next_run_at, schedule.frequency),
      schedule.id,
    ]);
    await emitEvent(db, schedule.tenant_id, 'report.generated', { scheduleId: schedule.id, reportType: schedule.report_type });
    ran += 1;
  }
  return ran;
}

export function nextScheduleRun(from: string, frequency: string): string {
  const next = nextDate(from.slice(0, 10), frequency, 1);
  return `${next}T06:00:00.000Z`;
}

async function buildReport(db: DB, tenantId: string, type: string, from: string, to: string) {
  switch (type) {
    case 'balance-sheet':
      return balanceSheet(db, tenantId, to);
    case 'cash-flow':
      return cashFlow(db, tenantId, from, to);
    case 'trial-balance':
      return trialBalance(db, tenantId, from, to);
    case 'ar-aging': {
      const report = await aging(db, tenantId, to, 'receivable');
      return {
        ...(await profitAndLoss(db, tenantId, from, to)),
        report: report.report,
        title: 'A/R Aging',
        sections: [
          {
            key: 'aging',
            label: 'Receivables',
            lines: report.rows.map((r) => ({ accountId: r.contactId, code: '', name: r.contactName, type: 'asset', subtype: null, amount: r.total })),
            total: report.totals.total,
          },
        ],
      };
    }
    default:
      return profitAndLoss(db, tenantId, from, to);
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startWorker(db: DB, intervalMs = config.jobsIntervalMs): () => void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const stats = await runDueWork(db);
      if (stats.webhooks + stats.recurring + stats.reminders + stats.schedules > 0) {
        console.log('[worker]', JSON.stringify({ ...stats, at: new Date().toISOString() }));
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export function tomorrow(): string {
  return daysAhead(1);
}
