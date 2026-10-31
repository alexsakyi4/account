/**
 * Financial reports. All figures are derived from posted journal entries so
 * every report ties out with the general ledger and each other.
 */
import type { DB } from '../db/driver.js';
import { signedBalance } from './ledger.js';

export interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  amount: number;
  depth?: number;
}

export interface ReportResult {
  report: string;
  title: string;
  from: string | null;
  to: string;
  currency: string;
  basis: 'accrual';
  generatedAt: string;
  sections: Array<{ key: string; label: string; lines: ReportLine[]; total: number }>;
  totals: Record<string, number>;
  meta?: Record<string, unknown>;
}

interface BalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  debit: number;
  credit: number;
}

async function balances(
  db: DB,
  tenantId: string,
  from: string | null,
  to: string,
  contactId?: string | null,
): Promise<BalanceRow[]> {
  const dateClause = from ? 'AND je.date >= ? AND je.date <= ?' : 'AND je.date <= ?';
  const contactClause = contactId ? 'AND jl.contact_id = ?' : '';
  // Parameter order must match the placeholders in the statement below.
  const params: Array<string | number> = [];
  if (contactId) params.push(contactId);
  if (from) params.push(from);
  params.push(to);
  params.push(tenantId);

  return db.all<BalanceRow>(
    `SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
            SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit END) AS debit,
            SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.credit END) AS credit
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.tenant_id = a.tenant_id ${contactClause}
     LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'posted' ${dateClause}
     WHERE a.tenant_id = ? AND a.is_active = 1
     GROUP BY a.id, a.code, a.name, a.type, a.subtype
     ORDER BY a.code`,
    params,
  );
}

function line(row: BalanceRow): ReportLine {
  return {
    accountId: row.account_id,
    code: row.code,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    amount: signedBalance(row.type, Number(row.debit ?? 0), Number(row.credit ?? 0)),
  };
}

async function tenantCurrency(db: DB, tenantId: string): Promise<string> {
  const t = await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]);
  return t?.base_currency ?? 'USD';
}

export async function profitAndLoss(
  db: DB,
  tenantId: string,
  from: string,
  to: string,
  opts: { contactId?: string | null } = {},
): Promise<ReportResult> {
  const rows = await balances(db, tenantId, from, to, opts.contactId);
  const income = rows.filter((r) => r.type === 'income').map((r) => ({ ...line(r), amount: line(r).amount }));
  const cogs = rows.filter((r) => r.type === 'expense' && r.subtype === 'cost_of_goods_sold').map(line);
  const operating = rows
    .filter((r) => r.type === 'expense' && r.subtype !== 'cost_of_goods_sold' && r.subtype !== 'other_expense')
    .map(line);
  const other = rows.filter((r) => r.type === 'expense' && r.subtype === 'other_expense').map(line);
  const otherIncome = rows.filter((r) => r.type === 'income' && r.subtype === 'other_income').map(line);

  const totalIncome = income.reduce((a, b) => a + b.amount, 0);
  const totalCogs = cogs.reduce((a, b) => a + b.amount, 0);
  const totalOperating = operating.reduce((a, b) => a + b.amount, 0);
  const totalOther = other.reduce((a, b) => a + b.amount, 0);
  const totalOtherIncome = otherIncome.reduce((a, b) => a + b.amount, 0);
  const grossProfit = totalIncome - totalCogs;
  const operatingIncome = grossProfit - totalOperating;
  const netIncome = operatingIncome + totalOtherIncome - totalOther;

  return {
    report: 'profit-and-loss',
    title: 'Profit & Loss',
    from,
    to,
    currency: await tenantCurrency(db, tenantId),
    basis: 'accrual',
    generatedAt: new Date().toISOString(),
    sections: [
      { key: 'income', label: 'Income', lines: income, total: totalIncome },
      { key: 'cogs', label: 'Cost of Goods Sold', lines: cogs, total: totalCogs },
      { key: 'gross_profit', label: 'Gross Profit', lines: [], total: grossProfit },
      { key: 'operating_expenses', label: 'Operating Expenses', lines: operating, total: totalOperating },
      { key: 'operating_income', label: 'Net Operating Income', lines: [], total: operatingIncome },
      { key: 'other_income', label: 'Other Income', lines: otherIncome, total: totalOtherIncome },
      { key: 'other_expenses', label: 'Other Expenses', lines: other, total: totalOther },
      { key: 'net_income', label: 'Net Income', lines: [], total: netIncome },
    ],
    totals: {
      income: totalIncome,
      cogs: totalCogs,
      grossProfit,
      operatingExpenses: totalOperating,
      operatingIncome,
      otherIncome: totalOtherIncome,
      otherExpenses: totalOther,
      netIncome,
    },
    meta: { contactId: opts.contactId ?? null },
  };
}

