import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { newId } from '../db/driver.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { fromMinor } from '../lib/money.js';
import { paginated, paging, paginationSchema, parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { emitEvent } from '../services/events.js';
import { recordPayment, voidPayment } from '../services/documents.js';

const paymentSchema = z.object({
  direction: z.enum(['receipt', 'disbursement']).default('receipt'),
  contactId: z.string().uuid().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().int().positive(),
  method: z.enum(['card', 'ach', 'bank_transfer', 'cash', 'check', 'other']).default('bank_transfer'),
  reference: z.string().max(120).optional(),
  depositAccountId: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  providerFee: z.coerce.number().int().min(0).optional(),
  notes: z.string().max(1000).optional(),
  applications: z
    .array(z.object({ invoiceId: z.string().uuid().optional(), billId: z.string().uuid().optional(), amount: z.coerce.number().int().positive() }))
    .default([]),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/payments/providers', { preHandler: requireAuth() }, async () => ({
    card: {
      provider: config.stripeSecretKey ? 'stripe' : 'sandbox',
      configured: Boolean(config.stripeSecretKey),
      live: Boolean(config.stripeSecretKey) && config.isProd,
      description: config.stripeSecretKey
        ? 'Stripe is connected. Card details never touch LedgerLine servers (PCI SAQ A).'
        : 'Sandbox mode: checkout is simulated locally. Add STRIPE_SECRET_KEY to charge real cards.',
    },
    ach: {
      configured: Boolean(config.stripeSecretKey),
      description: 'ACH / bank debit is offered through the same provider when available.',
    },
  }));

  app.get('/payments', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const query = parse(
      paginationSchema.extend({ direction: z.enum(['receipt', 'disbursement', 'all']).default('all'), status: z.string().optional() }),
      req.query,
    );
    const where = ['p.tenant_id = ?'];
    const params: Array<string | number> = [ctx.tenantId];
    if (query.direction !== 'all') {
      where.push('p.direction = ?');
      params.push(query.direction);
    }
    if (query.status) {
      where.push('p.status = ?');
      params.push(query.status);
    }
    if (query.from) {
      where.push('p.date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      where.push('p.date <= ?');
      params.push(query.to);
    }
    const { limit, offset } = paging(query.page, query.pageSize);
    const total = await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM payments p WHERE ${where.join(' AND ')}`, params);
    const rows = await req.db.all<Record<string, unknown>>(
      `SELECT p.*, c.name AS contact_name,
        (SELECT COUNT(*) FROM payment_applications a WHERE a.payment_id = p.id) AS application_count
       FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE ${where.join(' AND ')} ORDER BY p.date DESC, p.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(rows, Number(total?.n ?? 0), query.page, query.pageSize);
  });

  app.get('/payments/:id', { preHandler: requireAuth() }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    const payment = await req.db.get<Record<string, unknown>>(
      `SELECT p.*, c.name AS contact_name FROM payments p LEFT JOIN contacts c ON c.id = p.contact_id
       WHERE p.tenant_id = ? AND p.id = ?`,
      [ctx.tenantId, id],
    );
    if (!payment) throw notFound('Payment not found');
    const applications = await req.db.all(
      `SELECT pa.*, i.number AS invoice_number, b.number AS bill_number
       FROM payment_applications pa
       LEFT JOIN invoices i ON i.id = pa.invoice_id
       LEFT JOIN bills b ON b.id = pa.bill_id
       WHERE pa.tenant_id = ? AND pa.payment_id = ?`,
      [ctx.tenantId, id],
    );
    const journal = payment.journal_entry_id
      ? await req.db.all(
          `SELECT jl.debit, jl.credit, jl.description, a.code, a.name FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ? ORDER BY jl.line_no`,
          [payment.journal_entry_id],
        )
      : [];
    return { payment, applications, journal };
  });

  app.post('/payments', { preHandler: requireAuth('payments:write') }, async (req, reply) => {
    const body = parse(paymentSchema, req.body);
    const ctx = req.ctx!;
    const result = await recordPayment(req.db, ctx.tenantId, ctx.user.id, body);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: body.direction === 'receipt' ? 'payment.received' : 'payment.made',
      entityType: 'payment',
      entityId: result.paymentId,
      summary: `${body.direction === 'receipt' ? 'Received' : 'Made'} payment of ${fromMinor(body.amount)}`,
      after: { amount: body.amount, method: body.method, applications: body.applications.length },
    });
    if (body.direction === 'receipt') await emitEvent(req.db, ctx.tenantId, 'payment.received', { paymentId: result.paymentId, amount: body.amount });
    else await emitEvent(req.db, ctx.tenantId, 'bill.paid', { paymentId: result.paymentId, amount: body.amount });
    const hasInvoice = body.applications.some((a) => a.invoiceId);
    if (hasInvoice) await emitEvent(req.db, ctx.tenantId, 'invoice.paid', { paymentId: result.paymentId, applications: body.applications });
    return reply.code(201).send(result);
  });

  app.post('/payments/:id/void', { preHandler: requireAuth('payments:write') }, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params);
    const ctx = req.ctx!;
    await voidPayment(req.db, ctx.tenantId, id, ctx.user.id);
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'payment.voided',
      entityType: 'payment',
      entityId: id,
      summary: 'Payment voided and applications released',
    });
    return { ok: true };
  });

  // ------------------------------------------------------- public pay page --
  app.get('/public/invoices/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(6) }), req.params);
    const invoice = await req.db.get<Record<string, unknown>>(
      `SELECT i.id, i.number, i.issue_date, i.due_date, i.total, i.balance, i.currency, i.status, i.memo,
              c.name AS contact_name, t.name AS company_name
       FROM invoices i JOIN contacts c ON c.id = i.contact_id JOIN tenants t ON t.id = i.tenant_id
       WHERE i.payment_link_token = ? OR i.id = ?`,
      [token, token],
    );
    if (!invoice) throw notFound('This payment link is no longer valid');
    const lines = await req.db.all('SELECT description, quantity, unit_price, amount FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [invoice.id]);
    const providers = await req.db.get<{ provider: string | null }>(
      "SELECT provider FROM payments WHERE tenant_id = (SELECT tenant_id FROM invoices WHERE id = ?) LIMIT 1",
      [invoice.id],
    );
    void providers;
    return {
      invoice: {
        ...invoice,
        totalDisplay: fromMinor(Number(invoice.total), 2),
        balanceDisplay: fromMinor(Number(invoice.balance), 2),
      },
      lines,
      paymentsEnabled: true,
      provider: config.stripeSecretKey ? 'stripe' : 'sandbox',
      sandbox: !config.stripeSecretKey,
    };
  });

  app.post('/public/invoices/:token/checkout', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(6) }), req.params);
    const body = parse(z.object({ amount: z.coerce.number().int().positive().optional() }), req.body ?? {});
    const invoice = await req.db.get<{ id: string; tenant_id: string; number: string; balance: number; currency: string; contact_id: string }>(
      'SELECT id, tenant_id, number, balance, currency, contact_id FROM invoices WHERE payment_link_token = ? OR id = ?',
      [token, token],
    );
    if (!invoice) throw notFound('This payment link is no longer valid');
    if (invoice.balance <= 0) throw unprocessable('This invoice is already paid');
    const amount = Math.min(body.amount ?? invoice.balance, invoice.balance);
    const providerRef = `pi_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

    if (config.stripeSecretKey) {
      const form = new URLSearchParams();
      form.set('mode', 'payment');
      form.set('success_url', `${config.appUrl}/pay/${token}?status=success`);
      form.set('cancel_url', `${config.appUrl}/pay/${token}?status=cancelled`);
      form.set('client_reference_id', invoice.id);
      form.set('line_items[0][quantity]', '1');
      form.set('line_items[0][price_data][currency]', invoice.currency.toLowerCase());
      form.set('line_items[0][price_data][unit_amount]', String(amount));
      form.set('line_items[0][price_data][product_data][name]', `Invoice ${invoice.number}`);
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.stripeSecretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      if (!res.ok) throw unprocessable('The payment provider rejected this request. Try again later.');
      const session = (await res.json()) as { id: string; url: string };
      return { provider: 'stripe', url: session.url, reference: session.id, amount };
    }

    // Sandbox: settle immediately through the same code path as a provider webhook.
    const payment = await recordPayment(req.db, invoice.tenant_id, null, {
      direction: 'receipt',
      contactId: invoice.contact_id,
      date: new Date().toISOString().slice(0, 10),
      amount,
      method: 'card',
      provider: 'sandbox',
      providerRef,
      providerFee: Math.round(amount * 0.029) + 30,
      applications: [{ invoiceId: invoice.id, amount }],
    });
    await emitEvent(req.db, invoice.tenant_id, 'payment.received', { paymentId: payment.paymentId, amount, provider: 'sandbox' });
    return { provider: 'sandbox', simulated: true, paymentId: payment.paymentId, amount };
  });

  /**
   * Provider callbacks. Card data never reaches this service: only the tokenised
   * payment reference and amount, keeping the app in PCI DSS SAQ A scope.
   */
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8') || '{}'));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    scope.post('/webhooks/payments/:provider', async (req, reply) => {
      const { provider } = parse(z.object({ provider: z.enum(['stripe', 'adyen', 'sandbox']) }), req.params);
      const raw = ((req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}))).toString('utf8');
      const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? '';
      const signature = req.headers['stripe-signature'] ?? req.headers['x-signature'];
      if (secret) {
        const expected = createHmac('sha256', secret).update(raw).digest('hex');
        const provided = String(signature ?? '').split(',').find((part) => part.startsWith('v1='))?.slice(3) ?? String(signature ?? '');
        const a = Buffer.from(expected);
        const b = Buffer.from(provided);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Signature verification failed' } });
        }
      } else if (config.isProd) {
        return reply.code(400).send({ error: { code: 'not_configured', message: 'Payment webhooks are not configured' } });
      }

      const event = req.body as {
        type?: string;
        data?: { object?: { id?: string; amount_total?: number; amount_received?: number; metadata?: { invoice_id?: string }; client_reference_id?: string } };
      };
      const object = event.data?.object ?? {};
      const invoiceId = object.metadata?.invoice_id ?? object.client_reference_id;
      if (!invoiceId) return reply.send({ received: true, ignored: true });
      const invoice = await req.db.get<{ id: string; tenant_id: string; contact_id: string; balance: number }>(
        'SELECT id, tenant_id, contact_id, balance FROM invoices WHERE id = ?',
        [invoiceId],
      );
      if (!invoice) return reply.send({ received: true, ignored: true });
      const amount = Math.min(Number(object.amount_total ?? object.amount_received ?? invoice.balance), Number(invoice.balance));
      if (amount <= 0) return reply.send({ received: true, ignored: true });
      const payment = await recordPayment(req.db, invoice.tenant_id, null, {
        direction: 'receipt',
        contactId: invoice.contact_id,
        date: new Date().toISOString().slice(0, 10),
        amount,
        method: 'card',
        provider,
        providerRef: object.id ?? null,
        applications: [{ invoiceId: invoice.id, amount }],
      });
      await recordAudit(req.db, {
        tenantId: invoice.tenant_id,
        actor: { id: null, email: `${provider}@webhook`, role: 'system', ip: req.ip },
        action: 'payment.webhook',
        entityType: 'payment',
        entityId: payment.paymentId,
        summary: `Provider webhook ${event.type ?? 'payment'} for invoice ${invoiceId}`,
        after: { amount, provider },
      });
      await emitEvent(req.db, invoice.tenant_id, 'invoice.paid', { invoiceId, paymentId: payment.paymentId, amount });
      return reply.send({ received: true });
    });
  });

  /**
   * Deposit matched receipts: move money from Undeposited Funds to the bank.
   */
  app.post('/payments/deposit', { preHandler: requireAuth('payments:write') }, async (req, reply) => {
    const body = parse(z.object({ paymentIds: z.array(z.string()).min(1), bankAccountId: z.string().uuid() }), req.body);
    const ctx = req.ctx!;
    const bank = await req.db.get<{ account_id: string; name: string }>(
      'SELECT account_id, name FROM bank_accounts WHERE tenant_id = ? AND id = ?',
      [ctx.tenantId, body.bankAccountId],
    );
    if (!bank) throw notFound('Bank account not found');
    const { systemAccount } = await import('../domain/ledger.js');
    const { postJournal } = await import('../domain/ledger.js');
    const undeposited = await systemAccount(req.db, ctx.tenantId, 'undeposited_funds');
    const payments = await req.db.all<{ id: string; amount: number; provider_fee: number; currency: string; contact_id: string | null }>(
      `SELECT id, amount, provider_fee, currency, contact_id FROM payments
       WHERE tenant_id = ? AND id IN (${body.paymentIds.map(() => '?').join(',')}) AND direction = 'receipt' AND status = 'completed'`,
      [ctx.tenantId, ...body.paymentIds],
    );
    if (!payments.length) throw notFound('No eligible payments found');
    const total = payments.reduce((a, p) => a + Number(p.amount) - Number(p.provider_fee ?? 0), 0);
    const entryId = await postJournal(req.db, {
      tenantId: ctx.tenantId,
      date: new Date().toISOString().slice(0, 10),
      memo: `Deposit of ${payments.length} receipts to ${bank.name}`,
      sourceType: 'bank',
      sourceId: body.bankAccountId,
      currency: ctx.tenant.base_currency,
      createdBy: ctx.user.id,
      lines: [
        { accountId: bank.account_id, debit: total, description: 'Bank deposit' },
        { accountId: undeposited.id, credit: total, description: 'Undeposited funds cleared' },
      ],
    });
    await req.db.run(
      `UPDATE payments SET deposit_account_id = ? WHERE tenant_id = ? AND id IN (${body.paymentIds.map(() => '?').join(',')})`,
      [bank.account_id, ctx.tenantId, ...body.paymentIds],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'payments.deposited',
      entityType: 'payment',
      entityId: entryId,
      summary: `Deposited ${payments.length} receipts`,
    });
    return reply.code(201).send({ journalEntryId: entryId, total });
  });

  app.get('/payments/summary', { preHandler: requireAuth() }, async (req) => {
    const ctx = req.ctx!;
    const row = await req.db.get<{ received: number; disbursed: number; fees: number }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'receipt' THEN amount ELSE 0 END),0) AS received,
              COALESCE(SUM(CASE WHEN direction = 'disbursement' THEN amount ELSE 0 END),0) AS disbursed,
              COALESCE(SUM(provider_fee),0) AS fees
       FROM payments WHERE tenant_id = ? AND status = 'completed' AND date >= ?`,
      [ctx.tenantId, `${new Date().toISOString().slice(0, 7)}-01`],
    );
    return {
      received: Number(row?.received ?? 0),
      disbursed: Number(row?.disbursed ?? 0),
      fees: Number(row?.fees ?? 0),
      newId: newId(),
    };
  });
}
