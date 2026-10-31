/**
 * Sales and purchase document workflows: invoices, credit memos, estimates,
 * bills, expenses and payments. Every state transition that touches the ledger
 * goes through `postJournal`, so the trial balance is always correct.
 */
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { applyRate } from '../lib/money.js';
import { postJournal, reverseJournal, systemAccount, nextDocumentNumber, voidJournal } from '../domain/ledger.js';
import { SYSTEM_ACCOUNTS } from '../domain/accounts.js';
import { readSettings } from '../services/tenancy.js';

export interface LineInput {
  description: string;
  quantity?: number;
  unitPrice?: number;
  accountId?: string | null;
  taxCodeId?: string | null;
  itemId?: string | null;
  discountBp?: number;
}

export interface DocTotals {
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
}

export async function computeTotals(
  db: DB,
  tenantId: string,
  lines: LineInput[],
): Promise<{ lines: Array<LineInput & { amount: number; taxAmount: number; discount: number }>; totals: DocTotals }> {
  const taxIds = [...new Set(lines.map((l) => l.taxCodeId).filter(Boolean))] as string[];
  const taxes = taxIds.length
    ? await db.all<{ id: string; rate_bp: number; is_inclusive: number }>(
        `SELECT id, rate_bp, is_inclusive FROM tax_codes WHERE tenant_id = ? AND id IN (${taxIds.map(() => '?').join(',')})`,
        [tenantId, ...taxIds],
      )
    : [];
  const taxMap = new Map(taxes.map((t) => [t.id, t]));

  let subtotal = 0;
  let taxTotal = 0;
  let discountTotal = 0;
  const computed = lines.map((line) => {
    const qty = Number(line.quantity ?? 1);
    const gross = Math.round(qty * Number(line.unitPrice ?? 0));
    const discount = applyRate(gross, Number(line.discountBp ?? 0));
    const net = gross - discount;
    const tax = taxMap.get(line.taxCodeId ?? '');
    let taxAmount = tax ? applyRate(net, tax.rate_bp) : 0;
    if (tax && tax.is_inclusive === 1) {
      // Inclusive rates: the price already contains tax, back it out.
      const base = Math.round((net * 10_000) / (10_000 + tax.rate_bp));
      taxAmount = net - base;
    }
    subtotal += net;
    discountTotal += discount;
    taxTotal += taxAmount;
    return { ...line, amount: net, taxAmount, discount };
  });

  return { lines: computed, totals: { subtotal, taxTotal, discountTotal, total: subtotal + taxTotal } };
}

async function replaceLines(
  db: DB,
  table: 'invoice_lines' | 'bill_lines',
  tenantId: string,
  parentColumn: string,
  parentId: string,
  lines: Array<LineInput & { amount: number; taxAmount: number; discount?: number }>,
): Promise<void> {
  await db.run(`DELETE FROM ${table} WHERE tenant_id = ? AND ${parentColumn} = ?`, [tenantId, parentId]);
  let index = 0;
  for (const line of lines) {
    index += 1;
    const cols =
      table === 'invoice_lines'
        ? 'id, tenant_id, invoice_id, line_no, item_id, description, quantity, unit_price, amount, discount_bp, account_id, tax_code_id, tax_amount'
        : 'id, tenant_id, bill_id, line_no, item_id, description, quantity, unit_price, amount, account_id, tax_code_id, tax_amount';
    const values =
      table === 'invoice_lines'
        ? [newId(), tenantId, parentId, index, line.itemId ?? null, line.description, line.quantity ?? 1, line.unitPrice ?? 0, line.amount, line.discountBp ?? 0, line.accountId ?? null, line.taxCodeId ?? null, line.taxAmount]
        : [newId(), tenantId, parentId, index, line.itemId ?? null, line.description, line.quantity ?? 1, line.unitPrice ?? 0, line.amount, line.accountId ?? null, line.taxCodeId ?? null, line.taxAmount];
    await db.run(`INSERT INTO ${table} (${cols}) VALUES (${values.map(() => '?').join(',')})`, values);
  }
}

// ---------------------------------------------------------------- invoices --
export interface InvoiceInput {
  contactId: string;
  kind?: 'invoice' | 'credit_memo' | 'estimate';
  issueDate: string;
  dueDate?: string | null;
  currency?: string;
  fxRate?: number;
  lines: LineInput[];
  memo?: string;
  terms?: string;
  poNumber?: string;
  templateId?: string | null;
  status?: 'draft' | 'sent';
  autoPost?: boolean;
}

export async function getContact(db: DB, tenantId: string, id: string) {
  const contact = await db.get<{ id: string; name: string; kind: string; payment_terms_days: number; credit_limit: number }>(
    'SELECT * FROM contacts WHERE tenant_id = ? AND id = ?',
    [tenantId, id],
  );
  if (!contact) throw notFound('Customer not found');
  return contact;
}