export async function balanceSheet(db: DB, tenantId: string, to: string): Promise<ReportResult> {
  const rows = await balances(db, tenantId, null, to);
  const assets = rows.filter((r) => r.type === 'asset').map(line);
  const liabilities = rows.filter((r) => r.type === 'liability').map(line);
  const equity = rows.filter((r) => r.type === 'equity').map(line);

  const totalAssets = assets.reduce((a, b) => a + b.amount, 0);
  const totalLiabilities = liabilities.reduce((a, b) => a + b.amount, 0);
  const totalEquity = equity.reduce((a, b) => a + b.amount, 0);

  const pnl = await profitAndLoss(db, tenantId, '0000-01-01', to);
  const netIncome = pnl.totals.netIncome ?? 0;

  return {
    report: 'balance-sheet',
    title: 'Balance Sheet',
    from: null,
    to,
    currency: await tenantCurrency(db, tenantId),
    basis: 'accrual',
    generatedAt: new Date().toISOString(),
    sections: [
      { key: 'assets', label: 'Assets', lines: assets, total: totalAssets },
      { key: 'liabilities', label: 'Liabilities', lines: liabilities, total: totalLiabilities },
      {
        key: 'equity',
        label: 'Equity',
        lines: [
          ...equity,
          {
            accountId: 'net-income',
            code: '',
            name: 'Current Year Earnings',
            type: 'equity',
            subtype: 'retained_earnings',
            amount: netIncome,
          },
        ],
        total: totalEquity + netIncome,
      },
    ],
    totals: {
      assets: totalAssets,
      liabilities: totalLiabilities,
      equity: totalEquity,
      currentEarnings: netIncome,
      liabilitiesAndEquity: totalLiabilities + totalEquity + netIncome,
      difference: totalAssets - (totalLiabilities + totalEquity + netIncome),
    },
  };
}

export async function trialBalance(db: DB, tenantId: string, from: string, to: string): Promise<ReportResult> {
  const rows = await balances(db, tenantId, from, to);
  const lines = rows
    .map((r) => ({
      ...line(r),
      meta: { debit: Number(r.debit ?? 0), credit: Number(r.credit ?? 0) },
    }))
    .filter((r) => r.meta.debit !== 0 || r.meta.credit !== 0);
  return {
    report: 'trial-balance',
    title: 'Trial Balance',
    from,
    to,
    currency: await tenantCurrency(db, tenantId),
    basis: 'accrual',
    generatedAt: new Date().toISOString(),
    sections: [{ key: 'accounts', label: 'Accounts', lines, total: 0 }],
    totals: {
      debit: lines.reduce((a, b) => a + (b.meta?.debit ?? 0), 0),
      credit: lines.reduce((a, b) => a + (b.meta?.credit ?? 0), 0),
    },
  };
}

