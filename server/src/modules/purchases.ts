import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { emitEvent } from '../services/events.js';
import { createBill, createExpense, postBill, postExpense } from '../services/documents.js';
import { voidJournal } from '../domain/ledger.js';
import { extractReceipt } from '../services/ocr.js';
import { putFile } from '../services/storage.js';
import { renderDocumentPdf } from '../services/pdf.js';
import { fromMinor } from '../lib/money.js';

const lineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().min(0).max(1_000_000).default(1),
  unitPrice: z.coerce.number().int().min(0),
  accountId: z.string().uuid().nullable().optional(),
  taxCodeId: z.string().uuid().nullable().optional(),
  itemId: z.string().uuid().nullable().optional(),
});

const billSchema = z.object({
  vendorId: z.string().uuid(),
  number: z.string().max(60).optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  currency: z.string().length(3).optional(),
  lines: z.array(lineSchema).min(1),
  memo: z.string().max(2000).optional(),
  status: z.enum(['draft', 'open']).default('open'),
  scheduledPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function purchaseRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bills', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({ status: z.string().optional(), vendorId: z.string().optional(), due: z.enum(['all', 'week', 'overdue']).default('all') }),
      req.query,
    );
    const where = ['b.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.status && query.status !== 'all') {
      where.push(`b.status IN (${query.status.split(',').map(() => '?').join(',')})`);
      params.push(...query.status.split(','));
    }
    if (query.vendorId) {
      where.push('b.vendor_id = ?');
      params.push(query.vendorId);
    }
    if (query.q) {
      where.push('(LOWER(b.number) LIKE ? OR LOWER(c.name) LIKE ?)');
      const like = `%${query.q.toLowerCase()}%`;
      params.push(like, like);
    }
    if (query.due === 'overdue') where.push("b.balance > 0 AND b.due_date < ?"), params.push(new Date().toISOString().slice(0, 10));
    if (query.due === 'week') {
      where.push('b.balance > 0 AND b.due_date <= ?');
      params.push(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bills b JOIN contacts c ON c.id = b.vendor_id WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT b.*, c.name AS vendor_name FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE ${where.join(' AND ')} ORDER BY b.due_date ASC, b.issue_date DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const summary = await req.db.get<{ outstanding: number; overdue: number; scheduled: number }>(
      `SELECT COALESCE(SUM(balance),0) AS outstanding,
              COALESCE(SUM(CASE WHEN due_date < ? THEN balance ELSE 0 END),0) AS overdue,
              COALESCE(SUM(CASE WHEN scheduled_payment_date IS NOT NULL AND balance > 0 THEN balance ELSE 0 END),0) AS scheduled
       FROM bills WHERE tenant_id = ? AND status NOT IN ('draft','void','paid')`,
      [new Date().toISOString().slice(0, 10), ctx.tenantId],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize, {
      summary: { outstanding: Number(summary?.outstanding ?? 0), overdue: Number(summary?.overdue ?? 0), scheduled: Number(summary?.scheduled ?? 0) },
    });
  });

  app.get('/bills/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const bill = await req.db.get<Record<string, unknown>>(
      `SELECT b.*, c.name AS vendor_name, c.email AS vendor_email FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE b.tenant_id = ? AND b.id = ?`,
      [ctx.tenantId, id],
    );
    if (!bill) throw notFound('Bill not found');
    const lines = await req.db.all('SELECT * FROM bill_lines WHERE tenant_id = ? AND bill_id = ? ORDER BY line_no', [ctx.tenantId, id]);
    const payments = await req.db.all(
      `SELECT p.id, p.number, p.date, p.amount, p.method, pa.amount AS applied
       FROM payment_applications pa JOIN payments p ON p.id = pa.payment_id WHERE pa.tenant_id = ? AND pa.bill_id = ?`,
      [ctx.tenantId, id],
    );
    const attachments = await req.db.all("SELECT * FROM attachments WHERE tenant_id = ? AND entity_type = 'bill' AND entity_id = ?", [ctx.tenantId, id]);
    return { bill, lines, payments, attachments };
  });

  app.post('/bills', { preHandler: requireAuth('bills:write') }, async (req, reply) => {
    const body = parse(billSchema, req.body);
    const ctx = req.ctx!;
    const id = await createBill(req.db, ctx.tenantId, ctx.user.id, body);
    const bill = await req.db.get<{ number: string; total: number }>('SELECT number, total FROM bills WHERE id = ?', [id]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'bill.created',
      entityType: 'bill',
      entityId: id,
      summary: `Created bill ${bill?.number}`,
      after: { total: bill?.total, vendorId: body.vendorId },
    });
    await emitEvent(req.db, ctx.tenantId, 'bill.created', { billId: id, number: bill?.number, total: bill?.total });
    return reply.code(201).send({ id, number: bill?.number });
  });

  app.patch('/bills/:id', { preHandler: requireAuth('bills:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const body = parse(
      z.object({
        scheduledPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        memo: z.string().max(2000).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const bill = await req.db.get('SELECT id FROM bills WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!bill) throw notFound('Bill not found');
    await req.db.run(
      'UPDATE bills SET scheduled_payment_date = ?, due_date = COALESCE(?, due_date), memo = COALESCE(?, memo), updated_at = ? WHERE tenant_id = ? AND id = ?',
      [body.scheduledPaymentDate ?? null, body.dueDate ?? null, body.memo ?? null, new Date().toISOString(), ctx.tenantId, id],
    );
    return { ok: true };
  });

  app.post('/bills/:id/post', { preHandler: requireAuth('bills:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await postBill(req.db, req.ctx!.tenantId, id, req.ctx!.user.id);
    return { ok: true };
  });

  app.post('/bills/:id/void', { preHandler: requireAuth('bills:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const bill = await req.db.get<{ journal_entry_id: string | null; amount_paid: number; number: string }>(
      'SELECT * FROM bills WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!bill) throw notFound('Bill not found');
    if (bill.amount_paid > 0) throw conflict('Remove applied payments before voiding');
    if (bill.journal_entry_id) await voidJournal(req.db, ctx.tenantId, bill.journal_entry_id);
    await req.db.run("UPDATE bills SET status = 'void', balance = 0, updated_at = ? WHERE tenant_id = ? AND id = ?", [
      new Date().toISOString(),
      ctx.tenantId,
      id,
    ]);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'bill.voided',
      entityType: 'bill',
      entityId: id,
      summary: `Voided bill ${bill.number}`,
    });
    return { ok: true };
  });

  app.get('/bills/:id/pdf', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const bill = await req.db.get<Record<string, unknown>>(
      `SELECT b.*, c.name AS vendor_name, c.email AS vendor_email FROM bills b JOIN contacts c ON c.id = b.vendor_id
       WHERE b.tenant_id = ? AND b.id = ?`,
      [ctx.tenantId, id],
    );
    if (!bill) throw notFound('Bill not found');
    const lines = await req.db.all<Record<string, unknown>>('SELECT * FROM bill_lines WHERE bill_id = ? ORDER BY line_no', [id]);
    const company = await req.db.get<{ name: string; email: string | null }>('SELECT name, email FROM tenants WHERE id = ?', [ctx.tenantId]);
    const pdf = await renderDocumentPdf({
      kind: 'Bill',
      number: String(bill.number),
      issueDate: String(bill.issue_date),
      dueDate: bill.due_date ? String(bill.due_date) : null,
      currency: String(bill.currency),
      company: { name: company?.name ?? '', email: company?.email },
      party: { name: String(bill.vendor_name), email: bill.vendor_email ? String(bill.vendor_email) : null },
      partyLabel: 'Vendor',
      lines: lines.map((l) => ({
        description: String(l.description),
        quantity: Number(l.quantity),
        unitPrice: Number(l.unit_price),
        amount: Number(l.amount),
      })),
      subtotal: Number(bill.subtotal),
      taxTotal: Number(bill.tax_total),
      total: Number(bill.total),
      memo: bill.memo ? String(bill.memo) : null,
    });
    return reply.header('content-type', 'application/pdf').send(pdf);
  });

  // -------------------------------------------------------------- expenses --
  app.get('/expenses', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(paginationSchema.extend({ status: z.string().optional(), mine: z.coerce.boolean().optional() }), req.query);
    const where = ['e.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.status && query.status !== 'all') {
      where.push(`e.status IN (${query.status.split(',').map(() => '?').join(',')})`);
      params.push(...query.status.split(','));
    }
    if (query.mine || ctx.role === 'employee') {
      where.push('e.created_by = ?');
      params.push(ctx.user.id);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM expenses e WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT e.*, c.name AS contact_name, a.filename AS receipt_name,
        (SELECT COUNT(*) FROM expense_lines l WHERE l.expense_id = e.id) AS line_count
       FROM expenses e
       LEFT JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN attachments a ON a.id = e.receipt_attachment_id
       WHERE ${where.join(' AND ')} ORDER BY e.date DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize);
  });

  app.post('/expenses', { preHandler: requireAuth('expenses:submit') }, async (req, reply) => {
    const body = parse(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        contactId: z.string().uuid().nullable().optional(),
        employeeId: z.string().uuid().nullable().optional(),
        memo: z.string().max(1000).optional(),
        currency: z.string().length(3).optional(),
        paymentMethod: z.string().max(40).optional(),
        lines: z
          .array(
            z.object({
              accountId: z.string().uuid(),
              description: z.string().max(300).optional(),
              amount: z.coerce.number().int().min(1),
              taxCodeId: z.string().uuid().nullable().optional(),
            }),
          )
          .min(1),
        receiptAttachmentId: z.string().uuid().nullable().optional(),
        ocr: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(['draft', 'submitted', 'approved']).default('submitted'),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const id = await createExpense(req.db, ctx.tenantId, ctx.user.id, body);
    if (body.ocr) {
      await req.db.run('UPDATE expenses SET ocr_json = ? WHERE tenant_id = ? AND id = ?', [
        JSON.stringify(body.ocr),
        ctx.tenantId,
        id,
      ]);
    }
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'expense.created',
      entityType: 'expense',
      entityId: id,
      summary: 'Expense submitted',
      after: { total: body.lines.reduce((a, b) => a + b.amount, 0) },
    });
    await emitEvent(req.db, ctx.tenantId, 'expense.submitted', { expenseId: id });
    return reply.code(201).send({ id });
  });

  app.get('/expenses/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const expense = await req.db.get<Record<string, unknown>>('SELECT * FROM expenses WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!expense) throw notFound('Expense not found');
    if (ctx.role === 'employee' && expense.created_by !== ctx.user.id) throw notFound('Expense not found');
    const lines = await req.db.all('SELECT * FROM expense_lines WHERE tenant_id = ? AND expense_id = ? ORDER BY line_no', [ctx.tenantId, id]);
    const attachment = expense.receipt_attachment_id
      ? await req.db.get('SELECT id, filename, mime_type, size_bytes, storage_key FROM attachments WHERE id = ?', [expense.receipt_attachment_id])
      : null;
    return { expense, lines, attachment, ocr: expense.ocr_json ? JSON.parse(String(expense.ocr_json)) : null };
  });

  app.post('/expenses/:id/approve', { preHandler: requireAuth('timesheets:approve') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const expense = await req.db.get<{ status: string; journal_entry_id: string | null }>('SELECT * FROM expenses WHERE tenant_id = ? AND id = ?', [ctx.tenantId, id]);
    if (!expense) throw notFound('Expense not found');
    if (expense.status === 'posted') throw conflict('Expense is already posted');
    await req.db.run(`UPDATE expenses SET status = 'approved', approved_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`, [
      ctx.user.id,
      new Date().toISOString(),
      ctx.tenantId,
      id,
    ]);
    await postExpense(req.db, ctx.tenantId, id, ctx.user.id);
    await emitEvent(req.db, ctx.tenantId, 'expense.approved', { expenseId: id });
    return { ok: true };
  });

  app.post('/expenses/:id/reject', { preHandler: requireAuth('timesheets:approve') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    await req.db.run(`UPDATE expenses SET status = 'rejected', updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('submitted','draft')`, [
      new Date().toISOString(),
      ctx.tenantId,
      id,
    ]);
    return { ok: true };
  });

  app.post('/expenses/:id/post', { preHandler: requireAuth('bills:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    await postExpense(req.db, req.ctx!.tenantId, id, req.ctx!.user.id);
    return { ok: true };
  });

  // -------------------------------------------------------------- receipts --
  app.post('/attachments', { preHandler: requireAuth() }, async (req, reply) => {
    const ctx = req.ctx!;
    const file = await req.file();
    if (!file) throw unprocessable('No file uploaded');
    if (file.file.bytesRead > 10 * 1024 * 1024) throw unprocessable('File exceeds the 10MB limit');
    const buffer = await file.toBuffer();
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'];
    if (file.mimetype && !allowed.includes(file.mimetype)) throw unprocessable(`Unsupported file type: ${file.mimetype}`);
    const stored = await putFile(ctx.tenantId, file.filename, buffer);
    const id = newId();
    const entityType = String((file.fields.entityType as { value?: string } | undefined)?.value ?? 'expense');
    const entityId = String((file.fields.entityId as { value?: string } | undefined)?.value ?? id);
    await req.db.run(
      `INSERT INTO attachments (id, tenant_id, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, sha256, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.tenantId, entityType, entityId, file.filename, file.mimetype, stored.size, stored.key, stored.sha256, ctx.user.id, new Date().toISOString()],
    );
    const ocr = await extractReceipt(file.filename, buffer, file.mimetype);
    return reply.code(201).send({ id, filename: file.filename, size: stored.size, ocr });
  });

  app.get('/attachments/:id', { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const attachment = await req.db.get<{ storage_key: string; filename: string; mime_type: string }>(
      'SELECT storage_key, filename, mime_type FROM attachments WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, id],
    );
    if (!attachment) throw notFound('Attachment not found');
    const { getFile } = await import('../services/storage.js');
    const data = await getFile(attachment.storage_key);
    return reply.header('content-type', attachment.mime_type).header('content-disposition', `inline; filename="${attachment.filename}"`).send(data);
  });

  /** Scheduled payment run: pays every bill scheduled on or before the date. */
  app.post('/bills/pay-scheduled', { preHandler: requireAuth('payments:write') }, async (req) => {
    const body = parse(z.object({ through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), depositAccountId: z.string().uuid() }), req.body);
    const ctx = req.ctx!;
    const bills = await req.db.all<{ id: string; number: string; vendor_id: string; balance: number; due_date: string }>(
      `SELECT id, number, vendor_id, balance, due_date FROM bills
       WHERE tenant_id = ? AND balance > 0 AND scheduled_payment_date IS NOT NULL AND scheduled_payment_date <= ?
         AND status IN ('open','scheduled','partial','overdue')`,
      [ctx.tenantId, body.through],
    );
    const { recordPayment } = await import('../services/documents.js');
    const results: Array<{ billId: string; paymentId?: string; amount: number; error?: string }> = [];
    for (const bill of bills) {
      try {
        const payment = await recordPayment(req.db, ctx.tenantId, ctx.user.id, {
          direction: 'disbursement',
          contactId: bill.vendor_id,
          date: new Date().toISOString().slice(0, 10),
          amount: Number(bill.balance),
          method: 'ach',
          depositAccountId: body.depositAccountId,
          applications: [{ billId: bill.id, amount: Number(bill.balance) }],
        });
        await req.db.run('UPDATE bills SET scheduled_payment_date = NULL WHERE id = ?', [bill.id]);
        await emitEvent(req.db, ctx.tenantId, 'bill.paid', { billId: bill.id, paymentId: payment.paymentId });
        results.push({ billId: bill.id, paymentId: payment.paymentId, amount: Number(bill.balance) });
      } catch (err) {
        results.push({ billId: bill.id, amount: Number(bill.balance), error: (err as Error).message });
      }
    }
    return { paid: results.filter((r) => !r.error).length, results };
  });

  app.get('/expenses/summary', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const rows = await req.db.all(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM expenses WHERE tenant_id = ? GROUP BY status`,
      [ctx.tenantId],
    );
    return { data: rows };
  });

  app.get('/bills/:id/payment-preview', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const bill = await req.db.get<{ balance: number; currency: string }>('SELECT balance, currency FROM bills WHERE tenant_id = ? AND id = ?', [
      req.ctx!.tenantId,
      id,
    ]);
    if (!bill) throw notFound('Bill not found');
    return { amount: Number(bill.balance), display: fromMinor(Number(bill.balance), 2), currency: bill.currency };
  });
}