export async function createInvoice(
  db: DB,
  tenantId: string,
  userId: string | null,
  input: InvoiceInput,
): Promise<string> {
  if (!input.lines?.length) throw badRequest('Add at least one line item');
  const kind = input.kind ?? 'invoice';
  const contact = await getContact(db, tenantId, input.contactId);
  const tenant = await db.get<{ base_currency: string; settings_json: string | null }>(
    'SELECT base_currency, settings_json FROM tenants WHERE id = ?',
    [tenantId],
  );
  const settings = readSettings(tenant?.settings_json);
  const currency = input.currency ?? tenant?.base_currency ?? 'USD';
  const { lines, totals } = await computeTotals(db, tenantId, input.lines);

  const defaultIncome = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.SERVICE_INCOME).catch(() =>
    systemAccount(db, tenantId, SYSTEM_ACCOUNTS.SALES_INCOME),
  );
  for (const line of lines) {
    if (!line.accountId) line.accountId = defaultIncome.id;
    if (!line.accountId) throw badRequest('Every line needs an income account');
  }

  if (kind === 'invoice' && contact.credit_limit > 0) {
    const outstanding = await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(balance), 0) AS total FROM invoices
       WHERE tenant_id = ? AND contact_id = ? AND kind = 'invoice' AND status NOT IN ('draft','void','paid')`,
      [tenantId, input.contactId],
    );
    if (Number(outstanding?.total ?? 0) + totals.total > contact.credit_limit) {
      throw unprocessable(
        `Credit limit exceeded. ${contact.name} has a limit of ${contact.credit_limit} minor units and ` +
          `${outstanding?.total ?? 0} outstanding.`,
        { code: 'credit_limit_exceeded', outstanding: Number(outstanding?.total ?? 0), creditLimit: contact.credit_limit },
      );
    }
  }

  const prefixMap = { invoice: settings.invoicePrefix || 'INV', credit_memo: 'CM', estimate: 'EST' } as const;
  const number = await nextDocumentNumber(db, tenantId, `doc_${kind}`, prefixMap[kind]);
  const now = new Date().toISOString();
  const id = newId();
  const issueDate = input.issueDate;
  const dueDate =
    input.dueDate ??
    new Date(new Date(`${issueDate}T00:00:00Z`).getTime() + contact.payment_terms_days * 86_400_000)
      .toISOString()
      .slice(0, 10);

  await db.run(
    `INSERT INTO invoices (id, tenant_id, kind, number, contact_id, issue_date, due_date, status, currency, fx_rate,
       subtotal, discount_total, tax_total, total, amount_paid, balance, memo, terms, po_number, template_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
      kind,
      number,
      input.contactId,
      issueDate,
      kind === 'estimate' ? null : dueDate,
      'draft',
      currency,
      input.fxRate ?? 1,
      totals.subtotal,
      totals.discountTotal,
      totals.taxTotal,
      totals.total,
      totals.total,
      input.memo ?? null,
      input.terms ?? null,
      input.poNumber ?? null,
      input.templateId ?? null,
      userId,
      now,
      now,
    ],
  );

  await replaceLines(db, 'invoice_lines', tenantId, 'invoice_id', id, lines);

  // Sending an invoice or issuing a credit memo posts to the ledger; estimates
  // never do. A draft stays out of the books until it is sent.
  const shouldPost =
    kind === 'estimate'
      ? false
      : kind === 'credit_memo'
        ? input.autoPost !== false
        : input.status === 'sent' || Boolean(input.autoPost);
  if (shouldPost) await postInvoice(db, tenantId, id, userId);
  return id;
}