export async function cashFlow(db: DB, tenantId: string, from: string, to: string): Promise<ReportResult> {
  const pnl = await profitAndLoss(db, tenantId, from, to);
  const netIncome = pnl.totals.netIncome;

  const startRows = await balances(db, tenantId, null, shiftDate(from, -1));
  const endRows = await balances(db, tenantId, null, to);
  const startBalance = (type: string, subtypes: string[]) =>
    startRows.filter((r) => r.type === type && subtypes.includes(r.subtype ?? '')).reduce((a, b) => a + line(b).amount, 0);
  const endBalance = (type: string, subtypes: string[]) =>
    endRows.filter((r) => r.type === type && subtypes.includes(r.subtype ?? '')).reduce((a, b) => a + line(b).amount, 0);

  const change = (type: string, subtypes: string[]) => endBalance(type, subtypes) - startBalance(type, subtypes);

  const cashStart = startBalance('asset', ['bank', 'cash']);
  const cashEnd = endBalance('asset', ['bank', 'cash']);
  const arChange = -change('asset', ['accounts_receivable']);
  const inventoryChange = -change('asset', ['inventory']);
  const apChange = change('liability', ['accounts_payable']);
  const taxChange = change('liability', ['other_current_liability']);
  const investing = -change('asset', ['fixed_asset', 'contra_asset']);
  const financing = change('equity', ['owner_equity', 'long_term_liability', 'retained_earnings']) + change('liability', ['long_term_liability', 'credit_card']);

  const operating = netIncome + arChange + inventoryChange + apChange + taxChange;

  return {
    report: 'cash-flow',
    title: 'Statement of Cash Flows (indirect)',
    from,
    to,
    currency: await tenantCurrency(db, tenantId),
    basis: 'accrual',
    generatedAt: new Date().toISOString(),
    sections: [
      {
        key: 'operating',
        label: 'Operating Activities',
        lines: [
          mk('Net income', netIncome),
          mk('Change in accounts receivable', arChange),
          mk('Change in inventory', inventoryChange),
          mk('Change in accounts payable', apChange),
          mk('Change in tax and accrued liabilities', taxChange),
        ],
        total: operating,
      },
      {
        key: 'investing',
        label: 'Investing Activities',
        lines: [mk('Purchases / disposals of fixed assets', investing)],
        total: investing,
      },
      {
        key: 'financing',
        label: 'Financing Activities',
        lines: [mk('Owner contributions, draws and borrowings', financing)],
        total: financing,
      },
    ],
    totals: {
      operating,
      investing,
      financing,
      netChange: operating + investing + financing,
      cashStart,
      cashEnd,
      cashEndActual: cashEnd,
    },
  };
}

function mk(name: string, amount: number): ReportLine {
  return { accountId: name, code: '', name, type: 'cash', subtype: null, amount };
}

export interface AgingRow {
  contactId: string;
  contactName: string;
  current: number;
  days1to30: number;
  days31to60: number;
  days61to90: number;
  days90plus: number;
  total: number;
}

