import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, authed, createCustomer, createTestApp, createVendor, journalTotals, registerCompany, today, type Session, type TestContext } from '../helpers.js';

let ctx: TestContext;
let session: Session;

beforeAll(async () => {
  ctx = await createTestApp();
  session = await registerCompany(ctx, 'Modules Test Co');
  await authed(ctx, session, 'PATCH', '/flags/payroll', { enabled: true });
});
afterAll(async () => {
  await ctx.close();
});

describe('inventory module', () => {
  it('tracks stock, COGS and valuation', async () => {
    const income = await accountId(ctx, session, '4000');
    const item = await authed(ctx, session, 'POST', '/items', {
      sku: 'WIDGET-1',
      name: 'Widget',
      itemType: 'inventory',
      salesPrice: 12_000,
      purchaseCost: 7_500,
      incomeAccountId: income,
      quantityOnHand: 0,
    });
    expect(item.statusCode).toBe(201);

    const vendorId = await createVendor(ctx, session, 'Stock Vendor');
    const bill = await authed(ctx, session, 'POST', '/bills', {
      vendorId,
      number: 'STOCK-1',
      issueDate: today(),
      status: 'open',
      lines: [{ description: 'Widget purchase', quantity: 10, unitPrice: 7_500, itemId: item.json().id }],
    });
    expect(bill.statusCode).toBe(201);

    let stock = await ctx.db.get<{ quantity_on_hand: number; purchase_cost: number }>('SELECT quantity_on_hand, purchase_cost FROM items WHERE id = ?', [item.json().id]);
    expect(stock?.quantity_on_hand).toBe(10);
    expect(stock?.purchase_cost).toBe(7_500);

    const customerId = await createCustomer(ctx, session, 'Stock Customer');
    await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      status: 'sent',
      lines: [{ description: 'Widget sale', quantity: 3, unitPrice: 12_000, accountId: income, itemId: item.json().id }],
    });

    const afterSale = await ctx.db.get<{ quantity_on_hand: number }>('SELECT quantity_on_hand FROM items WHERE id = ?', [item.json().id]);
    expect(afterSale?.quantity_on_hand).toBe(7);

    const cogs = await ctx.db.get<{ v: number }>(
      `SELECT SUM(jl.debit - jl.credit) AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id WHERE je.status = 'posted' AND a.system_key = 'cogs'`,
    );
    expect(Number(cogs?.v)).toBe(22_500); // 3 units at 75.00

    const adjustment = await authed(ctx, session, 'POST', `/items/${item.json().id}/adjust`, {
      date: today(),
      quantity: -1,
      reason: 'Damaged',
    });
    expect(adjustment.statusCode).toBe(201);
    expect(adjustment.json().quantityOnHand).toBe(6);
    const totals = await journalTotals(ctx, session.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it('refuses negative stock', async () => {
    const items = await authed(ctx, session, 'GET', '/items');
    const itemId = items.json().data[0].id;
    const res = await authed(ctx, session, 'POST', `/items/${itemId}/adjust`, { date: today(), quantity: -999 });
    expect(res.statusCode).toBe(422);
  });
});

describe('payroll module', () => {
  it('runs payroll with progressive taxes and posts a balanced entry', async () => {
    const employee = await authed(ctx, session, 'POST', '/employees', {
      name: 'Ama Owusu',
      email: 'ama@example.com',
      payType: 'salary',
      payRate: 6_000_000,
      payFrequency: 'monthly',
    });
    expect(employee.statusCode).toBe(201);

    const run = await authed(ctx, session, 'POST', '/payroll/runs', {
      periodStart: `${today().slice(0, 7)}-01`,
      periodEnd: today(),
      payDate: today(),
    });
    expect(run.statusCode).toBe(201);
    const body = run.json();
    expect(body.gross).toBe(500_000);
    expect(body.net).toBeLessThan(body.gross);

    const approve = await authed(ctx, session, 'POST', `/payroll/runs/${body.id}/approve`);
    expect(approve.statusCode).toBe(200);
    const totals = await journalTotals(ctx, session.tenantId);
    expect(totals.debit).toBe(totals.credit);

    const pay = await authed(ctx, session, 'POST', `/payroll/runs/${body.id}/pay`, {});
    expect(pay.statusCode).toBe(200);
  });

  it('tracks timesheets and approves them', async () => {
    const employees = await authed(ctx, session, 'GET', '/employees');
    const employeeId = employees.json().data[0].id;
    const created = await authed(ctx, session, 'POST', '/timesheets', {
      employeeId,
      entries: [{ workDate: today(), hours: 8, project: 'Client A', billable: true }],
    });
    expect(created.statusCode).toBe(201);
    const list = await authed(ctx, session, 'GET', '/timesheets');
    const id = list.json().data[0].id;
    const approve = await authed(ctx, session, 'POST', '/timesheets/approve', { ids: [id], status: 'approved' });
    expect(approve.json().updated).toBe(1);
  });
});

describe('settings and tax', () => {
  it('updates company details and feature flags', async () => {
    const updated = await authed(ctx, session, 'PATCH', '/company', {
      name: 'Modules Test Co (renamed)',
      settings: { invoicePrefix: 'BILL', reminderDays: [5, 10] },
    });
    expect(updated.statusCode).toBe(200);
    const company = await authed(ctx, session, 'GET', '/company');
    expect(company.json().company.name).toBe('Modules Test Co (renamed)');
    expect(company.json().company.settings.invoicePrefix).toBe('BILL');
    expect(company.json().flags.payroll).toBe(true);
  });

  it('creates tax codes and converts currencies', async () => {
    const tax = await authed(ctx, session, 'POST', '/tax-codes', { code: 'VAT75', name: 'VAT 7.5%', rateBp: 750, taxType: 'vat' });
    expect(tax.statusCode).toBe(201);
    const duplicate = await authed(ctx, session, 'POST', '/tax-codes', { code: 'VAT75', name: 'dup', rateBp: 750 });
    expect(duplicate.statusCode).toBe(409);

    await authed(ctx, session, 'POST', '/currencies/rates', { quoteCurrency: 'EUR', rate: 1.1, rateDate: today() });
    const conversion = await authed(ctx, session, 'GET', '/currencies/convert?amount=100&from=EUR&to=USD');
    expect(conversion.statusCode).toBe(200);
    expect(conversion.json().rate).toBeCloseTo(1.1, 5);
  });

  it('exposes onboarding progress and can complete steps', async () => {
    const before = await authed(ctx, session, 'GET', '/onboarding');
    const completedBefore = before.json().completed;
    await authed(ctx, session, 'POST', '/onboarding/accounts');
    const after = await authed(ctx, session, 'GET', '/onboarding');
    expect(after.json().completed).toBeGreaterThan(completedBefore);
  });

  it('returns a security overview with 2FA posture', async () => {
    const res = await authed(ctx, session, 'GET', '/security/overview');
    expect(res.statusCode).toBe(200);
    expect(res.json().twoFactor.admins).toBeGreaterThanOrEqual(1);
    expect(res.json().encryptionAtRest).toContain('AES-256');
  });

  it('manages API keys and webhooks', async () => {
    const key = await authed(ctx, session, 'POST', '/api-keys', { name: 'Zapier', role: 'bookkeeper' });
    expect(key.statusCode).toBe(201);
    expect(key.json().key.startsWith('ll_')).toBe(true);

    // The key authenticates as the bookkeeper role.
    const viaKey = await ctx.app.inject({ method: 'GET', url: '/api/v1/invoices', headers: { 'x-api-key': key.json().key } });
    expect(viaKey.statusCode).toBe(200);

    const hook = await authed(ctx, session, 'POST', '/webhooks', { url: 'https://example.com/hooks', events: ['invoice.paid'] });
    expect(hook.statusCode).toBe(201);
    expect(hook.json().secret.startsWith('whsec_')).toBe(true);
    const list = await authed(ctx, session, 'GET', '/webhooks');
    expect(list.json().data.length).toBe(1);

    await authed(ctx, session, 'DELETE', `/api-keys/${key.json().id}`);
    const afterRevoke = await ctx.app.inject({ method: 'GET', url: '/api/v1/invoices', headers: { 'x-api-key': key.json().key } });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('supports GDPR data export and erasure requests', async () => {
    const exported = await authed(ctx, session, 'POST', '/gdpr/export');
    expect(exported.statusCode).toBe(200);
    expect(exported.json().user.email).toBeTruthy();
    const requests = await authed(ctx, session, 'GET', '/gdpr/requests');
    expect(requests.json().data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('reporting', () => {
  it('serves every report type', async () => {
    for (const type of ['profit-and-loss', 'balance-sheet', 'cash-flow', 'trial-balance', 'ar-aging', 'ap-aging', 'sales-by-customer', 'purchases-by-vendor', 'tax-summary']) {
      const res = await authed(ctx, session, 'GET', `/reports/${type}?from=2020-01-01&to=${today()}`);
      expect(res.statusCode, `${type}: ${res.body.slice(0, 200)}`).toBe(200);
      expect(res.json().title).toBeTruthy();
    }
  });

  it('exports PDF and CSV', async () => {
    const pdf = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/reports/profit-and-loss?format=pdf',
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const csv = await authed(ctx, session, 'GET', '/reports/trial-balance?format=csv');
    expect(csv.json().content).toContain('TOTAL');
  });

  it('schedules recurring reports', async () => {
    const created = await authed(ctx, session, 'POST', '/reports/schedules', {
      reportType: 'profit-and-loss',
      name: 'Monthly P&L',
      frequency: 'monthly',
      recipients: 'owner@example.com',
    });
    expect(created.statusCode).toBe(201);
    const list = await authed(ctx, session, 'GET', '/reports/schedules/list');
    expect(list.json().data.length).toBe(1);
    await authed(ctx, session, 'DELETE', `/reports/schedules/${created.json().id}`);
  });
});