export async function updateInvoice(
  db: DB,
  tenantId: string,
  invoiceId: string,
  input: Partial<InvoiceInput>,
  userId: string | null,
): Promise<void> {
  const invoice = await db.get<{ id: string; status: string; kind: string }>(
    'SELECT * FROM invoices WHERE tenant_id = ? AND id = ?',
    [tenantId, invoiceId],
  );
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.status !== 'draft') throw conflict('Only draft documents can be edited. Void and re-issue instead.');
  const lines = input.lines;
  let totals = { subtotal: 0, taxTotal: 0, discountTotal: 0, total: 0 };
  if (lines) {
    if (!lines.length) throw badRequest('Add at least one line item');
    const computed = await computeTotals(db, tenantId, lines);
    totals = computed.totals;
    const defaultIncome = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.SERVICE_INCOME);
    for (const line of computed.lines) if (!line.accountId) line.accountId = defaultIncome.id;
    await replaceLines(db, 'invoice_lines', tenantId, 'invoice_id', invoiceId, computed.lines);
  }
  const current = await db.get<{
    subtotal: number;
    tax_total: number;
    discount_total: number;
    total: number;
    contact_id: string;
    issue_date: string;
    due_date: string | null;
  }>('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  const next = {
    subtotal: lines ? totals.subtotal : Number(current?.subtotal ?? 0),
    tax_total: lines ? totals.taxTotal : Number(current?.tax_total ?? 0),
    discount_total: lines ? totals.discountTotal : Number(current?.discount_total ?? 0),
    total: lines ? totals.total : Number(current?.total ?? 0),
  };
  await db.run(
    `UPDATE invoices SET contact_id = ?, issue_date = ?, due_date = ?, memo = ?, terms = ?, po_number = ?,
       currency = ?, fx_rate = ?, subtotal = ?, discount_total = ?, tax_total = ?, total = ?, balance = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
    [
      input.contactId ?? current?.contact_id,
      input.issueDate ?? current?.issue_date,
      input.dueDate ?? current?.due_date,
      input.memo ?? null,
      input.terms ?? null,
      input.poNumber ?? null,
      input.currency ?? (await db.get<{ currency: string }>('SELECT currency FROM invoices WHERE id = ?', [invoiceId]))!.currency,
      input.fxRate ?? 1,
      next.subtotal,
      next.discount_total,
      next.tax_total,
      next.total,
      next.total,
      new Date().toISOString(),
      tenantId,
      invoiceId,
    ],
  );
}

/** Posts an invoice to the ledger: Dr A/R, Cr income, Cr sales tax. */
export async function postInvoice(db: DB, tenantId: string, invoiceId: string, userId: string | null): Promise<string> {
  const invoice = await db.get<{
    id: string;
    kind: string;
    number: string;
    contact_id: string;
    issue_date: string;
    currency: string;
    fx_rate: number;
    total: number;
    tax_total: number;
    status: string;
    journal_entry_id: string | null;
  }>('SELECT * FROM invoices WHERE tenant_id = ? AND id = ?', [tenantId, invoiceId]);
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.journal_entry_id) throw conflict('This document is already posted');
  const lines = await db.all<{ account_id: string; amount: number; tax_amount: number; tax_code_id: string | null; description: string }>(
    'SELECT * FROM invoice_lines WHERE tenant_id = ? AND invoice_id = ? ORDER BY line_no',
    [tenantId, invoiceId],
  );
  const ar = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AR);
  const taxAccount = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.SALES_TAX_PAYABLE);
  const isCredit = invoice.kind === 'credit_memo';

  const journalLines: Array<{ accountId: string; debit: number; credit: number; description: string; contactId?: string; taxCodeId?: string | null }> = [
    {
      accountId: ar.id,
      debit: isCredit ? 0 : invoice.total,
      credit: isCredit ? invoice.total : 0,
      contactId: invoice.contact_id,
      description: `${invoice.number} — ${invoice.kind === 'credit_memo' ? 'credit memo' : 'invoice'}`,
    },
    ...lines.map((l) => ({
      accountId: l.account_id,
      debit: isCredit ? l.amount : 0,
      credit: isCredit ? 0 : l.amount,
      description: l.description,
      taxCodeId: l.tax_code_id,
    })),
  ];
  if (invoice.tax_total > 0) {
    journalLines.push({
      accountId: taxAccount.id,
      debit: isCredit ? invoice.tax_total : 0,
      credit: isCredit ? 0 : invoice.tax_total,
      description: 'Sales tax',
    });
  }

  const entryId = await postJournal(db, {
    tenantId,
    date: invoice.issue_date,
    memo: `${invoice.number} — ${invoice.kind}`,
    sourceType: invoice.kind === 'credit_memo' ? 'credit_memo' : 'invoice',
    sourceId: invoice.id,
    currency: invoice.currency,
    fxRate: invoice.fx_rate,
    createdBy: userId,
    lines: journalLines,
  });

  await db.run(
    `UPDATE invoices SET journal_entry_id = ?, status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
       sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE tenant_id = ? AND id = ?`,
    [entryId, new Date().toISOString(), new Date().toISOString(), tenantId, invoiceId],
  );

  if (invoice.kind === 'invoice') await consumeInventory(db, tenantId, invoiceId, userId);
  return entryId;
}

export async function voidInvoice(db: DB, tenantId: string, invoiceId: string, userId: string | null): Promise<void> {
  const invoice = await db.get<{ journal_entry_id: string | null; amount_paid: number }>(
    'SELECT * FROM invoices WHERE tenant_id = ? AND id = ?',
    [tenantId, invoiceId],
  );
  if (!invoice) throw notFound('Invoice not found');
  if (invoice.amount_paid > 0) throw conflict('Remove applied payments before voiding this invoice');
  if (invoice.journal_entry_id) await voidJournal(db, tenantId, invoice.journal_entry_id);
  await db.run(`UPDATE invoices SET status = 'void', balance = 0, updated_at = ? WHERE tenant_id = ? AND id = ?`, [
    new Date().toISOString(),
    tenantId,
    invoiceId,
  ]);
}

async function consumeInventory(db: DB, tenantId: string, invoiceId: string, userId: string | null): Promise<void> {
  const lines = await db.all<{ item_id: string | null; quantity: number }>(
    'SELECT item_id, quantity FROM invoice_lines WHERE tenant_id = ? AND invoice_id = ? AND item_id IS NOT NULL',
    [tenantId, invoiceId],
  );
  if (!lines.length) return;
  const invoice = await db.get<{ issue_date: string; number: string }>('SELECT issue_date, number FROM invoices WHERE id = ?', [invoiceId]);
  let cogsTotal = 0;
  for (const line of lines) {
    const item = await db.get<{ id: string; item_type: string; purchase_cost: number; quantity_on_hand: number; inventory_asset_account_id: string | null }>(
      'SELECT * FROM items WHERE tenant_id = ? AND id = ?',
      [tenantId, line.item_id],
    );
    if (!item || item.item_type !== 'inventory') continue;
    const qty = Number(line.quantity);
    const unitCost = Number(item.purchase_cost);
    const totalCost = Math.round(unitCost * qty);
    cogsTotal += totalCost;
    await db.run(
      `INSERT INTO inventory_movements (id, tenant_id, item_id, date, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, memo, created_at)
       VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, 'invoice', ?, NULL, ?)`,
      [newId(), tenantId, item.id, invoice?.issue_date, -qty, unitCost, totalCost, invoiceId, new Date().toISOString()],
    );
    await db.run('UPDATE items SET quantity_on_hand = quantity_on_hand - ?, updated_at = ? WHERE id = ?', [
      qty,
      new Date().toISOString(),
      item.id,
    ]);
  }
  if (cogsTotal <= 0) return;
  const cogs = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.COGS);
  const inventory = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.INVENTORY_ASSET);
  await postJournal(db, {
    tenantId,
    date: invoice?.issue_date ?? new Date().toISOString().slice(0, 10),
    memo: `COGS for ${invoice?.number}`,
    sourceType: 'inventory',
    sourceId: invoiceId,
    currency: (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))!.base_currency,
    createdBy: userId,
    lines: [
      { accountId: cogs.id, debit: cogsTotal, description: 'Cost of goods sold' },
      { accountId: inventory.id, credit: cogsTotal, description: 'Inventory relief' },
    ],
  });
}

// ------------------------------------------------------------------ bills --
export interface BillInput {
  vendorId: string;
  number?: string;
  issueDate: string;
  dueDate?: string | null;
  currency?: string;
  fxRate?: number;
  lines: LineInput[];
  memo?: string;
  status?: 'draft' | 'open';
  scheduledPaymentDate?: string | null;
}

export async function createBill(
  db: DB,
  tenantId: string,
  userId: string | null,
  input: BillInput,
): Promise<string> {
  if (!input.lines?.length) throw badRequest('Add at least one line item');
  const vendor = await getContact(db, tenantId, input.vendorId);
  const tenant = await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]);
  const currency = input.currency ?? tenant?.base_currency ?? 'USD';
  const { lines, totals } = await computeTotals(db, tenantId, input.lines);
  const expense = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.UNCATEGORIZED_EXPENSE);
  for (const line of lines) if (!line.accountId) line.accountId = expense.id;

  const number = input.number?.trim() || (await nextDocumentNumber(db, tenantId, 'bill', 'BILL'));
  const now = new Date().toISOString();
  const id = newId();
  const dueDate =
    input.dueDate ??
    new Date(new Date(`${input.issueDate}T00:00:00Z`).getTime() + vendor.payment_terms_days * 86_400_000)
      .toISOString()
      .slice(0, 10);

  await db.run(
    `INSERT INTO bills (id, tenant_id, number, vendor_id, issue_date, due_date, status, currency, fx_rate, subtotal, tax_total,
       total, amount_paid, balance, memo, scheduled_payment_date, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [id, tenantId, number, input.vendorId, input.issueDate, dueDate, currency, input.fxRate ?? 1, totals.subtotal, totals.taxTotal, totals.total, totals.total, input.memo ?? null, input.scheduledPaymentDate ?? null, userId, now, now],
  );
  await replaceLines(db, 'bill_lines', tenantId, 'bill_id', id, lines);
  if (input.status === 'open') await postBill(db, tenantId, id, userId);
  return id;
}