export async function aging(
  db: DB,
  tenantId: string,
  asOf: string,
  kind: 'receivable' | 'payable',
): Promise<{ rows: AgingRow[]; totals: AgingRow; report: string }> {
  const isAr = kind === 'receivable';
  const source = isAr ? 'invoices' : 'bills';
  const contactColumn = isAr ? 'contact_id' : 'vendor_id';
  const docs = await db.all<{
    id: string;
    number: string;
    contact_id: string;
    contact_name: string;
    due_date: string | null;
    issue_date: string;
    balance: number;
    status: string;
    total: number;
    amount_paid: number;
  }>(
    `SELECT d.id, d.number, d.${contactColumn} AS contact_id, c.name AS contact_name,
            COALESCE(d.due_date, d.issue_date) AS due_date, d.issue_date, d.balance, d.status, d.total, d.amount_paid
     FROM ${source} d JOIN contacts c ON c.id = d.${contactColumn}
     WHERE d.tenant_id = ? AND d.status NOT IN ('draft','void','paid','converted','declined') AND d.balance > 0
       AND d.issue_date <= ?
     ORDER BY c.name, due_date`,
    [tenantId, asOf],
  );

  const byContact = new Map<string, AgingRow>();
  for (const doc of docs) {
    let row = byContact.get(doc.contact_id);
    if (!row) {
      row = {
        contactId: doc.contact_id,
        contactName: doc.contact_name,
        current: 0,
        days1to30: 0,
        days31to60: 0,
        days61to90: 0,
        days90plus: 0,
        total: 0,
      };
      byContact.set(doc.contact_id, row);
    }
    const daysLate = daysBetween(doc.due_date ?? doc.issue_date, asOf);
    const bucket =
      daysLate <= 0 ? 'current' : daysLate <= 30 ? 'days1to30' : daysLate <= 60 ? 'days31to60' : daysLate <= 90 ? 'days61to90' : 'days90plus';
    row[bucket] += doc.balance;
    row.total += doc.balance;
  }

  const rows = [...byContact.values()].sort((a, b) => b.total - a.total);
  const totals = rows.reduce<AgingRow>(
    (acc, r) => ({
      ...acc,
      contactId: 'total',
      contactName: 'Total',
      current: acc.current + r.current,
      days1to30: acc.days1to30 + r.days1to30,
      days31to60: acc.days31to60 + r.days31to60,
      days61to90: acc.days61to90 + r.days61to90,
      days90plus: acc.days90plus + r.days90plus,
      total: acc.total + r.total,
    }),
    { contactId: 'total', contactName: 'Total', current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0, total: 0 },
  );

  return { rows, totals, report: isAr ? 'ar-aging' : 'ap-aging' };
}

