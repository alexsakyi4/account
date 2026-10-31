/**
 * The journal — single source of truth for every financial number in the app.
 *
 * Every business document (invoice, bill, payment, expense, payroll run, bank
 * transaction, manual entry) posts a balanced journal entry. Reports only ever
 * read `journal_lines`, which guarantees P&L, balance sheet and aging reports
 * agree with each other by construction.
 */
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { badRequest, notFound, unprocessable } from '../lib/errors.js';

export type SourceType =
  | 'manual'
  | 'invoice'
  | 'credit_memo'
  | 'bill'
  | 'payment'
  | 'bill_payment'
  | 'expense'
  | 'payroll'
  | 'bank'
  | 'opening'
  | 'adjusting'
  | 'reversal'
  | 'inventory';

export interface JournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string;
  contactId?: string | null;
  taxCodeId?: string | null;
  amountCcy?: number;
}

export interface PostJournalInput {
  tenantId: string;
  date: string;
  memo?: string;
  sourceType: SourceType;
  sourceId?: string | null;
  currency: string;
  fxRate?: number;
  lines: JournalLineInput[];
  createdBy?: string | null;
  entryId?: string;
}

export interface AccountRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  parent_id: string | null;
  is_system: number;
  system_key: string | null;
  is_active: number;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export async function nextCounter(db: DB, tenantId: string, name: string): Promise<number> {
  const row = await db.get<{ value: number }>(
    `INSERT INTO counters (tenant_id, name, value) VALUES (?, ?, 1)
     ON CONFLICT (tenant_id, name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [tenantId, name],
  );
  return Number(row?.value ?? 1);
}

export async function nextDocumentNumber(
  db: DB,
  tenantId: string,
  name: string,
  prefix: string,
  pad = 4,
): Promise<string> {
  const value = await nextCounter(db, tenantId, name);
  return `${prefix}-${String(value).padStart(pad, '0')}`;
}

export async function getAccount(db: DB, tenantId: string, id: string): Promise<AccountRow> {
  const account = await db.get<AccountRow>('SELECT * FROM accounts WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!account) throw notFound('Account not found');
  return account;
}

export async function systemAccount(db: DB, tenantId: string, key: string): Promise<AccountRow> {
  const account = await db.get<AccountRow>(
    'SELECT * FROM accounts WHERE tenant_id = ? AND system_key = ? AND is_active = 1 ORDER BY code LIMIT 1',
    [tenantId, key],
  );
  if (!account) throw unprocessable(`This company is missing the "${key}" account. Add it in the chart of accounts.`);
  return account;
}

/** Accounts with children are grouping accounts and cannot receive postings. */
export async function isPostable(db: DB, tenantId: string, accountId: string): Promise<boolean> {
  const child = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE tenant_id = ? AND parent_id = ?', [
    tenantId,
    accountId,
  ]);
  return Number(child?.n ?? 0) === 0;
}

export async function assertPeriodOpen(db: DB, tenantId: string, date: string): Promise<void> {
  if (!isoDate.test(date)) throw badRequest('Dates must use YYYY-MM-DD');
  const period = await db.get<{ status: string; name: string }>(
    `SELECT status, name FROM fiscal_periods
     WHERE tenant_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date DESC LIMIT 1`,
    [tenantId, date, date],
  );
  if (period && period.status !== 'open') {
    throw unprocessable(`Accounting period "${period.name}" is ${period.status}. Reopen it before posting.`);
  }
}

export async function postJournal(db: DB, input: PostJournalInput): Promise<string> {
  const { tenantId, date, currency, lines } = input;
  if (lines.length < 2) throw badRequest('A journal entry needs at least two lines');
  if (!isoDate.test(date)) throw badRequest('Dates must use YYYY-MM-DD');

  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of lines) {
    const debit = Math.round(line.debit ?? 0);
    const credit = Math.round(line.credit ?? 0);
    if (debit < 0 || credit < 0) throw badRequest('Debits and credits cannot be negative');
    if (debit > 0 && credit > 0) throw badRequest('A journal line cannot have both a debit and a credit');
    if (debit === 0 && credit === 0) throw badRequest('A journal line must have a debit or a credit');
    debitTotal += debit;
    creditTotal += credit;
  }
  if (debitTotal !== creditTotal) {
    throw unprocessable(
      `Journal entry is out of balance: debits ${debitTotal} vs credits ${creditTotal}. ` +
        'Amounts are in minor units (cents).',
    );
  }

  await assertPeriodOpen(db, tenantId, date);

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const placeholders = accountIds.map(() => '?').join(',');
  const accounts = await db.all<AccountRow>(
    `SELECT * FROM accounts WHERE tenant_id = ? AND id IN (${placeholders})`,
    [tenantId, ...accountIds],
  );
  if (accounts.length !== accountIds.length) throw unprocessable('One or more accounts do not exist');
  const inactive = accounts.find((a) => Number(a.is_active) !== 1);
  if (inactive) throw unprocessable(`Account ${inactive.code} ${inactive.name} is inactive`);

  const childRows = await db.all<{ parent_id: string }>(
    `SELECT DISTINCT parent_id FROM accounts WHERE tenant_id = ? AND parent_id IN (${placeholders})`,
    [tenantId, ...accountIds],
  );
  if (childRows.length > 0) {
    const blocked = accounts.find((a) => childRows.some((c) => c.parent_id === a.id));
    throw unprocessable(`Account ${blocked?.code} ${blocked?.name} is a parent account. Post to a sub-account instead.`);
  }

  const entryId = input.entryId ?? newId();
  const entryNo = await nextCounter(db, tenantId, 'journal_entry');
  const now = new Date().toISOString();
  const fxRate = input.fxRate && input.fxRate > 0 ? input.fxRate : 1;

  await db.run(
    `INSERT INTO journal_entries (id, tenant_id, entry_no, date, memo, source_type, source_id, status, currency, fx_rate, created_by, posted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?)`,
    [
      entryId,
      tenantId,
      entryNo,
      date,
      input.memo ?? null,
      input.sourceType,
      input.sourceId ?? null,
      currency,
      fxRate,
      input.createdBy ?? null,
      now,
      now,
    ],
  );

  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    const debit = Math.round(line.debit ?? 0);
    const credit = Math.round(line.credit ?? 0);
    const base = debit > 0 ? debit : credit;
    const ccyAmount = line.amountCcy ?? Math.round(base / fxRate);
    await db.run(
      `INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_id, description, debit, credit, contact_id, tax_code_id, currency, amount_ccy, fx_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        tenantId,
        entryId,
        lineNo,
        line.accountId,
        line.description ?? input.memo ?? null,
        debit,
        credit,
        line.contactId ?? null,
        line.taxCodeId ?? null,
        currency,
        ccyAmount,
        fxRate,
      ],
    );
  }
  return entryId;
}