export async function postBill(db: DB, tenantId: string, billId: string, userId: string | null): Promise<string> {
  const bill = await db.get<{
    id: string;
    number: string;
    vendor_id: string;
    issue_date: string;
    currency: string;
    fx_rate: number;
    total: number;
    tax_total: number;
    journal_entry_id: string | null;
  }>('SELECT * FROM bills WHERE tenant_id = ? AND id = ?', [tenantId, billId]);
  if (!bill) throw notFound('Bill not found');
  if (bill.journal_entry_id) throw conflict('This bill is already posted');
  const lines = await db.all<{ account_id: string; amount: number; tax_amount: number; description: string; tax_code_id: string | null }>(
    'SELECT * FROM bill_lines WHERE tenant_id = ? AND bill_id = ? ORDER BY line_no',
    [tenantId, billId],
  );
  const ap = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AP);
  const taxAccount = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.SALES_TAX_PAYABLE);

  const journalLines: Array<{ accountId: string; debit: number; credit: number; description: string; contactId?: string; taxCodeId?: string | null }> = [
    ...lines.map((l) => ({
      accountId: l.account_id,
      debit: l.amount,
      credit: 0,
      description: l.description,
      contactId: bill.vendor_id,
      taxCodeId: l.tax_code_id,
    })),
    {
      accountId: ap.id,
      debit: 0,
      credit: bill.total,
      contactId: bill.vendor_id,
      description: `Bill ${bill.number}`,
    },
  ];
  if (bill.tax_total > 0) {
    journalLines.push({
      accountId: taxAccount.id,
      debit: bill.tax_total,
      credit: 0,
      description: 'Input tax',
    });
  }

  const entryId = await postJournal(db, {
    tenantId,
    date: bill.issue_date,
    memo: `Bill ${bill.number}`,
    sourceType: 'bill',
    sourceId: bill.id,
    currency: bill.currency,
    fxRate: bill.fx_rate,
    createdBy: userId,
    lines: journalLines,
  });
  await db.run(
    `UPDATE bills SET journal_entry_id = ?, status = CASE WHEN status = 'draft' THEN 'open' ELSE status END, updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
    [entryId, new Date().toISOString(), tenantId, billId],
  );
  await receiveInventory(db, tenantId, billId, userId);
  return entryId;
}

async function receiveInventory(db: DB, tenantId: string, billId: string, userId: string | null): Promise<void> {
  const lines = await db.all<{ item_id: string | null; quantity: number; unit_price: number; account_id: string | null }>(
    'SELECT item_id, quantity, unit_price, account_id FROM bill_lines WHERE tenant_id = ? AND bill_id = ? AND item_id IS NOT NULL',
    [tenantId, billId],
  );
  if (!lines.length) return;
  const bill = await db.get<{ issue_date: string; number: string }>('SELECT issue_date, number FROM bills WHERE id = ?', [billId]);
  let total = 0;
  // Purchases hit an expense (or purchases) account when the bill is entered;
  // receiving stock reclassifies that cost onto the inventory asset.
  const creditByAccount = new Map<string, number>();
  for (const line of lines) {
    const item = await db.get<{ id: string; item_type: string }>('SELECT * FROM items WHERE tenant_id = ? AND id = ?', [tenantId, line.item_id]);
    if (!item || item.item_type !== 'inventory') continue;
    const qty = Number(line.quantity);
    const unitCost = Number(line.unit_price);
    const cost = Math.round(qty * unitCost);
    total += cost;
    if (line.account_id) creditByAccount.set(line.account_id, (creditByAccount.get(line.account_id) ?? 0) + cost);
    await db.run(
      `INSERT INTO inventory_movements (id, tenant_id, item_id, date, movement_type, quantity, unit_cost, total_cost, reference_type, reference_id, created_at)
       VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?, 'bill', ?, ?)`,
      [newId(), tenantId, item.id, bill?.issue_date, qty, unitCost, cost, billId, new Date().toISOString()],
    );
    const existing = await db.get<{ quantity_on_hand: number; purchase_cost: number }>('SELECT quantity_on_hand, purchase_cost FROM items WHERE id = ?', [item.id]);
    const newQty = Number(existing?.quantity_on_hand ?? 0) + qty;
    const weighted = newQty > 0
      ? Math.round((Number(existing?.quantity_on_hand ?? 0) * Number(existing?.purchase_cost ?? 0) + cost) / newQty)
      : unitCost;
    await db.run('UPDATE items SET quantity_on_hand = ?, purchase_cost = ?, updated_at = ? WHERE id = ?', [
      newQty,
      weighted,
      new Date().toISOString(),
      item.id,
    ]);
  }
  if (total <= 0) return;
  const inventory = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.INVENTORY_ASSET);
  const fallback = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.UNCATEGORIZED_EXPENSE);
  const credits = [...creditByAccount.entries()];
  const journalLines = [
    { accountId: inventory.id, debit: total, description: 'Inventory received' },
    ...(credits.length
      ? credits.map(([accountId, amount]) => ({ accountId, credit: amount, description: 'Purchases reclassified to inventory' }))
      : [{ accountId: fallback.id, credit: total, description: 'Purchases reclassified to inventory' }]),
  ];
  await postJournal(db, {
    tenantId,
    date: bill?.issue_date ?? new Date().toISOString().slice(0, 10),
    memo: `Inventory received on ${bill?.number}`,
    sourceType: 'inventory',
    sourceId: billId,
    currency: (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))!.base_currency,
    createdBy: userId,
    lines: journalLines,
  });
}

// --------------------------------------------------------------- payments --
export interface PaymentInput {
  direction: 'receipt' | 'disbursement';
  contactId?: string | null;
  date: string;
  amount: number;
  method?: string;
  reference?: string | null;
  depositAccountId?: string | null;
  currency?: string;
  fxRate?: number;
  provider?: string;
  providerRef?: string | null;
  providerFee?: number;
  notes?: string;
  applications?: Array<{ invoiceId?: string; billId?: string; amount: number }>;
}

export async function recordPayment(
  db: DB,
  tenantId: string,
  userId: string | null,
  input: PaymentInput,
): Promise<{ paymentId: string; allocated: number }> {
  const amount = Math.round(input.amount);
  if (amount <= 0) throw badRequest('Payment amount must be greater than zero');
  const applications = input.applications ?? [];
  const allocated = applications.reduce((a, b) => a + b.amount, 0);
  if (allocated > amount) throw badRequest('Applications exceed the payment amount');
  const tenant = await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]);
  const currency = input.currency ?? tenant?.base_currency ?? 'USD';
  const isReceipt = input.direction === 'receipt';

  // Validate documents before writing anything.
  for (const app of applications) {
    const table = isReceipt ? 'invoices' : 'bills';
    const id = isReceipt ? app.invoiceId : app.billId;
    if (!id) throw badRequest('Application is missing a document id');
    const doc = await db.get<{ id: string; balance: number; status: string; number: string }>(
      `SELECT id, balance, status, number FROM ${table} WHERE tenant_id = ? AND id = ?`,
      [tenantId, id],
    );
    if (!doc) throw notFound('Document not found');
    if (['draft', 'void', 'paid'].includes(doc.status)) throw conflict(`Document ${doc.number} is ${doc.status}`);
    if (app.amount > doc.balance) throw unprocessable(`Application of ${app.amount} exceeds the balance on ${doc.number}`);
  }

  const paymentId = newId();
  const number = await nextDocumentNumber(db, tenantId, isReceipt ? 'receipt' : 'vendor_payment', isReceipt ? 'RCPT' : 'PMT');
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO payments (id, tenant_id, direction, number, contact_id, date, amount, currency, fx_rate, method, reference,
       deposit_account_id, status, provider, provider_ref, provider_fee, journal_entry_id, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, NULL, ?, ?, ?)`,
    [
      paymentId,
      tenantId,
      input.direction,
      number,
      input.contactId ?? null,
      input.date,
      amount,
      currency,
      input.fxRate ?? 1,
      input.method ?? 'bank_transfer',
      input.reference ?? null,
      input.depositAccountId ?? null,
      input.provider ?? 'manual',
      input.providerRef ?? null,
      input.providerFee ?? 0,
      input.notes ?? null,
      userId,
      now,
    ],
  );

  for (const app of applications) {
    await db.run(
      `INSERT INTO payment_applications (id, tenant_id, payment_id, invoice_id, bill_id, amount, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), tenantId, paymentId, app.invoiceId ?? null, app.billId ?? null, app.amount, input.date],
    );
    const table = isReceipt ? 'invoices' : 'bills';
    const docId = (isReceipt ? app.invoiceId : app.billId)!;
    const doc = await db.get<{ total: number; amount_paid: number }>(`SELECT total, amount_paid FROM ${table} WHERE id = ?`, [docId]);
    const paid = Number(doc?.amount_paid ?? 0) + app.amount;
    const balance = Number(doc?.total ?? 0) - paid;
    await db.run(`UPDATE ${table} SET amount_paid = ?, balance = ?, status = ?, updated_at = ? WHERE id = ?`, [
      paid,
      balance,
      balance <= 0 ? 'paid' : 'partial',
      now,
      docId,
    ]);
  }

  const ar = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AR);
  const ap = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AP);
  const undeposited = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.UNDEPOSITED_FUNDS);
  const targetAccountId = input.depositAccountId ?? (isReceipt ? undeposited.id : (await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.CHECKING)).id);
  const fee = Math.round(input.providerFee ?? 0);

  const journalLines: Array<{ accountId: string; debit?: number; credit?: number; description: string; contactId?: string | null }> = isReceipt
    ? [
        { accountId: targetAccountId, debit: amount - fee, description: `Receipt ${number}`, contactId: input.contactId ?? null },
        ...(fee > 0
          ? [{ accountId: (await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.MERCHANT_FEES)).id, debit: fee, description: 'Processing fee' }]
          : []),
        { accountId: ar.id, credit: amount, description: `Receipt ${number}`, contactId: input.contactId ?? null },
      ]
    : [
        { accountId: ap.id, debit: amount, description: `Payment ${number}`, contactId: input.contactId ?? null },
        { accountId: targetAccountId, credit: amount - fee, description: `Payment ${number}` },
        ...(fee > 0 ? [{ accountId: (await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.MERCHANT_FEES)).id, debit: fee, description: 'Processing fee' }] : []),
      ];

  const entryId = await postJournal(db, {
    tenantId,
    date: input.date,
    memo: `${isReceipt ? 'Receipt' : 'Payment'} ${number}`,
    sourceType: isReceipt ? 'payment' : 'bill_payment',
    sourceId: paymentId,
    currency,
    fxRate: input.fxRate ?? 1,
    createdBy: userId,
    lines: journalLines,
  });
  await db.run('UPDATE payments SET journal_entry_id = ? WHERE id = ?', [entryId, paymentId]);
  return { paymentId, allocated };
}

export async function voidPayment(db: DB, tenantId: string, paymentId: string, userId: string | null): Promise<void> {
  const payment = await db.get<{ journal_entry_id: string | null; status: string; direction: string }>(
    'SELECT * FROM payments WHERE tenant_id = ? AND id = ?',
    [tenantId, paymentId],
  );
  if (!payment) throw notFound('Payment not found');
  if (payment.status === 'voided') throw conflict('Payment is already voided');
  const apps = await db.all<{ invoice_id: string | null; bill_id: string | null; amount: number }>(
    'SELECT * FROM payment_applications WHERE tenant_id = ? AND payment_id = ?',
    [tenantId, paymentId],
  );
  for (const app of apps) {
    const table = app.invoice_id ? 'invoices' : 'bills';
    const id = app.invoice_id ?? app.bill_id;
    const doc = await db.get<{ total: number; amount_paid: number }>(`SELECT total, amount_paid FROM ${table} WHERE id = ?`, [id]);
    const paid = Math.max(0, Number(doc?.amount_paid ?? 0) - app.amount);
    const balance = Number(doc?.total ?? 0) - paid;
    await db.run(`UPDATE ${table} SET amount_paid = ?, balance = ?, status = ? WHERE id = ?`, [
      paid,
      balance,
      balance <= 0 ? 'paid' : paid > 0 ? 'partial' : 'sent',
      id,
    ]);
  }
  await db.run('DELETE FROM payment_applications WHERE tenant_id = ? AND payment_id = ?', [tenantId, paymentId]);
  if (payment.journal_entry_id) await reverseJournal(db, tenantId, payment.journal_entry_id, userId, 'Payment voided');
  await db.run(`UPDATE payments SET status = 'voided' WHERE tenant_id = ? AND id = ?`, [tenantId, paymentId]);
}

// ---------------------------------------------------------------- expenses --
export interface ExpenseInput {
  date: string;
  contactId?: string | null;
  employeeId?: string | null;
  memo?: string;
  currency?: string;
  paymentMethod?: string;
  lines: Array<{ accountId: string; description?: string; amount: number; taxCodeId?: string | null }>;
  receiptAttachmentId?: string | null;
  ocr?: unknown;
  status?: 'draft' | 'submitted' | 'approved';
  autoPost?: boolean;
}

export async function createExpense(
  db: DB,
  tenantId: string,
  userId: string | null,
  input: ExpenseInput,
): Promise<string> {
  if (!input.lines?.length) throw badRequest('Add at least one expense line');
  const tenant = await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]);
  const currency = input.currency ?? tenant?.base_currency ?? 'USD';
  const taxIds = [...new Set(input.lines.map((l) => l.taxCodeId).filter(Boolean))] as string[];
  const taxes = taxIds.length
    ? await db.all<{ id: string; rate_bp: number }>(
        `SELECT id, rate_bp FROM tax_codes WHERE tenant_id = ? AND id IN (${taxIds.map(() => '?').join(',')})`,
        [tenantId, ...taxIds],
      )
    : [];
  const taxMap = new Map(taxes.map((t) => [t.id, t.rate_bp]));
  let subtotal = 0;
  let taxTotal = 0;
  for (const line of input.lines) {
    subtotal += line.amount;
    taxTotal += applyRate(line.amount, taxMap.get(line.taxCodeId ?? '') ?? 0);
  }
  const id = newId();
  const number = await nextDocumentNumber(db, tenantId, 'expense', 'EXP');
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO expenses (id, tenant_id, number, contact_id, employee_id, date, status, currency, subtotal, tax_total, total,
       memo, payment_method, receipt_attachment_id, ocr_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
      number,
      input.contactId ?? null,
      input.employeeId ?? userId,
      input.date,
      input.status ?? 'submitted',
      currency,
      subtotal,
      taxTotal,
      subtotal + taxTotal,
      input.memo ?? null,
      input.paymentMethod ?? null,
      input.receiptAttachmentId ?? null,
      input.ocr ? JSON.stringify(input.ocr) : null,
      userId,
      now,
      now,
    ],
  );
  let index = 0;
  for (const line of input.lines) {
    index += 1;
    await db.run(
      `INSERT INTO expense_lines (id, tenant_id, expense_id, line_no, account_id, tax_code_id, description, amount, tax_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), tenantId, id, index, line.accountId, line.taxCodeId ?? null, line.description ?? null, line.amount, applyRate(line.amount, taxMap.get(line.taxCodeId ?? '') ?? 0)],
    );
  }
  if (input.autoPost) await postExpense(db, tenantId, id, userId);
  return id;
}

