import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { emitEvent } from '../services/events.js';
import { recordAudit } from '../services/audit.js';
import { sendEmail, invoiceEmail } from '../services/email.js';
import { renderDocumentPdf } from '../services/pdf.js';
import {
  convertEstimate,
  createInvoice,
  postInvoice,
  updateInvoice,
  voidInvoice,
} from '../services/documents.js';
import { config } from '../config.js';
import { fromMinor } from '../lib/money.js';

const lineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().min(0).max(1_000_000).default(1),
  unitPrice: z.coerce.number().int().min(0),
  accountId: z.string().uuid().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid().nullable().optional(),
  discountBp: z.coerce.number().int().min(0).max(10_000).optional(),
});

const invoiceSchema = z.object({
  contactId: z.string().uuid(),
  kind: z.enum(['invoice', 'credit_memo', 'estimate']).default('invoice'),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  currency: z.string().length(3).optional(),
  fxRate: z.coerce.number().positive().optional(),
  lines: z.array(lineSchema).min(1),
  memo: z.string().max(2000).optional(),
  terms: z.string().max(2000).optional(),
  poNumber: z.string().max(60).optional(),
  status: z.enum(['draft', 'sent']).default('draft'),
  autoPost: z.boolean().optional(),
  templateId: z.string().uuid().nullable().optional(),
});

