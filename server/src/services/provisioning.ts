/**
 * Company provisioning: chart of accounts, taxes, currencies, fiscal calendar,
 * feature flags, default invoice template and onboarding checklist.
 * Also provides the sample-data generator used by the training sandbox.
 */
import type { DB } from '../db/driver.js';
import { newId } from '../db/driver.js';
import { chartTemplate, normalBalanceFor, SYSTEM_ACCOUNTS } from '../domain/accounts.js';
import { postJournal, systemAccount } from '../domain/ledger.js';
import { DEFAULT_SETTINGS, FEATURE_FLAGS } from './tenancy.js';
import { createBill, createExpense, createInvoice, postBill, recordPayment } from './documents.js';

export function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return iso(d);
}

export function daysAhead(days: number): string {
  return daysAgo(-days);
}

export interface ProvisionInput {
  name: string;
  industry?: string;
  currency?: string;
  adminUserId: string;
  adminEmail: string;
  plan?: string;
  isSandbox?: boolean;
  withSampleData?: boolean;
}

export async function provisionCompany(db: DB, input: ProvisionInput): Promise<string> {
  const now = new Date().toISOString();
  const industry = input.industry ?? 'general';
  const currency = input.currency ?? 'USD';
  const tenantId = newId();
  const baseSlug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'company';
  let slug = baseSlug;
  let attempt = 1;
  while (await db.get('SELECT id FROM tenants WHERE slug = ?', [slug])) {
    attempt += 1;
    slug = `${baseSlug}-${attempt}`;
  }

  await db.run(
    `INSERT INTO tenants (id, name, slug, industry, base_currency, fiscal_year_start_month, plan, status, is_sandbox,
       trial_ends_at, email, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      input.name,
      slug,
      industry,
      currency,
      input.plan ?? 'trial',
      input.isSandbox ? 1 : 0,
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
      input.adminEmail,
      JSON.stringify(DEFAULT_SETTINGS),
      now,
      now,
    ],
  );

  await db.run(
    `INSERT INTO memberships (id, tenant_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)`,
    [newId(), tenantId, input.adminUserId, now],
  );

  // Chart of accounts
  const accounts = chartTemplate(industry);
  const codeToId = new Map<string, string>();
  for (const account of accounts) {
    const id = newId();
    codeToId.set(account.code, id);
    await db.run(
      `INSERT INTO accounts (id, tenant_id, code, name, type, subtype, parent_id, description, is_system, system_key, is_active, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        tenantId,
        account.code,
        account.name,
        account.type,
        account.subtype,
        null,
        account.description ?? null,
        account.systemKey ? 1 : 0,
        account.systemKey ?? null,
        currency,
        now,
        now,
      ],
    );
  }
  for (const account of accounts) {
    if (account.parentCode && codeToId.has(account.parentCode)) {
      await db.run('UPDATE accounts SET parent_id = ? WHERE id = ?', [codeToId.get(account.parentCode), codeToId.get(account.code)]);
    }
  }

  // Taxes
  const taxAccountId = [...codeToId.entries()].find(([, id]) =>
    accounts.find((a) => a.systemKey === SYSTEM_ACCOUNTS.SALES_TAX_PAYABLE && codeToId.get(a.code) === id),
  )?.[1] ?? null;
  const taxCodes = [
    { code: 'TAX0', name: 'No tax (0%)', rate: 0 },
    { code: 'VAT15', name: 'VAT 15%', rate: 1500 },
    { code: 'ST7', name: 'Sales tax 7%', rate: 700 },
    { code: 'GST10', name: 'GST 10%', rate: 1000 },
  ];
  for (const tax of taxCodes) {
    await db.run(
      `INSERT INTO tax_codes (id, tenant_id, code, name, rate_bp, tax_type, is_inclusive, account_id, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?)`,
      [newId(), tenantId, tax.code, tax.name, tax.rate, tax.code.startsWith('GST') ? 'gst' : tax.code.startsWith('VAT') ? 'vat' : 'sales', taxAccountId, now],
    );
  }

  // Currencies + starter rates
  const rates: Array<[string, string, string, number]> = [
    ['USD', 'US Dollar', '$', 1],
    ['EUR', 'Euro', '€', 1.08],
    ['GBP', 'Pound Sterling', '£', 1.27],
    ['GHS', 'Ghanaian Cedi', '₵', 0.065],
    ['CAD', 'Canadian Dollar', 'CA$', 0.73],
    ['NGN', 'Nigerian Naira', '₦', 0.00065],
  ];
  for (const [code, name, symbol, rate] of rates) {
    await db.run(
      `INSERT INTO currencies (id, tenant_id, code, name, symbol, is_base, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), tenantId, code, name, symbol, code === currency ? 1 : 0, now],
    );
    if (code !== currency) {
      await db.run(
        `INSERT INTO exchange_rates (id, tenant_id, base_currency, quote_currency, rate, rate_date, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'seed', ?)`,
        [newId(), tenantId, code, currency, rate, daysAgo(0), now],
      );
    }
  }

  // Fiscal periods: monthly for the current calendar year
  const year = new Date().getUTCFullYear();
  for (let month = 0; month < 12; month += 1) {
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 0));
    await db.run(
      `INSERT INTO fiscal_periods (id, tenant_id, name, start_date, end_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      [newId(), tenantId, start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), iso(start), iso(end), now],
    );
  }

  // Feature flags
  for (const [key, meta] of Object.entries(FEATURE_FLAGS)) {
    await db.run(
      `INSERT INTO feature_flags (id, tenant_id, flag_key, enabled, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [newId(), tenantId, key, meta.default ? 1 : 0, now],
    );
  }

  // Invoice template
  await db.run(
    `INSERT INTO invoice_templates (id, tenant_id, name, accent_color, layout, footer_text, show_logo, is_default, created_at)
     VALUES (?, ?, 'Modern', '#0f766e', 'modern', 'Thank you for your business.', 1, 1, ?)`,
    [newId(), tenantId, now],
  );

  // Bank accounts linked to the checking and savings GL accounts
  const checking = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.CHECKING).catch(() => null);
  if (checking) {
    await db.run(
      `INSERT INTO bank_accounts (id, tenant_id, name, account_id, bank_name, mask, currency, opening_balance, current_balance, provider, created_at)
       VALUES (?, ?, 'Business Checking', ?, 'First National Bank', '4821', ?, 0, 0, 'manual', ?)`,
      [newId(), tenantId, checking.id, currency, now],
    );
  }
  const savings = await db.get<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = ? AND code = ?', [tenantId, '1020']);
  if (savings) {
    await db.run(
      `INSERT INTO bank_accounts (id, tenant_id, name, account_id, bank_name, mask, currency, opening_balance, current_balance, provider, created_at)
       VALUES (?, ?, 'Savings Account', ?, 'First National Bank', '9088', ?, 0, 0, 'manual', ?)`,
      [newId(), tenantId, savings.id, currency, now],
    );
  }

  // Subscription (billing)
  await db.run(
    `INSERT INTO subscriptions (id, tenant_id, plan, status, seats, price_cents, currency, current_period_start, current_period_end, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, 'internal', ?, ?)`,
    [newId(), tenantId, input.plan ?? 'trial', input.plan === 'trial' ? 'trialing' : 'active', currency, daysAgo(0), daysAhead(30), now, now],
  );

  // Onboarding checklist
  for (const step of ONBOARDING_STEPS) {
    await db.run(
      `INSERT INTO onboarding_progress (id, tenant_id, step_key, completed_at) VALUES (?, ?, ?, ?)`,
      [newId(), tenantId, step.key, step.key === 'company' ? now : null],
    );
  }

  // Opening balance so the balance sheet is not empty
  if (input.withSampleData) {
    await seedSampleData(db, tenantId, input.adminUserId);
  }

  return tenantId;
}

export const ONBOARDING_STEPS = [
  { key: 'company', label: 'Confirm company details', screen: 'settings' },
  { key: 'accounts', label: 'Review your chart of accounts', screen: 'accounts' },
  { key: 'bank', label: 'Connect or add a bank account', screen: 'banking' },
  { key: 'customers', label: 'Add your first customer', screen: 'customers' },
  { key: 'invoice', label: 'Create and send an invoice', screen: 'invoices' },
  { key: 'expenses', label: 'Record a bill or expense', screen: 'bills' },
  { key: 'reconcile', label: 'Reconcile your bank account', screen: 'banking' },
  { key: 'reports', label: 'Run your first report', screen: 'reports' },
];

const SAMPLE = {
  customers: [
    { name: 'Northwind Traders', email: 'ap@northwind.example', terms: 30, limit: 1_000_000 },
    { name: 'Bluepeak Studio', email: 'accounts@bluepeak.example', terms: 15, limit: 500_000 },
    { name: 'Accra Digital Works', email: 'finance@accradigital.example', terms: 30, limit: 2_000_000 },
    { name: 'Meridian Consulting', email: 'billing@meridian.example', terms: 30, limit: 750_000 },
    { name: 'Harborline Foods, LLC', email: 'ap@harborline.example', terms: 45, limit: 1_500_000 },
    { name: 'Sunrise Retail Co.', email: 'payables@sunrise.example', terms: 30, limit: 300_000 },
  ],
  vendors: [
    { name: 'Office Depot Ltd', email: 'sales@officedepot.example', terms: 30 },
    { name: 'CloudHost Inc.', email: 'billing@cloudhost.example', terms: 15 },
    { name: 'Ghana Power Co.', email: 'accounts@ghanapower.example', terms: 10 },
    { name: 'Kofi Mensah Consulting', email: 'kofi@kmc.example', terms: 30 },
    { name: 'PrintWorks', email: 'orders@printworks.example', terms: 20 },
  ],
};

export async function seedSampleData(db: DB, tenantId: string, userId: string): Promise<void> {
  const now = new Date().toISOString();
  const baseCurrency = (await db.get<{ base_currency: string }>('SELECT base_currency FROM tenants WHERE id = ?', [tenantId]))?.base_currency ?? 'USD';
  const accountByCode = async (code: string) => {
    const row = await db.get<{ id: string; type: string }>('SELECT id, type FROM accounts WHERE tenant_id = ? AND code = ?', [tenantId, code]);
    return row?.id ?? null;
  };
  const ar = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AR);
  const ap = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.AP);
  const checking = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.CHECKING);
  const openingEquity = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY);
  const taxCode = await db.get<{ id: string }>('SELECT id FROM tax_codes WHERE tenant_id = ? AND code = ?', [tenantId, 'TAX0']);

  // Opening balances: cash and a starting receivable/payable position.
  const openingDate = daysAgo(120);
  await postJournal(db, {
    tenantId,
    date: openingDate,
    memo: 'Opening balances',
    sourceType: 'opening',
    currency: baseCurrency,
    createdBy: userId,
    lines: [
      { accountId: checking.id, debit: 4_500_000, description: 'Opening bank balance' },
      { accountId: ar.id, debit: 1_200_000, description: 'Opening receivables' },
      { accountId: ap.id, credit: 640_000, description: 'Opening payables' },
      { accountId: openingEquity.id, credit: 5_060_000, description: 'Opening balance equity' },
    ],
  });

  const customers: Array<{ id: string; name: string }> = [];
  for (const customer of SAMPLE.customers) {
    const id = newId();
    await db.run(
      `INSERT INTO contacts (id, tenant_id, kind, name, company_name, email, billing_address_json, payment_terms_days, credit_limit, currency, is_active, created_at, updated_at)
       VALUES (?, ?, 'customer', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        tenantId,
        customer.name,
        customer.name,
        customer.email,
        JSON.stringify({ line1: '12 Commerce Street', city: 'Accra', region: 'Greater Accra', country: 'GH', postalCode: 'GA-123' }),
        customer.terms,
        customer.limit,
        baseCurrency,
        now,
        now,
      ],
    );
    customers.push({ id, name: customer.name });
  }

  const vendors: Array<{ id: string; name: string }> = [];
  for (const vendor of SAMPLE.vendors) {
    const id = newId();
    await db.run(
      `INSERT INTO contacts (id, tenant_id, kind, name, company_name, email, billing_address_json, payment_terms_days, credit_limit, currency, is_active, created_at, updated_at)
       VALUES (?, ?, 'vendor', ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
      [id, tenantId, vendor.name, vendor.name, vendor.email, JSON.stringify({ line1: '9 Industrial Road', city: 'Accra', country: 'GH' }), vendor.terms, baseCurrency, now, now],
    );
    vendors.push({ id, name: vendor.name });
  }

  // Inventory items
  const inventoryItems = [
    { sku: 'WIDGET-01', name: 'Widget Pro', price: 12_000, cost: 7_500, qty: 120 },
    { sku: 'GADGET-02', name: 'Gadget Mini', price: 8_500, cost: 4_900, qty: 75 },
    { sku: 'CABLE-03', name: 'USB-C Cable 2m', price: 2_500, cost: 1_100, qty: 300 },
  ];
  const income = await accountByCode('4000');
  const inventoryAsset = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.INVENTORY_ASSET);
  const cogs = await systemAccount(db, tenantId, SYSTEM_ACCOUNTS.COGS);
  for (const item of inventoryItems) {
    await db.run(
      `INSERT INTO items (id, tenant_id, sku, name, description, item_type, sales_price, purchase_cost, income_account_id, expense_account_id,
         inventory_asset_account_id, tax_code_id, quantity_on_hand, reorder_point, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'inventory', ?, ?, ?, ?, ?, ?, ?, 20, 1, ?, ?)`,
      [newId(), tenantId, item.sku, item.name, `${item.name} (stock item)`, item.price, item.cost, income, cogs.id, inventoryAsset.id, taxCode?.id ?? null, item.qty, now, now],
    );
  }

  // Opening inventory value
  await postJournal(db, {
    tenantId,
    date: openingDate,
    memo: 'Opening inventory',
    sourceType: 'opening',
    currency: baseCurrency,
    createdBy: userId,
    lines: [
      { accountId: inventoryAsset.id, debit: 120 * 7_500 + 75 * 4_900 + 300 * 1_100, description: 'Opening stock' },
      { accountId: openingEquity.id, credit: 120 * 7_500 + 75 * 4_900 + 300 * 1_100, description: 'Opening stock' },
    ],
  });
  for (const item of inventoryItems) {
    const row = await db.get<{ id: string }>('SELECT id FROM items WHERE tenant_id = ? AND sku = ?', [tenantId, item.sku]);
    if (!row) continue;
    await db.run(
      `INSERT INTO inventory_movements (id, tenant_id, item_id, date, movement_type, quantity, unit_cost, total_cost, created_at)
       VALUES (?, ?, ?, ?, 'opening', ?, ?, ?, ?)`,
      [newId(), tenantId, row.id, openingDate, item.qty, item.cost, item.qty * item.cost, now],
    );
  }

  // Invoices across a 120 day window
  const invoiceSpecs: Array<{
    customer: number;
    days: number;
    dueDays: number;
    lines: Array<{ description: string; qty: number; price: number; acct: string; tax: string; sku?: string }>;
    pay: 'full' | 'partial' | null;
    payDays?: number;
    payAmount?: number;
  }> = [
    { customer: 0, days: 100, dueDays: 70, lines: [{ description: 'Enterprise onboarding', qty: 1, price: 240_000, acct: '4100', tax: 'VAT15' }], pay: 'full', payDays: 80 },
    { customer: 1, days: 52, dueDays: 37, lines: [{ description: 'Brand identity package', qty: 1, price: 115_000, acct: '4100', tax: 'VAT15' }], pay: null },
    { customer: 2, days: 38, dueDays: 8, lines: [{ description: 'Software development retainer', qty: 1, price: 360_000, acct: '4100', tax: 'ST7' }], pay: 'partial', payAmount: 100_000, payDays: 20 },
    { customer: 3, days: 22, dueDays: -8, lines: [{ description: 'Advisory workshop', qty: 2, price: 42_500, acct: '4100', tax: 'VAT15' }], pay: null },
    { customer: 4, days: 12, dueDays: -33, lines: [{ description: 'Cold chain logistics audit', qty: 1, price: 280_000, acct: '4100', tax: 'VAT15' }], pay: null },
    { customer: 5, days: 6, dueDays: 24, lines: [{ description: 'Widget Pro', qty: 10, price: 12_000, acct: '4000', tax: 'ST7', sku: 'WIDGET-01' }], pay: null },
    { customer: 0, days: 3, dueDays: 27, lines: [{ description: 'Support plan (annual)', qty: 1, price: 96_000, acct: '4100', tax: 'TAX0' }], pay: null },
  ];

  for (const spec of invoiceSpecs) {
    const customer = customers[spec.customer];
    const lines = [] as Array<{ description: string; quantity: number; unitPrice: number; accountId: string | null; taxCodeId: string | null; itemId?: string | null }>;
    for (const line of spec.lines) {
      const item = line.sku
        ? await db.get<{ id: string }>('SELECT id FROM items WHERE tenant_id = ? AND sku = ?', [tenantId, line.sku])
        : null;
      const tax = await db.get<{ id: string }>('SELECT id FROM tax_codes WHERE tenant_id = ? AND code = ?', [tenantId, line.tax]);
      lines.push({
        description: line.description,
        quantity: line.qty,
        unitPrice: line.price,
        accountId: await accountByCode(line.acct),
        taxCodeId: tax?.id ?? null,
        itemId: item?.id ?? null,
      });
    }
    const dueDate = daysAgo(spec.days - 30);
    const id = await createInvoice(db, tenantId, userId, {
      contactId: customer.id,
      issueDate: daysAgo(spec.days),
      dueDate,
      lines,
      memo: `Work delivered for ${customer.name}`,
      terms: 'Net 30. Late payments may incur interest.',
      status: 'sent',
    });
    if (spec.pay === 'full' || spec.pay === 'partial') {
      const invoice = await db.get<{ total: number }>('SELECT total FROM invoices WHERE id = ?', [id]);
      const amount = spec.pay === 'full' ? Number(invoice?.total ?? 0) : Number(spec.payAmount ?? 0);
      await recordPayment(db, tenantId, userId, {
        direction: 'receipt',
        contactId: customer.id,
        date: daysAgo(spec.payDays ?? 0),
        amount,
        method: 'bank_transfer',
        depositAccountId: checking.id,
        reference: `WIRE-${Math.floor(Math.random() * 900000 + 100000)}`,
        applications: [{ invoiceId: id, amount }],
      });
    }
  }

  // Credit memo for a service issue
  await createInvoice(db, tenantId, userId, {
    contactId: customers[2].id,
    kind: 'credit_memo',
    issueDate: daysAgo(7),
    lines: [{ description: 'Service credit — outage on the 3rd', quantity: 1, unitPrice: 15_000, accountId: await accountByCode('4100'), taxCodeId: taxCode?.id ?? null }],
    memo: 'Goodwill credit',
    autoPost: true,
  });

  // Estimates
  await createInvoice(db, tenantId, userId, {
    contactId: customers[4].id,
    kind: 'estimate',
    issueDate: daysAgo(4),
    lines: [{ description: 'Warehouse expansion (phase 2)', quantity: 1, unitPrice: 1_250_000, accountId: await accountByCode('4100'), taxCodeId: taxCode?.id ?? null }],
    memo: 'Valid for 30 days',
  });

  // Bills
  const billSpecs = [
    { vendor: 0, days: 44, due: 26, lines: [{ description: 'Office furniture', qty: 1, price: 43_000, acct: '6400' }], paid: false },
    { vendor: 1, days: 20, due: -5, lines: [{ description: 'Cloud hosting — monthly', qty: 1, price: 29_900, acct: '6500' }], paid: false },
    { vendor: 2, days: 12, due: 3, lines: [{ description: 'Electricity', qty: 1, price: 18_500, acct: '6300' }], paid: false },
    { vendor: 4, days: 26, due: 8, lines: [{ description: 'Printed brochures', qty: 500, price: 156, acct: '6000' }], paid: true },
  ];
  for (const spec of billSpecs) {
    const vendor = vendors[spec.vendor];
    const accountId = await accountByCode(spec.lines[0].acct);
    const id = await createBill(db, tenantId, userId, {
      vendorId: vendor.id,
      issueDate: daysAgo(spec.days),
      dueDate: daysAgo(spec.due),
      status: 'open',
      lines: spec.lines.map((l) => ({
        description: l.description,
        quantity: l.qty,
        unitPrice: l.price,
        accountId,
      })),
    });
    const bill = await db.get<{ total: number; number: string }>('SELECT total, number FROM bills WHERE id = ?', [id]);
    if (spec.paid && bill) {
      await recordPayment(db, tenantId, userId, {
        direction: 'disbursement',
        contactId: vendor.id,
        date: daysAgo(Math.max(1, spec.due - 2)),
        amount: Number(bill.total),
        method: 'ach',
        depositAccountId: checking.id,
        reference: `ACH-${Math.floor(Math.random() * 900000 + 100000)}`,
        applications: [{ billId: id, amount: Number(bill.total) }],
      });
    }
  }

  // Expenses
  const travel = await accountByCode('6700');
  const supplies = await accountByCode('6400');
  if (travel && supplies) {
    const expenseId = await createExpense(db, tenantId, userId, {
      date: daysAgo(9),
      memo: 'Client visit — Kumasi',
      paymentMethod: 'personal_card',
      status: 'approved',
      lines: [
        { accountId: travel, description: 'Flights', amount: 32_000 },
        { accountId: travel, description: 'Hotel', amount: 45_000 },
      ],
    });
    await db.run(`UPDATE expenses SET employee_id = NULL WHERE id = ?`, [expenseId]);
    await createExpense(db, tenantId, userId, {
      date: daysAgo(2),
      memo: 'Printer paper and toner',
      status: 'submitted',
      lines: [{ accountId: supplies, description: 'Office supplies', amount: 12_400 }],
    });
  }

  // Bank feed: deposits, withdrawals and a few unmatched items
  const bank = await db.get<{ id: string }>("SELECT id FROM bank_accounts WHERE tenant_id = ? AND name = 'Business Checking'", [tenantId]);
  if (bank) {
    const transactions: Array<[number, string, string, number]> = [
      [80, 'NORTHWIND TRADERS WIRE IN', 'Northwind Traders', 276_000],
      [60, 'ACH CREDIT ACCRA DIGITAL', 'Accra Digital Works', 100_000],
      [44, 'OFFICE DEPOT LTD', 'Office Depot Ltd', -43_000],
      [26, 'PRINTWORKS ORDER 8812', 'PrintWorks', -78_000],
      [20, 'CLOUDHOST INC MONTHLY', 'CloudHost Inc.', -29_900],
      [18, 'STRIPE TRANSFER', 'Stripe', 84_500],
      [12, 'GHANA POWER CO PREPAID', 'Ghana Power Co.', -18_500],
      [9, 'AWS EMEA SARL', 'Amazon Web Services', -12_250],
      [7, 'MOBILE MONEY DEPOSIT', 'MTN MoMo', 45_000],
      [5, 'KOFI MENSAH CONSULTING', 'Kofi Mensah Consulting', -55_000],
      [3, 'BANK CHARGE', 'First National Bank', -1_800],
      [2, 'CUSTOMER REFUND', 'Bluepeak Studio', -8_000],
      [1, 'STRIPE PAYOUT', 'Stripe', 32_400],
    ];
    let index = 0;
    for (const [days, description, payee, amount] of transactions) {
      index += 1;
      await db.run(
        `INSERT INTO bank_transactions (id, tenant_id, bank_account_id, date, description, payee, amount, currency, status, match_type,
           import_batch, external_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', NULL, 'sample', ?, ?)`,
        [newId(), tenantId, bank.id, daysAgo(days), description, payee, amount, baseCurrency, `sample-${index}`, now],
      );
    }
  }

  // Employees and timesheets
  const employees = [
    { no: 'EMP-001', name: 'Ama Owusu', email: 'ama@example.com', salary: 6_000_000 },
    { no: 'EMP-002', name: 'Daniel Boateng', email: 'daniel@example.com', salary: 4_800_000 },
    { no: 'EMP-003', name: 'Sophia Lamptey', email: 'sophia@example.com', salary: 5_400_000 },
  ];
  for (const employee of employees) {
    const id = newId();
    await db.run(
      `INSERT INTO employees (id, tenant_id, employee_no, name, email, pay_type, pay_rate, pay_frequency, hire_date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'salary', ?, 'monthly', ?, 'active', ?)`,
      [id, tenantId, employee.no, employee.name, employee.email, employee.salary, daysAgo(400), now],
    );
    for (let week = 0; week < 2; week += 1) {
      for (let day = 0; day < 5; day += 1) {
        await db.run(
          `INSERT INTO timesheets (id, tenant_id, employee_id, work_date, hours, project, billable, rate, description, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'Client delivery', 1, ?, 'Delivery work', 'approved', ?)`,
          [newId(), tenantId, id, daysAgo(week * 7 + day + 1), 8, 3_500, now],
        );
      }
    }
  }
}
