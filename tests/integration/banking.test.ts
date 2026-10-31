import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountId, authed, createCustomer, createTestApp, registerCompany, today, type Session, type TestContext } from '../helpers.js';

let ctx: TestContext;
let session: Session;
let bankAccountId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  session = await registerCompany(ctx, 'Banking Test Co');
  const existing = await authed(ctx, session, 'GET', '/banking/accounts');
  bankAccountId = existing.json().data[0].id;
});
afterAll(async () => {
  await ctx.close();
});

describe('bank feed import and reconciliation', () => {
  it('imports a CSV statement and detects the columns', async () => {
    const csv = [
      'Date,Description,Amount',
      `${today()},CUSTOMER WIRE IN,5000.00`,
      `${today()},MONTHLY ACCOUNT FEE,-2.00`,
    ].join('\n');
    const res = await authed(ctx, session, 'POST', `/banking/accounts/${bankAccountId}/import`, { csv });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.imported).toBe(2);
    expect(body.detectedMapping.date).toBe('Date');
    expect(body.detectedMapping.amount).toBe('Amount');
  });

  it('does not duplicate transactions on re-import', async () => {
    const csv = `Date,Description,Amount\n${today()},CUSTOMER WIRE IN,5000.00`;
    const res = await authed(ctx, session, 'POST', `/banking/accounts/${bankAccountId}/import`, { csv });
    expect(res.json().imported).toBe(0);
  });

  it('auto-matches a deposit to a recorded customer payment', async () => {
    const customerId = await createCustomer(ctx, session, 'Wire Customer');
    const income = await accountId(ctx, session, '4100');
    const invoice = await authed(ctx, session, 'POST', '/invoices', {
      contactId: customerId,
      issueDate: today(),
      lines: [{ description: 'Project', quantity: 1, unitPrice: 500_000, accountId: income }],
      status: 'sent',
    });
    // Receipt recorded before the money lands in the bank → Undeposited Funds.
    await authed(ctx, session, 'POST', '/payments', {
      direction: 'receipt',
      contactId: customerId,
      date: today(),
      amount: 500_000,
      method: 'bank_transfer',
      applications: [{ invoiceId: invoice.json().id, amount: 500_000 }],
    });
    const match = await authed(ctx, session, 'POST', '/banking/auto-match', { bankAccountId });
    expect(match.statusCode).toBe(200);
    expect(match.json().matched).toBeGreaterThanOrEqual(1);

    const txn = await ctx.db.get<{ status: string; match_type: string; journal_entry_id: string | null }>(
      "SELECT status, match_type, journal_entry_id FROM bank_transactions WHERE bank_account_id = ? AND description = 'CUSTOMER WIRE IN'",
      [bankAccountId],
    );
    expect(txn?.status).toBe('matched');
    expect(txn?.match_type).toBe('payment');
  });

  it('categorises transactions with a rule', async () => {
    const fees = await accountId(ctx, session, '6600');
    const rule = await authed(ctx, session, 'POST', '/banking/rules', {
      name: 'Bank fees',
      matchField: 'description',
      matchOp: 'contains',
      matchValue: 'FEE',
      targetType: 'journal',
      targetAccountId: fees,
      autoApply: true,
    });
    expect(rule.statusCode).toBe(201);
    await authed(ctx, session, 'POST', '/banking/auto-match', { bankAccountId });
    const txn = await ctx.db.get<{ status: string; journal_entry_id: string | null }>(
      "SELECT status, journal_entry_id FROM bank_transactions WHERE bank_account_id = ? AND description = 'MONTHLY ACCOUNT FEE'",
      [bankAccountId],
    );
    expect(txn?.status).toBe('matched');
    expect(txn?.journal_entry_id).toBeTruthy();
  });

  it('completes a reconciliation only when the difference is zero', async () => {
    const created = await authed(ctx, session, 'POST', '/banking/reconciliations', {
      bankAccountId,
      endDate: today(),
      statementEndingBalance: 499_800, // 5000.00 - 2.00
    });
    expect(created.statusCode).toBe(201);
    const reconId = created.json().id;

    const tooEarly = await authed(ctx, session, 'POST', `/banking/reconciliations/${reconId}/complete`);
    expect(tooEarly.statusCode).toBe(422);

    const cleared = await authed(ctx, session, 'POST', `/banking/reconciliations/${reconId}/clear`, { clearAllMatched: true });
    expect(cleared.json().difference).toBe(0);

    const complete = await authed(ctx, session, 'POST', `/banking/reconciliations/${reconId}/complete`);
    expect(complete.statusCode).toBe(200);

    const recon = await ctx.db.get<{ status: string }>('SELECT status FROM reconciliations WHERE id = ?', [reconId]);
    expect(recon?.status).toBe('completed');
  });

  it('reports bank balances from the general ledger', async () => {
    const res = await authed(ctx, session, 'GET', '/banking/accounts');
    const account = res.json().data.find((a: { id: string }) => a.id === bankAccountId);
    expect(account.name).toBe('Business Checking');
    // Deposit matched → bank, fee categorised → bank. Net 499,800.
    expect(account.balance).toBe(499_800);
  });

  it('bulk excludes and restores transactions', async () => {
    const csv = `Date,Description,Amount\n${today()},UNKNOWN TRANSFER,-100.00`;
    const imported = await authed(ctx, session, 'POST', `/banking/accounts/${bankAccountId}/import`, { csv });
    expect(imported.json().imported).toBe(1);
    const txn = await ctx.db.get<{ id: string }>("SELECT id FROM bank_transactions WHERE description = 'UNKNOWN TRANSFER'");
    const bulk = await authed(ctx, session, 'POST', '/banking/transactions/bulk', { ids: [txn!.id], action: 'exclude' });
    expect(bulk.json().affected).toBe(1);
    const after = await ctx.db.get<{ status: string }>('SELECT status FROM bank_transactions WHERE id = ?', [txn!.id]);
    expect(after?.status).toBe('excluded');
  });
});