export async function generalLedger(
  db: DB,
  tenantId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<{
  account: { id: string; code: string; name: string; type: string };
  opening: number;
  lines: Array<{ date: string; entryNo: number; memo: string | null; debit: number; credit: number; balance: number; source: string }>;
  closing: number;
}> {
  const account = await db.get<{ id: string; code: string; name: string; type: string }>(
    'SELECT id, code, name, type FROM accounts WHERE tenant_id = ? AND id = ?',
    [tenantId, accountId],
  );
  if (!account) throw new Error('Account not found');
  const openingRow = await db.get<{ debit: number; credit: number }>(
    `SELECT COALESCE(SUM(jl.debit),0) AS debit, COALESCE(SUM(jl.credit),0) AS credit
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
     WHERE jl.tenant_id = ? AND jl.account_id = ? AND je.status = 'posted' AND je.date < ?`,
    [tenantId, accountId, from],
  );
  const opening = signedBalance(account.type, Number(openingRow?.debit ?? 0), Number(openingRow?.credit ?? 0));

  const rows = await db.all<{
    date: string;
    entry_no: number;
    memo: string | null;
    debit: number;
    credit: number;
    source_type: string;
  }>(
    `SELECT je.date, je.entry_no, COALESCE(jl.description, je.memo) AS memo, jl.debit, jl.credit, je.source_type
     FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
     WHERE jl.tenant_id = ? AND jl.account_id = ? AND je.status = 'posted' AND je.date >= ? AND je.date <= ?
     ORDER BY je.date, je.entry_no, jl.line_no`,
    [tenantId, accountId, from, to],
  );

  let running = opening;
  const lines = rows.map((r) => {
    running += signedBalance(account.type, Number(r.debit), Number(r.credit));
    return {
      date: r.date,
      entryNo: r.entry_no,
      memo: r.memo,
      debit: Number(r.debit),
      credit: Number(r.credit),
      balance: running,
      source: r.source_type,
    };
  });

  return { account, opening, lines, closing: running };
}

export function daysBetween(a: string, b: string): number {
  const d1 = Date.parse(`${a}T00:00:00Z`);
  const d2 = Date.parse(`${b}T00:00:00Z`);
  return Math.round((d2 - d1) / 86_400_000);
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function dashboard(db: DB, tenantId: string, asOf?: string): Promise<Record<string, unknown>> {
  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const month = await profitAndLoss(db, tenantId, monthStart, today);
  const year = await profitAndLoss(db, tenantId, yearStart, today);
  const sheet = await balanceSheet(db, tenantId, today);
  const ar = await aging(db, tenantId, today, 'receivable');
  const ap = await aging(db, tenantId, today, 'payable');

  const cashRow = sheet.sections
    .find((s) => s.key === 'assets')!
    .lines.filter((l) => l.subtype === 'bank' || l.subtype === 'cash')
    .reduce((a, b) => a + b.amount, 0);

  const overdue = await db.all<{ id: string; number: string; contact_name: string; due_date: string; balance: number; currency: string }>(
    `SELECT i.id, i.number, c.name AS contact_name, i.due_date, i.balance, i.currency
     FROM invoices i JOIN contacts c ON c.id = i.contact_id
     WHERE i.tenant_id = ? AND i.kind = 'invoice' AND i.status NOT IN ('draft','void','paid')
       AND i.balance > 0 AND i.due_date < ?
     ORDER BY i.due_date LIMIT 6`,
    [tenantId, today],
  );

  const trend: Array<{ month: string; income: number; expenses: number; net: number }> = [];
  for (let i = 5; i >= 0; i -= 1) {
    const ref = new Date(`${monthStart}T00:00:00Z`);
    ref.setUTCMonth(ref.getUTCMonth() - i);
    const start = ref.toISOString().slice(0, 10);
    const endRef = new Date(ref);
    endRef.setUTCMonth(endRef.getUTCMonth() + 1);
    endRef.setUTCDate(0);
    const end = endRef.toISOString().slice(0, 10);
    const p = await profitAndLoss(db, tenantId, start, end);
    trend.push({
      month: start.slice(0, 7),
      income: p.totals.income,
      expenses: p.totals.cogs + p.totals.operatingExpenses + p.totals.otherExpenses,
      net: p.totals.netIncome,
    });
  }

  const recent = await db.all<{ id: string; source_type: string; date: string; memo: string; entry_no: number }>(
    `SELECT id, source_type, date, memo, entry_no FROM journal_entries
     WHERE tenant_id = ? AND status = 'posted' ORDER BY posted_at DESC LIMIT 8`,
    [tenantId],
  );

  const counts = await db.get<{ customers: number; vendors: number; invoices: number; bills: number }>(
    `SELECT
      (SELECT COUNT(*) FROM contacts WHERE tenant_id = ? AND kind IN ('customer','both')) AS customers,
      (SELECT COUNT(*) FROM contacts WHERE tenant_id = ? AND kind IN ('vendor','both')) AS vendors,
      (SELECT COUNT(*) FROM invoices WHERE tenant_id = ? AND kind = 'invoice' AND status NOT IN ('draft','void')) AS invoices,
      (SELECT COUNT(*) FROM bills WHERE tenant_id = ? AND status NOT IN ('draft','void')) AS bills`,
    [tenantId, tenantId, tenantId, tenantId],
  );

  return {
    asOf: today,
    cash: { amount: cashRow, label: 'Cash and bank' },
    receivables: { amount: ar.totals.total, overdue: ar.rows.reduce((a, b) => a + b.days1to30 + b.days31to60 + b.days61to90 + b.days90plus, 0) },
    payables: { amount: ap.totals.total, overdue: ap.rows.reduce((a, b) => a + b.days1to30 + b.days31to60 + b.days61to90 + b.days90plus, 0) },
    month: { income: month.totals.income, expenses: month.totals.cogs + month.totals.operatingExpenses, netIncome: month.totals.netIncome },
    year: { income: year.totals.income, expenses: year.totals.cogs + year.totals.operatingExpenses, netIncome: year.totals.netIncome },
    balanceSheet: { assets: sheet.totals.assets, liabilities: sheet.totals.liabilities, equity: sheet.totals.equity },
    trend,
    overdueInvoices: overdue,
    recentEntries: recent,
    counts: counts ?? { customers: 0, vendors: 0, invoices: 0, bills: 0 },
  };
}
