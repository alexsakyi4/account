import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, authed, createTestApp, createVendor, journalTotals, registerCompany, today, type Session, type TestContext } from '../helpers.js';

let ctx: TestContext;
let session: Session;

beforeAll(async () => {
  ctx = await createTestApp();
  session = await registerCompany(ctx, 'Purchases Test Co');
});
afterAll(async () => {
  await ctx.close();
});

describe('bill to payment workflow', () => {
  it('enters, posts and pays a vendor bill', async () => {
    const vendorId = await createVendor(ctx, session, 'CloudHost Inc');
    const software = await accountId(ctx, session, '6500');
    const created = await authed(ctx, session, 'POST', '/bills', {
      vendorId,
      number: 'CH-1001',
      issueDate: today(),
      lines: [{ description: 'Hosting', quantity: 1, unitPrice: 29_900, accountId: software }],
      status: 'open',
    });
    expect(created.statusCode).toBe(201);
    const detail = await authed(ctx, session, 'GET', `/bills/${created.json().id}`);
    expect(detail.json().bill.total).toBe(29_900);
    expect(detail.json().bill.journal_entry_id).toBeTruthy();

    const ap = await ctx.db.get<{ v: number }>(
      `SELECT SUM(jl.credit - jl.debit) AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id WHERE je.status = 'posted' AND a.system_key = 'accounts_payable'`,
    );
    expect(Number(ap?.v)).toBe(29_900);

    const checking = await accountId(ctx, session, '1010');
    const payment = await authed(ctx, session, 'POST', '/payments', {
      direction: 'disbursement',
      contactId: vendorId,
      date: today(),
      amount: 29_900,
      method: 'ach',
      depositAccountId: checking,
      applications: [{ billId: created.json().id, amount: 29_900 }],
    });
    expect(payment.statusCode).toBe(201);

    const after = await authed(ctx, session, 'GET', `/bills/${created.json().id}`);
    expect(after.json().bill.status).toBe('paid');
    expect(after.json().bill.balance).toBe(0);

    const apAfter = await ctx.db.get<{ v: number }>(
      `SELECT SUM(jl.credit - jl.debit) AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id WHERE je.status = 'posted' AND a.system_key = 'accounts_payable'`,
    );
    expect(Number(apAfter?.v)).toBe(0);

    const totals = await journalTotals(ctx, session.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it('schedules and runs a batch bill payment', async () => {
    const vendorId = await createVendor(ctx, session, 'Power Co');
    const utilities = await accountId(ctx, session, '6300');
    const bill = await authed(ctx, session, 'POST', '/bills', {
      vendorId,
      issueDate: today(),
      lines: [{ description: 'Electricity', quantity: 1, unitPrice: 18_500, accountId: utilities }],
      status: 'open',
    });
    await authed(ctx, session, 'PATCH', `/bills/${bill.json().id}`, { scheduledPaymentDate: today() });
    const checking = await accountId(ctx, session, '1010');
    const run = await authed(ctx, session, 'POST', '/bills/pay-scheduled', { through: today(), depositAccountId: checking });
    expect(run.statusCode).toBe(200);
    expect(run.json().paid).toBe(1);
    const after = await authed(ctx, session, 'GET', `/bills/${bill.json().id}`);
    expect(after.json().bill.status).toBe('paid');
  });

  it('records an expense, applies tax and posts it to the ledger', async () => {
    const travel = await accountId(ctx, session, '6700');
    const vat = await (async () => {
      const res = await authed(ctx, session, 'GET', '/tax-codes');
      return res.json().data.find((t: { code: string }) => t.code === 'VAT15').id as string;
    })();
    const created = await authed(ctx, session, 'POST', '/expenses', {
      date: today(),
      memo: 'Client visit',
      lines: [{ accountId: travel, description: 'Flights', amount: 40_000, taxCodeId: vat }],
    });
    expect(created.statusCode).toBe(201);
    const approve = await authed(ctx, session, 'POST', `/expenses/${created.json().id}/approve`);
    expect(approve.statusCode).toBe(200);
    const expense = await ctx.db.get<{ status: string; total: number; journal_entry_id: string | null }>(
      'SELECT status, total, journal_entry_id FROM expenses WHERE id = ?',
      [created.json().id],
    );
    expect(expense?.status).toBe('posted');
    expect(expense?.total).toBe(46_000);
    expect(expense?.journal_entry_id).toBeTruthy();
  });

  it('produces A/P aging buckets', async () => {
    const aging = await authed(ctx, session, 'GET', '/reports/ap-aging');
    expect(aging.statusCode).toBe(200);
    const body = aging.json();
    // Only the utilities + cloud hosting bills remain; both are paid, so aging is empty.
    expect(body.totals.total).toBe(0);
  });
});
