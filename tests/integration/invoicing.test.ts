import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, authed, createCustomer, createTestApp, journalTotals, registerCompany, taxCodeId, today, type Session, type TestContext } from '../helpers.js';

let ctx: TestContext;
let session: Session;

beforeAll(async () => {
  ctx = await createTestApp();
  session = await registerCompany(ctx, 'Invoice Test Co');
});
afterAll(async () => {
  await ctx.close();
});

describe('invoice to cash workflow', () => {
  it('creates a company with a complete chart of accounts', async () => {
    const res = await authed(ctx, session, 'GET', '/accounts');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(30);
    for (const type of ['asset', 'liability', 'equity', 'income', 'expense']) {
      expect(body.data.some((a: { type: string }) => a.type === type)).toBe(true);
    }
  });

  it('creates, posts and pays an invoice end to end', async () => {
    const customerId = await createCustomer(ctx, session, 'Northwind Traders');
    const income = await accountId(ctx, session, '4100');
    const vat = await taxCodeId(ctx, session, 'VAT15');

    const created = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [
        { description: 'Consulting', quantity: 2, unitPrice: 50_000, accountId: income, taxCodeId: vat },
      ],
      status: 'sent',
    });
    expect(created.statusCode).toBe(201);
    const invoiceId = created.json().id;

    const detail = await authed(ctx, session, 'GET', `/invoices/${invoiceId}`);
    const invoice = detail.json().invoice;
    expect(invoice.subtotal).toBe(100_000);
    expect(invoice.tax_total).toBe(15_000);
    expect(invoice.total).toBe(115_000);
    expect(invoice.journal_entry_id).toBeTruthy();
    expect(invoice.status).toBe('sent');

    // The ledger and subledger agree
    const ar = await ctx.db.get<{ v: number }>(
      `SELECT SUM(jl.debit - jl.credit) AS v FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
       WHERE je.status = 'posted' AND a.system_key = 'accounts_receivable'`,
    );
    expect(Number(ar?.v)).toBe(115_000);

    const payment = await authed(ctx, session, 'POST', '/payments', {
      direction: 'receipt',
      contactId: customerId,
      date: today(),
      amount: 115_000,
      method: 'bank_transfer',
      applications: [{ invoiceId, amount: 115_000 }],
    });
    expect(payment.statusCode).toBe(201);

    const after = await authed(ctx, session, 'GET', `/invoices/${invoiceId}`);
    expect(after.json().invoice.status).toBe('paid');
    expect(after.json().invoice.balance).toBe(0);

    const arAfter = await ctx.db.get<{ v: number }>(
      `SELECT SUM(jl.debit - jl.credit) AS v FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
       WHERE je.status = 'posted' AND a.system_key = 'accounts_receivable'`,
    );
    expect(Number(arAfter?.v)).toBe(0);
  });

  it('supports partial payments and computes the remaining balance', async () => {
    const customerId = await createCustomer(ctx, session, 'Bluepeak Studio');
    const income = await accountId(ctx, session, '4100');
    const created = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'Retainer', quantity: 1, unitPrice: 200_000, accountId: income }],
      status: 'sent',
    });
    const invoiceId = created.json().id;
    await authed(ctx, session, 'POST', '/payments', {
      direction: 'receipt',
      contactId: customerId,
      date: today(),
      amount: 50_000,
      applications: [{ invoiceId, amount: 50_000 }],
    });
    const detail = await authed(ctx, session, 'GET', `/invoices/${invoiceId}`);
    expect(detail.json().invoice.status).toBe('partial');
    expect(detail.json().invoice.balance).toBe(150_000);
  });

  it('rejects over-application of a payment', async () => {
    const customerId = await createCustomer(ctx, session, 'Meridian');
    const income = await accountId(ctx, session, '4100');
    const created = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'Work', quantity: 1, unitPrice: 10_000, accountId: income }],
      status: 'sent',
    });
    const res = await authed(ctx, session, 'POST', '/payments', {
      direction: 'receipt',
      amount: 20_000,
      date: today(),
      applications: [{ invoiceId: created.json().id, amount: 20_000 }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('applies a credit memo against receivables', async () => {
    const customerId = await createCustomer(ctx, session, 'Credit Customer');
    const income = await accountId(ctx, session, '4100');
    const memo = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      kind: 'credit_memo',
      issueDate: today(),
      lines: [{ description: 'Goodwill credit', quantity: 1, unitPrice: 5_000, accountId: income }],
    });
    expect(memo.statusCode).toBe(201);
    const detail = await authed(ctx, session, 'GET', `/invoices/${memo.json().id}`);
    expect(detail.json().invoice.journal_entry_id).toBeTruthy();

    // Credit memos reduce revenue (debit income, credit A/R)
    const incomeBalance = await ctx.db.get<{ v: number }>(
      `SELECT SUM(jl.credit - jl.debit) AS v FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
       WHERE je.status = 'posted' AND a.code = '4100'`,
    );
    // At this point: 100k consulting + 200k retainer + 10k work - 5k credit memo
    expect(Number(incomeBalance?.v)).toBe(305_000);
  });

  it('converts an estimate into an invoice', async () => {
    const customerId = await createCustomer(ctx, session, 'Estimate Customer');
    const income = await accountId(ctx, session, '4100');
    const estimate = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      kind: 'estimate',
      issueDate: today(),
      lines: [{ description: 'Phase 2', quantity: 1, unitPrice: 300_000, accountId: income }],
    });
    const converted = await authed(ctx, session, 'POST', `/invoices/${estimate.json().id}/convert`);
    expect(converted.statusCode).toBe(201);
    const detail = await authed(ctx, session, 'GET', `/invoices/${converted.json().id}`);
    expect(detail.json().invoice.kind).toBe('invoice');
    expect(detail.json().invoice.total).toBe(300_000);
  });

  it('voids an invoice and reverses its ledger impact', async () => {
    const customerId = await createCustomer(ctx, session, 'Void Customer');
    const income = await accountId(ctx, session, '4100');
    const created = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'Mistake', quantity: 1, unitPrice: 42_000, accountId: income }],
      status: 'sent',
    });
    const voided = await authed(ctx, session, 'POST', `/invoices/${created.json().id}/void`);
    expect(voided.statusCode).toBe(200);
    const detail = await authed(ctx, session, 'GET', `/invoices/${created.json().id}`);
    expect(detail.json().invoice.status).toBe('void');
    const entry = await ctx.db.get<{ status: string }>('SELECT status FROM journal_entries WHERE id = ?', [detail.json().invoice.journal_entry_id]);
    expect(entry?.status).toBe('void');
  });

  it('rejects an invoice that breaches the customer credit limit', async () => {
    const created = await authed(ctx, session, 'POST', '/contacts', {
      name: 'Tight Credit Ltd',
      kind: 'customer',
      creditLimit: 1_000,
    });
    const income = await accountId(ctx, session, '4100');
    const res = await authed(ctx, session, 'POST', '/invoices', {
      contactId: created.json().id,
      issueDate: today(),
      lines: [{ description: 'Too big', quantity: 1, unitPrice: 5_000, accountId: income }],
      status: 'sent',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.code).toBe('credit_limit_exceeded');
  });

  it('keeps the trial balance and reports consistent', async () => {
    const totals = await journalTotals(ctx, session.tenantId);
    expect(totals.debit).toBe(totals.credit);

    const pnl = await authed(ctx, session, 'GET', '/reports/profit-and-loss');
    expect(pnl.statusCode).toBe(200);
    const body = pnl.json();
    expect(body.totals.income).toBe(605_000);
    expect(body.totals.netIncome).toBe(body.totals.income - body.totals.cogs - body.totals.operatingExpenses);

    const sheet = await authed(ctx, session, 'GET', '/reports/balance-sheet');
    expect(sheet.json().totals.difference).toBe(0);

    const tb = await authed(ctx, session, 'GET', '/reports/trial-balance');
    expect(tb.json().totals.debit).toBe(tb.json().totals.credit);

    const csv = await authed(ctx, session, 'GET', '/reports/profit-and-loss?format=csv');
    expect(csv.json().content).toContain('Net Income');
  });

  it('generates a PDF invoice', async () => {
    const customerId = await createCustomer(ctx, session, 'PDF Customer');
    const income = await accountId(ctx, session, '4100');
    const created = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'PDF work', quantity: 1, unitPrice: 12_000, accountId: income }],
      status: 'sent',
    });
    const pdf = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${created.json().id}/pdf`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