/** Creates a mirrored entry and removes the original from all reports. */
export async function reverseJournal(
  db: DB,
  tenantId: string,
  entryId: string,
  actorId: string | null,
  memo?: string,
): Promise<string> {
  const entry = await db.get<{ id: string; date: string; memo: string; currency: string; fx_rate: number; status: string; source_type: string }>(
    'SELECT * FROM journal_entries WHERE tenant_id = ? AND id = ?',
    [tenantId, entryId],
  );
  if (!entry) throw notFound('Journal entry not found');
  if (entry.status !== 'posted') throw unprocessable('Only posted entries can be reversed');
  const lines = await db.all<{ account_id: string; debit: number; credit: number; description: string | null; contact_id: string | null; tax_code_id: string | null; amount_ccy: number }>(
    'SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no',
    [entryId],
  );
  const today = new Date().toISOString().slice(0, 10);
  const reversalId = await postJournal(db, {
    tenantId,
    date: today,
    memo: memo ?? `Reversal of entry for ${entry.date}`,
    sourceType: 'reversal',
    sourceId: entryId,
    currency: entry.currency,
    fxRate: entry.fx_rate,
    createdBy: actorId,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: l.credit,
      credit: l.debit,
      description: l.description ?? undefined,
      contactId: l.contact_id,
      taxCodeId: l.tax_code_id,
      amountCcy: l.amount_ccy,
    })),
  });
  await db.run(`UPDATE journal_entries SET status = 'reversed' WHERE tenant_id = ? AND id = ?`, [tenantId, entryId]);
  await db.run('UPDATE journal_entries SET reversal_of = ? WHERE tenant_id = ? AND id = ?', [entryId, tenantId, reversalId]);
  return reversalId;
}

export async function voidJournal(db: DB, tenantId: string, entryId: string): Promise<void> {
  await db.run(`UPDATE journal_entries SET status = 'void' WHERE tenant_id = ? AND id = ? AND status = 'posted'`, [
    tenantId,
    entryId,
  ]);
}

export interface LedgerBalance {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  debit: number;
  credit: number;
}

export async function accountBalances(
  db: DB,
  tenantId: string,
  from: string | null,
  to: string,
): Promise<LedgerBalance[]> {
  const range = from ? 'AND je.date >= ? AND je.date <= ?' : 'AND je.date <= ?';
  const params = from ? [tenantId, from, to] : [tenantId, to];
  return db.all<LedgerBalance>(
    `SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
            COALESCE(jl.debit, 0) AS debit,
            COALESCE(jl.credit, 0) AS credit
     FROM accounts a
     LEFT JOIN (
       SELECT jl.account_id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE jl.tenant_id = ? AND je.status = 'posted' ${range}
       GROUP BY jl.account_id
     ) jl ON jl.account_id = a.id
     WHERE a.tenant_id = ? AND a.is_active = 1
     ORDER BY a.code`,
    [...params, tenantId],
  );
}

export function signedBalance(type: string, debit: number, credit: number): number {
  return type === 'asset' || type === 'expense' ? debit - credit : credit - debit;
}