export async function postExpense(db: DB, tenantId: string, expenseId: string, userId: string | null): Promise<string> {
  const expense = await db.get<{
    id: string;
    number: string;
    date: string;
    currency: string;
    tax_total: number;
    total: number;
    memo: string | null;
    employee_id: string | null;
    payment_method: string | null;
    journal_entry_id: string | null;
  }>('SELECT * FROM expenses WHERE tenant_id = ? AND id = ?', [tenantId, expenseId]);
  if (!expense) throw notFound('Expense not found');
  if (expense.journal_entry_id) throw conflict('Expense already posted');
  const lines = await db.all<{ account_id: string; amount: number; tax_amount: number; description: string | null; tax_code_id: string | null }>(
    'SELECT * FROM expense_lines WHERE tenant_id = ? AND expense_id = ? ORDER BY line_no',
    [tenantId, expenseId],
  );
  const taxAccount = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.SALES_TAX_PAYABLE);
  const creditAccount =
    expense.payment_method === 'cash'
      ? await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.CHECKING)
      : await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AP);

  const journalLines = [
    ...lines.map((l) => ({ accountId: l.account_id, debit: l.amount, description: l.description ?? undefined, taxCodeId: l.tax_code_id })),
    ...(expense.tax_total > 0 ? [{ accountId: taxAccount.id, debit: expense.tax_total, description: 'Input tax' }] : []),
    { accountId: creditAccount.id, credit: expense.total, description: `Expense ${expense.number}` },
  ];

  const entryId = await postJournal(db, {
    tenantId,
    date: expense.date,
    memo: `Expense ${expense.number}`,
    sourceType: 'expense',
    sourceId: expense.id,
    currency: expense.currency,
    createdBy: userId,
    lines: journalLines,
  });
  await db.run(`UPDATE expenses SET journal_entry_id = ?, status = 'posted', updated_at = ? WHERE tenant_id = ? AND id = ?`, [
    entryId,
    new Date().toISOString(),
    tenantId,
    expenseId,
  ]);
  return entryId;
}

