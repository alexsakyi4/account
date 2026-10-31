import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { randomToken } from '../lib/crypto.js';
import { conflict, notFound } from '../lib/errors.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';

const addressSchema = z
  .object({
    line1: z.string().max(120).optional(),
    line2: z.string().max(120).optional(),
    city: z.string().max(80).optional(),
    region: z.string().max(80).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(2).optional(),
  })
  .optional();

const contactSchema = z.object({
  name: z.string().min(1).max(160),
  kind: z.enum(['customer', 'vendor', 'both']).default('customer'),
  companyName: z.string().max(160).optional(),
  email: z.string().email().max(254).optional().or(z.literal('')),
  phone: z.string().max(40).optional(),
  billingAddress: addressSchema,
  shippingAddress: addressSchema,
  paymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  creditLimit: z.coerce.number().int().min(0).optional(),
  taxId: z.string().max(40).optional(),
  currency: z.string().length(3).optional(),
  notes: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
});

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/contacts', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({
        kind: z.enum(['customer', 'vendor', 'both', 'all']).default('all'),
        activeOnly: z.coerce.boolean().default(true),
      }),
      req.query,
    );
    const where = ['c.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.kind !== 'all') {
      if (query.kind === 'customer') where.push("c.kind IN ('customer','both')");
      else if (query.kind === 'vendor') where.push("c.kind IN ('vendor','both')");
      else where.push('c.kind = ?'), params.push(query.kind);
    }
    if (query.activeOnly) where.push('c.is_active = 1');
    if (query.q) {
      where.push('(LOWER(c.name) LIKE ? OR LOWER(COALESCE(c.email, \'\')) LIKE ? OR LOWER(COALESCE(c.company_name, \'\')) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts c WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT c.*,
        COALESCE((SELECT SUM(i.balance) FROM invoices i WHERE i.contact_id = c.id AND i.kind = 'invoice' AND i.status NOT IN ('draft','void','paid')), 0) AS open_invoices,
        COALESCE((SELECT SUM(b.balance) FROM bills b WHERE b.vendor_id = c.id AND b.status NOT IN ('draft','void','paid')), 0) AS open_bills,
        (SELECT MAX(i.issue_date) FROM invoices i WHERE i.contact_id = c.id AND i.kind = 'invoice') AS last_invoice_date
       FROM contacts c WHERE ${where.join(' AND ')}
       ORDER BY c.name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        companyName: r.company_name,
        email: r.email,
        phone: r.phone,
        paymentTermsDays: r.payment_terms_days,
        creditLimit: r.credit_limit,
        currency: r.currency,
        isActive: Number(r.is_active) === 1,
        openInvoices: Number(r.open_invoices ?? 0),
        openBills: Number(r.open_bills ?? 0),
        lastInvoiceDate: r.last_invoice_date,
      })),
      Number(total?.n ?? 0),
      query.page,
      query.pageSize,
    );
  });

  app.get('/contacts/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const contact = await req.db.get<Record<string, unknown>>('SELECT * FROM contacts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!contact) throw notFound('Contact not found');
    const invoices = await req.db.all(
      `SELECT id, kind, number, issue_date, due_date, status, total, balance, currency FROM invoices
       WHERE tenant_id = ? AND contact_id = ? ORDER BY issue_date DESC LIMIT 50`,
      [ctx.tenantId, id],
    );
    const bills = await req.db.all(
      `SELECT id, number, issue_date, due_date, status, total, balance FROM bills WHERE tenant_id = ? AND vendor_id = ? ORDER BY issue_date DESC LIMIT 50`,
      [ctx.tenantId, id],
    );
    const payments = await req.db.all(
      `SELECT id, direction, number, date, amount, method, status FROM payments WHERE tenant_id = ? AND contact_id = ? ORDER BY date DESC LIMIT 50`,
      [ctx.tenantId, id],
    );
    const stats = await req.db.get<{ invoiced: number; paid: number; outstanding: number; avg_days: number }>(
      `SELECT COALESCE(SUM(total),0) AS invoiced, COALESCE(SUM(amount_paid),0) AS paid,
              COALESCE(SUM(balance),0) AS outstanding, 0 AS avg_days
       FROM invoices WHERE tenant_id = ? AND contact_id = ? AND kind = 'invoice' AND status <> 'void'`,
      [ctx.tenantId, id],
    );
    return {
      contact: {
        ...contact,
        billingAddress: contact.billing_address_json ? JSON.parse(String(contact.billing_address_json)) : null,
        shippingAddress: contact.shipping_address_json ? JSON.parse(String(contact.shipping_address_json)) : null,
      },
      invoices,
      bills,
      payments,
      stats: {
        invoiced: Number(stats?.invoiced ?? 0),
        paid: Number(stats?.paid ?? 0),
        outstanding: Number(stats?.outstanding ?? 0),
      },
    };
  });

  app.post('/contacts', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const body = parse(contactSchema, req.body);
    const ctx = req.ctx!;
    const id = newId();
    const now = new Date().toISOString();
    await req.db.run(
      `INSERT INTO contacts (id, tenant_id, kind, name, company_name, email, phone, billing_address_json, shipping_address_json,
         payment_terms_days, credit_limit, tax_id, currency, notes, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ctx.tenantId,
        body.kind,
        body.name,
        body.companyName ?? null,
        body.email || null,
        body.phone ?? null,
        body.billingAddress ? JSON.stringify(body.billingAddress) : null,
        body.shippingAddress ? JSON.stringify(body.shippingAddress) : null,
        body.paymentTermsDays ?? 30,
        body.creditLimit ?? 0,
        body.taxId ?? null,
        body.currency ?? ctx.tenant.base_currency,
        body.notes ?? null,
        body.isActive === false ? 0 : 1,
        now,
        now,
      ],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'contact.created',
      entityType: 'contact',
      entityId: id,
      summary: `Created ${body.kind} ${body.name}`,
      after: body,
    });
    return reply.code(201).send({ id });
  });

  app.patch('/contacts/:id', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(contactSchema.partial(), req.body);
    const ctx = req.ctx!;
    const before = await req.db.get<Record<string, unknown>>('SELECT * FROM contacts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!before) throw notFound('Contact not found');
    await req.db.run(
      `UPDATE contacts SET kind = ?, name = ?, company_name = ?, email = ?, phone = ?, billing_address_json = ?,
        shipping_address_json = ?, payment_terms_days = ?, credit_limit = ?, tax_id = ?, currency = ?, notes = ?,
        is_active = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        body.kind ?? before.kind,
        body.name ?? before.name,
        body.companyName ?? before.company_name,
        body.email !== undefined ? body.email || null : before.email,
        body.phone ?? before.phone,
        body.billingAddress ? JSON.stringify(body.billingAddress) : before.billing_address_json,
        body.shippingAddress ? JSON.stringify(body.shippingAddress) : before.shipping_address_json,
        body.paymentTermsDays ?? before.payment_terms_days,
        body.creditLimit ?? before.credit_limit,
        body.taxId ?? before.tax_id,
        body.currency ?? before.currency,
        body.notes ?? before.notes,
        body.isActive === undefined ? before.is_active : body.isActive ? 1 : 0,
        new Date().toISOString(),
        ctx.tenantId,
        id,
      ],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
      summary: `Updated contact ${body.name ?? before.name}`,
      before,
      after: body,
    });
    return { ok: true };
  });

  app.delete('/contacts/:id', { preHandler: requireAuth('invoices:write') }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const used = await req.db.get<{ inv: number; bills: number }>(
      `SELECT (SELECT COUNT(*) FROM invoices WHERE contact_id = ?) AS inv, (SELECT COUNT(*) FROM bills WHERE vendor_id = ?) AS bills`,
      [id, id],
    );
    if (Number(used?.inv ?? 0) + Number(used?.bills ?? 0) > 0) {
      throw conflict('This contact has transactions. Deactivate it instead of deleting.');
    }
    await req.db.run('DELETE FROM contacts WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'contact.deleted',
      entityType: 'contact',
      entityId: id,
      summary: 'Contact deleted',
    });
    return reply.code(204).send();
  });

  app.get('/contacts/:id/statement', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const query = parse(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const ctx = req.ctx!;
    const contact = await req.db.get<{ name: string; email: string | null }>(
      'SELECT name, email FROM contacts WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!contact) throw notFound('Contact not found');
    const from = query.from ?? '0000-01-01';
    const to = query.to ?? new Date().toISOString().slice(0, 10);

    const opening = await req.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.tenant_id = ? AND jl.contact_id = ? AND a.type = 'asset' AND a.subtype = 'accounts_receivable'
         AND je.status = 'posted' AND je.date < ?`,
      [ctx.tenantId, id, from],
    );
    const rows = await req.db.all<{ date: string; type: string; number: string; debit: number; credit: number }>(
      `SELECT je.date, je.source_type AS type, COALESCE(i.number, p.number, je.memo) AS number, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id AND a.subtype = 'accounts_receivable'
       LEFT JOIN invoices i ON i.journal_entry_id = je.id
       LEFT JOIN payments p ON p.journal_entry_id = je.id
       WHERE jl.tenant_id = ? AND jl.contact_id = ? AND je.status = 'posted' AND je.date >= ? AND je.date <= ?
       ORDER BY je.date, je.entry_no`,
      [ctx.tenantId, id, from, to],
    );
    let running = Number(opening?.total ?? 0);
    const lines = rows.map((row) => {
      running += Number(row.debit) - Number(row.credit);
      return { date: row.date, type: row.type, reference: row.number, charge: Number(row.debit), credit: Number(row.credit), balance: running };
    });
    if (query.format === 'csv') {
      const { toCsv } = await import('../lib/csv.js');
      const csv = toCsv(
        [
          { Date: 'Opening balance', Type: '', Reference: '', Charge: '', Credit: '', Balance: (Number(opening?.total ?? 0) / 100).toFixed(2) },
          ...lines.map((l) => ({
            Date: l.date,
            Type: l.type,
            Reference: l.reference,
            Charge: (l.charge / 100).toFixed(2),
            Credit: (l.credit / 100).toFixed(2),
            Balance: (l.balance / 100).toFixed(2),
          })),
        ],
      );
      return { format: 'csv', filename: `statement-${contact.name.replace(/\W+/g, '-').toLowerCase()}.csv`, content: csv };
    }
    return {
      contact,
      from,
      to,
      openingBalance: Number(opening?.total ?? 0),
      closingBalance: running,
      lines,
    };
  });

  app.post('/contacts/:id/portal-link', { preHandler: requireAuth('invoices:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const contact = await req.db.get<{ portal_token: string | null }>('SELECT portal_token FROM contacts WHERE tenant_id = ? AND id = ?', [
      ctx.tenantId,
      id,
    ]);
    if (!contact) throw notFound('Contact not found');
    const token = contact.portal_token ?? randomToken(24);
    await req.db.run('UPDATE contacts SET portal_token = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', [
      token,
      new Date().toISOString(),
      ctx.tenantId,
      id,
    ]);
    return { token, path: `/portal/${token}` };
  });
}
