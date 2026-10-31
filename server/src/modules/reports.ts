import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../lib/errors.js';
import { toCsv } from '../lib/csv.js';
import { fromMinor } from '../lib/money.js';
import { paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { emitEvent } from '../services/events.js';
import { renderReportPdf } from '../services/pdf.js';
import {
  aging,
  balanceSheet,
  cashFlow,
  dashboard,
  generalLedger,
  profitAndLoss,
  trialBalance,
  type ReportResult,
} from '../domain/reports.js';
import { newId } from '../db/driver.js';

const REPORT_TYPES = [
  'profit-and-loss',
  'balance-sheet',
  'cash-flow',
  'trial-balance',
  'ar-aging',
  'ap-aging',
  'general-ledger',
  'sales-by-customer',
  'purchases-by-vendor',
  'tax-summary',
] as const;

type ReportType = (typeof REPORT_TYPES)[number];

function defaultRange(): { from: string; to: string } {
  const to = new Date().toISOString().slice(0, 10);
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

async function buildReport(
  db: FastifyInstance['db'],
  tenantId: string,
  type: string,
  params: { from: string; to: string; contactId?: string | null; accountId?: string | null },
): Promise<ReportResult | Record<string, unknown>> {
  switch (type) {
    case 'profit-and-loss':
      return profitAndLoss(db, tenantId, params.from, params.to, { contactId: params.contactId });
    case 'balance-sheet':
      return balanceSheet(db, tenantId, params.to);
    case 'cash-flow':
      return cashFlow(db, tenantId, params.from, params.to);
    case 'trial-balance':
      return trialBalance(db, tenantId, params.from, params.to);
    case 'ar-aging':
    case 'ap-aging': {
      const data = await aging(db, tenantId, params.to, type === 'ar-aging' ? 'receivable' : 'payable');
      const currency = (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))?.base_currency ?? 'USD';
      return {
        report: type,
        title: type === 'ar-aging' ? 'Accounts Receivable Aging' : 'Accounts Payable Aging',
        from: null,
        to: params.to,
        currency,
        basis: 'accrual',
        generatedAt: new Date().toISOString(),
        sections: [
          {
            key: 'aging',
            label: 'By customer',
            lines: data.rows.map((r) => ({
              accountId: r.contactId,
              code: '',
              name: r.contactName,
              type: 'asset',
              subtype: null,
              amount: r.total,
            })),
            total: data.totals.total,
          },
        ],
        totals: { total: data.totals.total },
        meta: {
          buckets: {
            current: data.totals.current,
            days1to30: data.totals.days1to30,
            days31to60: data.totals.days31to60,
            days61to90: data.totals.days61to90,
            days90plus: data.totals.days90plus,
          },
          rows: data.rows,
        },
      };
    }
    case 'general-ledger': {
      if (!params.accountId) throw badRequest('Choose an account for the general ledger report');
      const ledger = await generalLedger(db, tenantId, params.accountId, params.from, params.to);
      const currency = (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))?.base_currency ?? 'USD';
      return {
        report: 'general-ledger',
        title: `General Ledger — ${ledger.account.code} ${ledger.account.name}`,
        from: params.from,
        to: params.to,
        currency,
        basis: 'accrual',
        generatedAt: new Date().toISOString(),
        sections: [
          {
            key: 'entries',
            label: 'Transactions',
            lines: ledger.lines.map((l) => ({
              accountId: String(l.entryNo),
              code: l.date,
              name: l.memo ?? '',
              type: 'ledger',
              subtype: null,
              amount: l.debit - l.credit,
            })),
            total: ledger.closing - ledger.opening,
          },
        ],
        totals: { opening: ledger.opening, closing: ledger.closing },
        meta: { account: ledger.account, lines: ledger.lines },
      };
    }
    case 'sales-by-customer': {
      const rows = await db.all<{ name: string; total: number; paid: number; balance: number; count: number }>(
        `SELECT c.name, COALESCE(SUM(i.total),0) AS total, COALESCE(SUM(i.amount_paid),0) AS paid,
                COALESCE(SUM(i.balance),0) AS balance, COUNT(*) AS count
         FROM invoices i JOIN contacts c ON c.id = i.contact_id
         WHERE i.tenant_id = ? AND i.kind = 'invoice' AND i.status <> 'void' AND i.issue_date BETWEEN ? AND ?
         GROUP BY c.id, c.name ORDER BY total DESC`,
        [tenantId, params.from, params.to],
      );
      const currency = (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))?.base_currency ?? 'USD';
      const total = rows.reduce((a, b) => a + Number(b.total), 0);
      return {
        report: 'sales-by-customer',
        title: 'Sales by Customer',
        from: params.from,
        to: params.to,
        currency,
        basis: 'accrual',
        generatedAt: new Date().toISOString(),
        sections: [
          { key: 'customers', label: 'Customers', lines: rows.map((r) => ({ accountId: r.name, code: '', name: r.name, type: 'income', subtype: null, amount: Number(r.total) })), total },
        ],
        totals: { total },
        meta: { rows },
      };
    }
    case 'purchases-by-vendor': {
      const rows = await db.all<{ name: string; total: number; paid: number; balance: number; count: number }>(
        `SELECT c.name, COALESCE(SUM(b.total),0) AS total, COALESCE(SUM(b.amount_paid),0) AS paid,
                COALESCE(SUM(b.balance),0) AS balance, COUNT(*) AS count
         FROM bills b JOIN contacts c ON c.id = b.vendor_id
         WHERE b.tenant_id = ? AND b.status <> 'void' AND b.issue_date BETWEEN ? AND ?
         GROUP BY c.id, c.name ORDER BY total DESC`,
        [tenantId, params.from, params.to],
      );
      const currency = (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))?.base_currency ?? 'USD';
      const total = rows.reduce((a, b) => a + Number(b.total), 0);
      return {
        report: 'purchases-by-vendor',
        title: 'Purchases by Vendor',
        from: params.from,
        to: params.to,
        currency,
        basis: 'accrual',
        generatedAt: new Date().toISOString(),
        sections: [
          { key: 'vendors', label: 'Vendors', lines: rows.map((r) => ({ accountId: r.name, code: '', name: r.name, type: 'expense', subtype: null, amount: Number(r.total) })), total },
        ],
        totals: { total },
        meta: { rows },
      };
    }
    case 'tax-summary': {
      const rows = await db.all<{ code: string; name: string; rate_bp: number; collected: number; paid: number; net: number }>(
        `SELECT t.code, t.name, t.rate_bp,
           COALESCE(SUM(CASE WHEN je.source_type IN ('invoice','credit_memo','payment') THEN jl.credit - jl.debit ELSE 0 END), 0) AS collected,
           COALESCE(SUM(CASE WHEN je.source_type IN ('bill','expense') THEN jl.debit - jl.credit ELSE 0 END), 0) AS paid,
           COALESCE(SUM(CASE WHEN je.source_type IN ('invoice','credit_memo','payment') THEN jl.credit - jl.debit ELSE jl.debit - jl.credit END), 0) AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted'
         JOIN tax_codes t ON t.id = jl.tax_code_id
         WHERE jl.tenant_id = ? AND je.date BETWEEN ? AND ?
         GROUP BY t.id, t.code, t.name, t.rate_bp ORDER BY t.code`,
        [tenantId, params.from, params.to],
      );
      const currency = (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))?.base_currency ?? 'USD';
      const total = rows.reduce((a, b) => a + Number(b.net), 0);
      return {
        report: 'tax-summary',
        title: 'Tax Summary',
        from: params.from,
        to: params.to,
        currency,
        basis: 'accrual',
        generatedAt: new Date().toISOString(),
        sections: [
          {
            key: 'tax',
            label: 'Tax codes',
            lines: rows.map((r) => ({ accountId: r.code, code: r.code, name: `${r.name} (${(r.rate_bp / 100).toFixed(2)}%)`, type: 'liability', subtype: null, amount: Number(r.net) })),
            total,
          },
        ],
        totals: { net: total },
        meta: { rows },
      };
    }
    default:
      throw notFound(`Unknown report: ${type}`);
  }
}