async function loadInvoice(db: FastifyInstance['db'], tenantId: string, id: string) {
  const invoice = await db.get<Record<string, unknown>>(
    `SELECT i.*, c.name AS contact_name, c.email AS contact_email, c.billing_address_json, c.payment_terms_days
     FROM invoices i JOIN contacts c ON c.id = i.contact_id
     WHERE i.tenant_id = ? AND i.id = ?`,
    [tenantId, id],
  );
  if (!invoice) throw notFound('Invoice not found');
  const lines = await db.all('SELECT * FROM invoice_lines WHERE tenant_id = ? AND invoice_id = ? ORDER BY line_no', [tenantId, id]);
  const payments = await db.all(
    `SELECT p.id, p.number, p.date, p.amount, p.method, pa.amount AS applied
     FROM payment_applications pa JOIN payments p ON p.id = pa.payment_id
     WHERE pa.tenant_id = ? AND pa.invoice_id = ? ORDER BY p.date`,
    [tenantId, id],
  );
  return { invoice, lines, payments };
}

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/invoices', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({
        kind: z.enum(['invoice', 'credit_memo', 'estimate', 'all']).default('invoice'),
        status: z.string().optional(),
        contactId: z.string().optional(),
        overdue: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    const where = ['i.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.kind !== 'all') {
      where.push('i.kind = ?');
      params.push(query.kind);
    }
    if (query.status && query.status !== 'all') {
      const statuses = query.status.split(',');
      where.push(`i.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (query.contactId) {
      where.push('i.contact_id = ?');
      params.push(query.contactId);
    }
    if (query.overdue) where.push("i.balance > 0 AND i.due_date < CURRENT_DATE::TEXT AND i.status IN ('sent','partial','overdue')");
    if (query.from) {
      where.push('i.issue_date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('i.issue_date <= ?');
      params.push(query.to);
    }
    if (query.q) {
      where.push('(LOWER(i.number) LIKE ? OR LOWER(c.name) LIKE ? OR LOWER(COALESCE(i.po_number, \'\')) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invoices i JOIN contacts c ON c.id = i.contact_id WHERE ${where.join(' AND ')}`,
      params,
    );
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT i.*, c.name AS contact_name
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
       WHERE ${where.join(' AND ')}
       ORDER BY i.issue_date DESC, i.number DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const summary = await req.db.get<{ outstanding: number; overdue: number; draft: number }>(
      `SELECT
        COALESCE(SUM(CASE WHEN i.balance > 0 AND i.status IN ('sent','partial','overdue') THEN i.balance ELSE 0 END), 0) AS outstanding,
        COALESCE(SUM(CASE WHEN i.balance > 0 AND i.due_date < ? AND i.status IN ('sent','partial','overdue') THEN i.balance ELSE 0 END), 0) AS overdue,
        COALESCE(SUM(CASE WHEN i.status = 'draft' THEN i.total ELSE 0 END), 0) AS draft
       FROM invoices i WHERE i.tenant_id = ? AND i.kind = 'invoice'`,
      [new Date().toISOString().slice(0, 10), ctx.tenantId],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize, {
      summary: {
        outstanding: Number(summary?.outstanding ?? 0),
        overdue: Number(summary?.overdue ?? 0),
        draft: Number(summary?.draft ?? 0),
      },
    });
  });

  app.get('/invoices/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const { invoice, lines, payments } = await loadInvoice(req.db, req.ctx!.tenantId, id);
    const journal = invoice.journal_entry_id
      ? await req.db.all(
          `SELECT jl.debit, jl.credit, jl.description, a.code, a.name
           FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
           WHERE jl.entry_id = ? ORDER BY jl.line_no`,
          [invoice.journal_entry_id],
        )
      : [];
    const reminders = await req.db.all('SELECT * FROM invoice_reminders WHERE invoice_id = ? ORDER BY sent_at DESC', [id]);
    return {
      invoice,
      lines,
      payments,
      journal,
      reminders,
      billingAddress: invoice.billing_address_json ? JSON.parse(String(invoice.billing_address_json)) : null,
      paymentLink: invoice.payment_link_token ? `${config.appUrl}/pay/${invoice.payment_link_token}` : null,
    };
  });

  app.post('/invoices', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const body = parse(invoiceSchema, req.body);
    const ctx = req.ctx!;
    const id = await createInvoice(req.db, ctx.tenantId, ctx.user.id, body);
    const invoice = await req.db.get<{ number: string; total: number; kind: string }>('SELECT * FROM invoices WHERE id = ?', [id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: `${body.kind}.created`,
      entityType: 'invoice',
      entityId: id,
      summary: `Created ${body.kind} ${invoice?.number}`,
      after: { total: invoice?.total, contactId: body.contactId, lines: body.lines.length },
    });
    await emitEvent(req.db, ctx.tenantId, 'invoice.created', {
      invoiceId: id,
      number: invoice?.number,
      total: invoice?.total,
      kind: body.kind,
      status: body.status,
    });
    return reply.code(201).send({ id, number: invoice?.number });
  });

  app.patch('/invoices/:id', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(invoiceSchema.partial(), req.body);
    const ctx = req.ctx!;
    await updateInvoice(req.db, ctx.tenantId, id, body, ctx.user.id);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'invoice.updated',
      entityType: 'invoice',
      entityId: id,
      summary: 'Invoice updated',
      after: body,
    });
    return { ok: true };
  });

  app.post('/invoices/:id/post', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    await postInvoice(req.db, ctx.tenantId, id, ctx.user.id);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'invoice.posted',
      entityType: 'invoice',
      entityId: id,
      summary: 'Invoice posted to the ledger',
    });
    return { ok: true };
  });

  app.post('/invoices/:id/send', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({ to: z.string().email().optional(), message: z.string().max(2000).optional() }).default({}),
      req.body ?? {},
    );
    const ctx = req.ctx!;
    const { invoice } = await loadInvoice(req.db, ctx.tenantId, id);
    if (invoice.status === 'void') throw conflict('This document is void');
    if (!invoice.journal_entry_id) await postInvoice(req.db, ctx.tenantId, id, ctx.user.id);
    const token = invoice.payment_link_token ?? crypto.randomUUID().replace(/-/g, '');
    await req.db.run(`UPDATE invoices SET payment_link_token = ?, last_reminder_at = ? WHERE id = ?`, [token, new Date().toISOString(), id]);
    const tenant = await req.db.get<{ name: string }>('SELECT name FROM tenants WHERE id = ?', [ctx.tenantId]);
    const message = invoiceEmail({
      companyName: tenant?.name ?? 'Your supplier',
      customerName: String(invoice.contact_name),
      number: String(invoice.number),
      total: new Intl.NumberFormat('en-US', { style: 'currency', currency: String(invoice.currency) }).format(fromMinor(Number(invoice.total))),
      dueDate: String(invoice.due_date ?? invoice.issue_date),
      link: `${config.appUrl}/pay/${token}`,
      message: body.message,
    });
    const to = body.to ?? String(invoice.contact_email ?? '');
    if (!to) throw unprocessable('This customer has no email address. Add one or supply a recipient.');
    const result = await sendEmail(req.db, ctx.tenantId, { ...message, to });
    await req.db.run(`UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      id,
    ]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'invoice.sent',
      entityType: 'invoice',
      entityId: id,
      summary: `Invoice emailed to ${to}`,
      after: { to, provider: result.provider, status: result.status },
    });
    await emitEvent(req.db, ctx.tenantId, 'invoice.sent', { invoiceId: id, to });
    return { ok: true, email: result, paymentLink: `${config.appUrl}/pay/${token}` };
  });

  app.post('/invoices/:id/void', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    await voidInvoice(req.db, ctx.tenantId, id, ctx.user.id);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'invoice.voided',
      entityType: 'invoice',
      entityId: id,
      summary: 'Invoice voided',
    });
    await emitEvent(req.db, ctx.tenantId, 'invoice.voided', { invoiceId: id });
    return { ok: true };
  });

  app.post('/invoices/:id/remind', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const { invoice } = await loadInvoice(req.db, ctx.tenantId, id);
    const to = String(invoice.contact_email ?? '');
    if (!to) throw unprocessable('This customer has no email address');
    const tenant = await req.db.get<{ name: string }>('SELECT name FROM tenants WHERE id = ?', [ctx.tenantId]);
    const message = invoiceEmail({
      companyName: tenant?.name ?? '',
      customerName: String(invoice.contact_name),
      number: String(invoice.number),
      total: new Intl.NumberFormat('en-US', { style: 'currency', currency: String(invoice.currency) }).format(fromMinor(Number(invoice.balance))),
      dueDate: String(invoice.due_date ?? invoice.issue_date),
      link: `${config.appUrl}/pay/${invoice.payment_link_token ?? invoice.id}`,
      message: `A friendly reminder that invoice ${invoice.number} is due.`,
    });
    await sendEmail(req.db, ctx.tenantId, { ...message, to });
    await req.db.run(
      `INSERT INTO invoice_reminders (id, tenant_id, invoice_id, reminder_type, status, sent_at, message) VALUES (?, ?, ?, 'manual', 'sent', ?, ?)`,
      [newId(), ctx.tenantId, id, new Date().toISOString(), message.subject],
    );
    await req.db.run('UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    await emitEvent(req.db, ctx.tenantId, 'invoice.reminder', { invoiceId: id, to });
    return { ok: true };
  });

  app.get('/invoices/:id/pdf', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const { invoice, lines } = await loadInvoice(req.db, ctx.tenantId, id);
    const company = await req.db.get<{ name: string; email: string | null; address_json: string | null }>(
      'SELECT name, email, address_json FROM tenants WHERE id = ?',
      [ctx.tenantId],
    );
    const address = company?.address_json ? (JSON.parse(company.address_json) as Record<string, string>) : {};
    const pdf = await renderDocumentPdf({
      kind: invoice.kind === 'credit_memo' ? 'Credit memo' : invoice.kind === 'estimate' ? 'Estimate' : 'Invoice',
      number: String(invoice.number),
      issueDate: String(invoice.issue_date),
      dueDate: invoice.due_date ? String(invoice.due_date) : null,
      currency: String(invoice.currency),
      company: {
        name: company?.name ?? '',
        email: company?.email,
        lines: [address.line1, address.city, address.country].filter(Boolean) as string[],
      },
      party: {
        name: String(invoice.contact_name),
        email: invoice.contact_email ? String(invoice.contact_email) : null,
        lines: invoice.billing_address_json
          ? Object.values(JSON.parse(String(invoice.billing_address_json)) as Record<string, string>).filter(Boolean)
          : [],
      },
      partyLabel: 'Bill to',
      lines: lines.map((l) => ({
        description: String(l.description),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price),
        amount: Number(l.amount),
      })),
      subtotal: Number(invoice.subtotal),
      taxTotal: Number(invoice.tax_total),
      total: Number(invoice.total),
      amountPaid: Number(invoice.amount_paid),
      balance: Number(invoice.balance),
      memo: invoice.memo ? String(invoice.memo) : null,
      terms: invoice.terms ? String(invoice.terms) : null,
    });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${invoice.number}.pdf"`)
      .send(pdf);
  });

  app.post('/invoices/:id/duplicate', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const { invoice, lines } = await loadInvoice(req.db, ctx.tenantId, id);
    const newInvoiceId = await createInvoice(req.db, ctx.tenantId, ctx.user.id, {
      contactId: String(invoice.contact_id),
      kind: 'invoice',
      issueDate: new Date().toISOString().slice(0, 10),
      currency: String(invoice.currency),
      memo: invoice.memo ? String(invoice.memo) : undefined,
      terms: invoice.terms ? String(invoice.terms) : undefined,
      lines: lines.map((l) => ({
        description: String(l.description),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price),
        accountId: l.account_id ? String(l.account_id) : null,
        taxCodeId: l.tax_code_id ? String(l.tax_code_id) : null,
        itemId: l.item_id ? String(l.item_id) : null,
      })),
      status: 'draft',
    });
    return reply.code(201).send({ id: newInvoiceId });
  });

  app.post('/invoices/:id/convert', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const invoiceId = await convertEstimate(req.db, req.ctx!.tenantId, id, req.ctx!.user.id);
    return reply.code(201).send({ id: invoiceId });
  });

  app.post('/invoices/bulk', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const body = parse(
      z.object({
        ids: z.array(z.string()).min(1).max(200),
        action: z.enum(['post', 'void', 'delete_draft']),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    let affected = 0;
    for (const id of body.ids) {
      try {
        if (body.action === 'post') {
          await postInvoice(req.db, ctx.tenantId, id, ctx.user.id);
          affected += 1;
        } else if (body.action === 'void') {
          await voidInvoice(req.db, ctx.tenantId, id, ctx.user.id);
          affected += 1;
        } else {
          const invoice = await req.db.get<{ status: string }>('SELECT status FROM invoices WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
          if (invoice?.status === 'draft') {
            await req.db.run('DELETE FROM invoice_lines WHERE tenant_id = ? AND invoice_id = ?', [ctx.tenantId, id]);
            await req.db.run('DELETE FROM invoices WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
            affected += 1;
          }
        }
      } catch {
        // Skip documents that cannot transition (already posted, etc.)
      }
    }
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: `invoice.bulk_${body.action}`,
      entityType: 'invoice',
      summary: `Bulk ${body.action} on ${body.ids.length} documents (${affected} succeeded)`,
    });
    return { affected, requested: body.ids.length };
  });

  // ------------------------------------------------------------- recurring --
  app.get('/recurring-invoices', { preHandler: requireAuth() }, async (req) => {
    const rows = await req.db.all(
      `SELECT r.*, c.name AS contact_name FROM recurring_invoices r JOIN contacts c ON c.id = r.contact_id
       WHERE r.tenant_id = ? ORDER BY r.next_date`,
      [req.ctx!.tenantId],
    );
    return {
      data: rows.map((r) => ({ ...r, template: JSON.parse(String((r as Record<string, unknown>).template_json)) })),
    };
  });

  app.post('/recurring-invoices', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().min(2).max(120),
        contactId: z.string().uuid(),
        frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).default('monthly'),
        intervalCount: z.coerce.number().int().min(1).max(12).default(1),
        nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        autoSend: z.boolean().default(true),
        lines: z.array(lineSchema).min(1),
        memo: z.string().max(500).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const id = newId();
    await req.db.run(
      `INSERT INTO recurring_invoices (id, tenant_id, name, contact_id, frequency, interval_count, next_date, end_date,
         template_json, auto_send, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        id,
        ctx.tenantId,
        body.name,
        body.contactId,
        body.frequency,
        body.intervalCount,
        body.nextDate,
        body.endDate ?? null,
        JSON.stringify({ lines: body.lines, memo: body.memo }),
        body.autoSend ? 1 : 0,
        new Date().toISOString(),
      ],
    );
    return reply.code(201).send({ id });
  });

  app.patch('/recurring-invoices/:id', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(z.object({ status: z.enum(['active', 'paused', 'ended']), nextDate: z.string().optional() }), req.body);
    await req.db.run('UPDATE recurring_invoices SET status = ?, next_date = COALESCE(?, next_date) WHERE tenant_id = ? AND id = ?', [
      body.status,
      body.nextDate ?? null,
      req.ctx!.tenantId,
      id,
    ]);
    return { ok: true };
  });

  // ------------------------------------------------------------- templates --
  app.get('/invoice-templates', { preHandler: requireAuth() }, async (req) => ({
    data: await req.db.all('SELECT * FROM invoice_templates WHERE tenant_id = ? ORDER BY created_at', [req.ctx!.tenantId]),
  }));

  app.post('/invoice-templates', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().min(1).max(80),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),
        layout: z.enum(['modern', 'classic', 'minimal']).default('modern'),
        footerText: z.string().max(500).optional(),
        showLogo: z.boolean().default(true),
        isDefault: z.boolean().default(false),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const id = newId();
    if (body.isDefault) await req.db.run('UPDATE invoice_templates SET is_default = 0 WHERE tenant_id = ?', [ctx.tenantId]);
    await req.db.run(
      `INSERT INTO invoice_templates (id, tenant_id, name, accent_color, layout, footer_text, show_logo, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.tenantId, body.name, body.accentColor, body.layout, body.footerText ?? null, body.showLogo ? 1 : 0, body.isDefault ? 1 : 0, new Date().toISOString()],
    );
    return reply.code(201).send({ id });
  });
}