export async function convertEstimate(db: DB, tenantId: string, estimateId: string, userId: string | null): Promise<string> {
  const est = await db.get<{ id: string; contact_id: string; currency: string; status: string; total: number; due_date: string | null; memo: string | null; terms: string | null }>(
    'SELECT * FROM invoices WHERE tenant_id = ? AND id = ? AND kind = ?',
    [tenantId, estimateId, 'estimate'],
  );
  if (!est) throw notFound('Estimate not found');
  if (est.status === 'converted') throw conflict('Estimate has already been converted');
  const lines = await db.all<{ description: string; quantity: number; unit_price: number; account_id: string; tax_code_id: string | null; discount_bp: number }>(
    'SELECT * FROM invoice_lines WHERE tenant_id = ? AND invoice_id = ? ORDER BY line_no',
    [tenantId, estimateId],
  );
  const invoiceId = await createInvoice(db, tenantId, userId, {
    contactId: est.contact_id,
    issueDate: new Date().toISOString().slice(0, 10),
    currency: est.currency,
    memo: est.memo ?? undefined,
    terms: est.terms ?? undefined,
    status: 'sent',
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      accountId: l.account_id,
      taxCodeId: l.tax_code_id,
      discountBp: l.discount_bp,
    })),
  });
  await db.run(`UPDATE invoices SET status = 'converted', estimate_id = ?, updated_at = ? WHERE id = ?`, [invoiceId, new Date().toISOString(), estimateId]);
  return invoiceId;
}