function reportToCsv(report: ReportResult & { meta?: Record<string, unknown> }): string {
  const rows: Array<Record<string, string>> = [];
  for (const section of report.sections ?? []) {
    rows.push({ Section: section.label, Account: '', Amount: '' });
    for (const line of section.lines) {
      rows.push({ Section: section.label, Account: `${line.code} ${line.name}`.trim(), Amount: fromMinor(line.amount).toFixed(2) });
    }
    rows.push({ Section: `${section.label} total`, Account: '', Amount: fromMinor(section.total).toFixed(2) });
  }
  for (const [key, value] of Object.entries(report.totals ?? {})) {
    rows.push({ Section: 'TOTAL', Account: key, Amount: fromMinor(Number(value)).toFixed(2) });
  }
  return toCsv(rows);
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports/dashboard', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    return dashboard(req.db, ctx.tenantId);
  });

  app.get('/reports/definitions', { preHandler: requireAuth() }, async () => ({
    reports: [
      { id: 'profit-and-loss', name: 'Profit & Loss', group: 'Financial statements', needsRange: true },
      { id: 'balance-sheet', name: 'Balance Sheet', group: 'Financial statements', needsRange: false },
      { id: 'cash-flow', name: 'Statement of Cash Flows', group: 'Financial statements', needsRange: true },
      { id: 'trial-balance', name: 'Trial Balance', group: 'Financial statements', needsRange: true },
      { id: 'ar-aging', name: 'A/R Aging', group: 'Receivables', needsRange: false },
      { id: 'ap-aging', name: 'A/P Aging', group: 'Payables', needsRange: false },
      { id: 'general-ledger', name: 'General Ledger', group: 'Detail', needsRange: true, needsAccount: true },
      { id: 'sales-by-customer', name: 'Sales by Customer', group: 'Sales', needsRange: true },
      { id: 'purchases-by-vendor', name: 'Purchases by Vendor', group: 'Purchases', needsRange: true },
      { id: 'tax-summary', name: 'Tax Summary', group: 'Tax', needsRange: true },
    ],
    types: REPORT_TYPES,
  }));

  app.get('/reports/:type', { preHandler: requireAuth('reports:read') }, async (req, reply) => {
    const ctx = req.ctx!;
    const { type } = parse(z.object({ type: z.string() }), req.params);
    if (!REPORT_TYPES.includes(type as ReportType)) throw notFound(`Unknown report: ${type}`);
    const query = parse(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        contactId: z.string().optional(),
        accountId: z.string().optional(),
        format: z.enum(['json', 'csv', 'pdf']).default('json'),
      }),
      req.query,
    );
    const range = defaultRange();
    const report = await buildReport(req.db, ctx.tenantId, type, {
      from: query.from ?? range.from,
      to: query.to ?? range.to,
      contactId: query.contactId,
      accountId: query.accountId,
    });

    if (query.format === 'csv') {
      return { filename: `${type}-${query.to ?? range.to}.csv`, content: reportToCsv(report as ReportResult) };
    }
    if (query.format === 'pdf') {
      const r = report as ReportResult;
      const tenant = await req.db.get<{ name: string }>('SELECT name FROM tenants WHERE id = ?', [ctx.tenantId]);
      const pdf = await renderReportPdf({
        title: r.title,
        subtitle: r.from ? `${r.from} to ${r.to}` : `As of ${r.to}`,
        company: tenant?.name ?? '',
        currency: r.currency,
        sections: r.sections.map((s) => ({
          label: s.label,
          total: s.total,
          lines: s.lines.map((l) => ({ label: `${l.code} ${l.name}`.trim(), amount: l.amount })),
        })),
        totals: Object.entries(r.totals).map(([label, amount]) => ({ label: label.replace(/([A-Z])/g, ' $1'), amount: Number(amount) })),
      });
      await emitEvent(req.db, ctx.tenantId, 'report.generated', { report: type, format: 'pdf' });
      return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${type}.pdf"`).send(pdf);
    }
    return report;
  });

  app.get('/reports/schedules/list', { preHandler: requireAuth('reports:read') }, async (req) => ({
    data: await req.db.all('SELECT * FROM report_schedules WHERE tenant_id = ? ORDER BY created_at DESC', [req.ctx!.tenantId]),
  }));

  app.post('/reports/schedules', { preHandler: requireAuth('reports:read') }, async (req, reply) => {
    const body = parse(
      z.object({
        reportType: z.enum(REPORT_TYPES),
        name: z.string().min(1).max(120),
        frequency: z.enum(['weekly', 'monthly', 'quarterly']).default('monthly'),
        recipients: z.string().min(3).max(500),
        format: z.enum(['csv', 'pdf']).default('csv'),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const id = newId();
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + (body.frequency === 'weekly' ? 7 : body.frequency === 'quarterly' ? 90 : 30));
    await req.db.run(
      `INSERT INTO report_schedules (id, tenant_id, report_type, name, frequency, params_json, recipients, format, next_run_at, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        ctx.tenantId,
        body.reportType,
        body.name,
        body.frequency,
        JSON.stringify({ from: body.from, to: body.to }),
        body.recipients,
        body.format,
        `${next.toISOString().slice(0, 10)}T06:00:00.000Z`,
        ctx.user.id,
        new Date().toISOString(),
      ],
    );
    return reply.code(201).send({ id });
  });

  app.delete('/reports/schedules/:id', { preHandler: requireAuth('reports:read') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await req.db.run('DELETE FROM report_schedules WHERE tenant_id = ? AND id = ?', [req.ctx!.tenantId, id]);
    return reply.code(204).send();
  });

  app.get('/reports/activity/recent', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(paginationSchema, req.query);
    const rows = await req.db.all(
      `SELECT id, action, entity_type, entity_id, summary, actor_email, created_at FROM audit_logs
       WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      [ctx.tenantId, query.pageSize],
    );
    return { data: rows };
  });

  app.get('/activity', { preHandler: requireAuth('audit:read') }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({ entityType: z.string().optional(), action: z.string().optional(), actorId: z.string().optional() }),
      req.query,
    );
    const where = ['tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.entityType) {
      where.push('entity_type = ?');
      params.push(query.entityType);
    }
    if (query.action) {
      where.push('action LIKE ?');
      params.push(`${query.action}%`);
    }
    if (query.actorId) {
      where.push('actor_id = ?');
      params.push(query.actorId);
    }
    if (query.q) {
      where.push('(LOWER(COALESCE(summary, \'\')) LIKE ? OR LOWER(COALESCE(actor_email, \'\')) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like);
    }
    const rows = await req.db.all(
      `SELECT id, seq, actor_id, actor_email, actor_role, action, entity_type, entity_id, summary, ip, created_at, before_json, after_json
       FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      [...params, query.pageSize],
    );
    return { data: rows };
  });

  app.post('/reports/:type/export', { preHandler: requireAuth('data:export') }, async (req) => {
    const ctx = req.ctx!;
    const { type } = parse(z.object({ type: z.string() }), req.params);
    const body = parse(z.object({ from: z.string().optional(), to: z.string().optional(), format: z.enum(['csv']).default('csv') }), req.body ?? {});
    const range = defaultRange();
    const report = await buildReport(req.db, ctx.tenantId, type, { from: body.from ?? range.from, to: body.to ?? range.to });
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'report.exported',
      entityType: 'report',
      entityId: type,
      summary: `Exported ${type} report`,
    });
    return { filename: `${type}-${body.to ?? range.to}.csv`, content: reportToCsv(report as ReportResult) };
  });
}
