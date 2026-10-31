import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, authed, createCustomer, createTestApp, registerCompany, today, type Session, type TestContext } from '../helpers.js';
import { totpCode } from '../../server/src/lib/crypto.js';

let ctx: TestContext;
let admin: Session;

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await registerCompany(ctx, 'Security Test Co');
});
afterAll(async () => {
  await ctx.close();
});

describe('authentication and authorisation', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/invoices' });
    expect(res.statusCode).toBe(401);
  });

  it('enforces role-based access control', async () => {
    const bookkeeper = await addMember(ctx, admin, 'bookkeeper');
    const employee = await addMember(ctx, admin, 'employee');

    // Bookkeepers can invoice…
    const customerId = await createCustomer(ctx, admin, 'RBAC Customer');
    const accounts = await authed(ctx, admin, 'GET', '/accounts');
    const income = accounts.json().data.find((a: { code: string }) => a.code === '4100').id;
    const invoice = await authed(ctx, bookkeeper, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'Work', quantity: 1, unitPrice: 1000, accountId: income }],
      status: 'draft',
    });
    expect(invoice.statusCode).toBe(201);

    // …but not change company settings or read the audit log.
    const settings = await authed(ctx, bookkeeper, 'PATCH', '/company', { name: 'Hacked Ltd' });
    expect(settings.statusCode).toBe(403);
    const audit = await authed(ctx, bookkeeper, 'GET', '/activity');
    expect(audit.statusCode).toBe(403);

    // Employees can submit expenses but cannot invoice.
    const employeeInvoice = await authed(ctx, employee, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'x', quantity: 1, unitPrice: 100, accountId: income }],
    });
    expect(employeeInvoice.statusCode).toBe(403);
    const travel = accounts.json().data.find((a: { code: string }) => a.code === '6700').id;
    const expense = await authed(ctx, employee, 'POST', '/expenses', {
      date: today(),
      lines: [{ accountId: travel, amount: 2_000 }],
    });
    expect(expense.statusCode).toBe(201);
  });

  it('isolates tenants from each other', async () => {
    const other = await registerCompany(ctx, 'Other Tenant Ltd');
    const customerId = await createCustomer(ctx, admin, 'Isolation Customer');
    const accounts = await authed(ctx, admin, 'GET', '/accounts');
    const income = accounts.json().data.find((a: { code: string }) => a.code === '4100').id;
    const invoice = await authed(ctx, admin, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'Private', quantity: 1, unitPrice: 500, accountId: income }],
      status: 'sent',
    });
    const stolen = await authed(ctx, other, 'GET', `/invoices/${invoice.json().id}`);
    expect(stolen.statusCode).toBe(404);
    const list = await authed(ctx, other, 'GET', '/invoices');
    expect(list.json().data.length).toBe(0);
  });

  it('maintains a tamper-evident audit trail', async () => {
    const verify = await authed(ctx, admin, 'GET', '/audit/verify');
    expect(verify.json().valid).toBe(true);
    expect(verify.json().entries).toBeGreaterThanOrEqual(3);

    const activity = await authed(ctx, admin, 'GET', '/activity?pageSize=50');
    const actions = activity.json().data.map((r: { action: string }) => r.action);
    expect(actions).toContain('invoice.created');
    expect(actions).toContain('company.created');

    // Tampering with a row breaks the chain.
    await ctx.db.run("UPDATE audit_logs SET summary = 'tampered' WHERE tenant_id = ? AND seq = 2", [admin.tenantId]);
    const broken = await authed(ctx, admin, 'GET', '/audit/verify');
    expect(broken.json().valid).toBe(false);
  });

  it('supports TOTP two-factor enrolment and login', async () => {
    const setup = await authed(ctx, admin, 'POST', '/auth/2fa/setup');
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().secret;
    const enable = await authed(ctx, admin, 'POST', '/auth/2fa/enable', { code: totpCode(secret) });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().recoveryCodes.length).toBe(8);

    const meEmail = (await authed(ctx, admin, 'GET', '/auth/me')).json().user.email;
    const firstStep = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: meEmail, password: 'CorrectHorse123!' },
    });
    expect(firstStep.json().twoFactorRequired).toBe(true);

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: { challengeToken: firstStep.json().challengeToken, code: '000000' },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/2fa/verify',
      payload: { challengeToken: firstStep.json().challengeToken, code: totpCode(secret) },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().accessToken).toBeTruthy();
  });

  it('validates journal entries and requires balance', async () => {
    const accounts = await authed(ctx, admin, 'GET', '/accounts');
    const checking = accounts.json().data.find((a: { code: string }) => a.code === '1010').id;
    const income = accounts.json().data.find((a: { code: string }) => a.code === '4100').id;

    const unbalanced = await authed(ctx, admin, 'POST', '/journal-entries', {
      date: today(),
      memo: 'Bad entry',
      lines: [
        { accountId: checking, debit: 100, credit: 0 },
        { accountId: income, debit: 0, credit: 99 },
      ],
    });
    expect(unbalanced.statusCode).toBe(422);

    const balanced = await authed(ctx, admin, 'POST', '/journal-entries', {
      date: today(),
      memo: 'Owner contribution',
      lines: [
        { accountId: checking, debit: 1_000_000, credit: 0 },
        { accountId: accounts.json().data.find((a: { code: string }) => a.code === '3000').id, debit: 0, credit: 1_000_000 },
      ],
    });
    expect(balanced.statusCode).toBe(201);

    const reverse = await authed(ctx, admin, 'POST', `/journal-entries/${balanced.json().id}/reverse`);
    expect(reverse.statusCode).toBe(200);
    const original = await ctx.db.get<{ status: string }>('SELECT status FROM journal_entries WHERE id = ?', [balanced.json().id]);
    expect(original?.status).toBe('reversed');
  });

  it('blocks posting into a closed period', async () => {
    const periods = await authed(ctx, admin, 'GET', '/periods');
    const current = periods.json().data.find((p: { start_date: string; end_date: string }) => p.start_date <= today() && p.end_date >= today());
    await authed(ctx, admin, 'POST', `/periods/${current.id}/publish`, { status: 'closed' });
    const accounts = await authed(ctx, admin, 'GET', '/accounts');
    const checking = accounts.json().data.find((a: { code: string }) => a.code === '1010').id;
    const res = await authed(ctx, admin, 'POST', '/journal-entries', {
      date: today(),
      memo: 'After close',
      lines: [
        { accountId: checking, debit: 100, credit: 0 },
        { accountId: accounts.json().data.find((a: { code: string }) => a.code === '4100').id, debit: 0, credit: 100 },
      ],
    });
    expect(res.statusCode).toBe(422);
    await authed(ctx, admin, 'POST', `/periods/${current.id}/publish`, { status: 'open' });
  });

  it('refreshes tokens with rotation', async () => {
    const refreshed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: admin.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: admin.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });
});
