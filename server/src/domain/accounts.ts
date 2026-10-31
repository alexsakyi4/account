/**
 * Chart of accounts templates.
 *
 * Accounts referenced by the posting engine carry a stable `systemKey` so
 * automation never depends on account numbers (users can renumber freely).
 */
export interface AccountTemplate {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype: string;
  parentCode?: string;
  systemKey?: string;
  description?: string;
}

export const SYSTEM_ACCOUNTS = {
  AR: 'accounts_receivable',
  AP: 'accounts_payable',
  UNDEPOSITED_FUNDS: 'undeposited_funds',
  INVENTORY_ASSET: 'inventory_asset',
  SALES_TAX_PAYABLE: 'sales_tax_payable',
  PAYROLL_LIABILITIES: 'payroll_liabilities',
  PAYROLL_EXPENSE: 'payroll_expense',
  PAYROLL_TAX_EXPENSE: 'payroll_tax_expense',
  SALES_INCOME: 'sales_income',
  SERVICE_INCOME: 'service_income',
  DISCOUNTS: 'discounts',
  COGS: 'cogs',
  INVENTORY_ADJUSTMENT: 'inventory_adjustment',
  MERCHANT_FEES: 'merchant_fees',
  FX_GAIN_LOSS: 'fx_gain_loss',
  RETAINED_EARNINGS: 'retained_earnings',
  OPENING_BALANCE_EQUITY: 'opening_balance_equity',
  UNCATEGORIZED_EXPENSE: 'uncategorized_expense',
  CHECKING: 'checking',
} as const;

const BASE_ACCOUNTS: AccountTemplate[] = [
  // Assets
  { code: '1000', name: 'Cash on Hand', type: 'asset', subtype: 'cash' },
  { code: '1010', name: 'Business Checking', type: 'asset', subtype: 'bank', systemKey: SYSTEM_ACCOUNTS.CHECKING },
  { code: '1020', name: 'Savings Account', type: 'asset', subtype: 'bank' },
  {
    code: '1090',
    name: 'Undeposited Funds',
    type: 'asset',
    subtype: 'other_current_asset',
    systemKey: SYSTEM_ACCOUNTS.UNDEPOSITED_FUNDS,
    description: 'Payments received but not yet taken to the bank',
  },
  {
    code: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    subtype: 'accounts_receivable',
    systemKey: SYSTEM_ACCOUNTS.AR,
  },
  {
    code: '1200',
    name: 'Inventory Asset',
    type: 'asset',
    subtype: 'inventory',
    systemKey: SYSTEM_ACCOUNTS.INVENTORY_ASSET,
  },
  { code: '1300', name: 'Prepaid Expenses', type: 'asset', subtype: 'other_current_asset' },
  { code: '1400', name: 'Equipment', type: 'asset', subtype: 'fixed_asset' },
  { code: '1500', name: 'Furniture & Fixtures', type: 'asset', subtype: 'fixed_asset' },
  { code: '1600', name: 'Accumulated Depreciation', type: 'asset', subtype: 'contra_asset' },

  // Liabilities
  { code: '2000', name: 'Accounts Payable', type: 'liability', subtype: 'accounts_payable', systemKey: SYSTEM_ACCOUNTS.AP },
  { code: '2050', name: 'Credit Card Payable', type: 'liability', subtype: 'credit_card' },
  { code: '2100', name: 'Accrued Liabilities', type: 'liability', subtype: 'other_current_liability' },
  {
    code: '2200',
    name: 'Sales Tax Payable',
    type: 'liability',
    subtype: 'other_current_liability',
    systemKey: SYSTEM_ACCOUNTS.SALES_TAX_PAYABLE,
  },
  {
    code: '2210',
    name: 'Payroll Liabilities',
    type: 'liability',
    subtype: 'other_current_liability',
    systemKey: SYSTEM_ACCOUNTS.PAYROLL_LIABILITIES,
  },
  { code: '2300', name: 'Notes Payable', type: 'liability', subtype: 'long_term_liability' },
  { code: '2400', name: 'Customer Deposits', type: 'liability', subtype: 'other_current_liability' },

  // Equity
  { code: '3000', name: "Owner's Equity", type: 'equity', subtype: 'owner_equity' },
  { code: '3100', name: "Owner's Draw", type: 'equity', subtype: 'owner_equity' },
  {
    code: '3200',
    name: 'Retained Earnings',
    type: 'equity',
    subtype: 'retained_earnings',
    systemKey: SYSTEM_ACCOUNTS.RETAINED_EARNINGS,
  },
  {
    code: '3900',
    name: 'Opening Balance Equity',
    type: 'equity',
    subtype: 'opening_balance_equity',
    systemKey: SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY,
  },

  // Income
  { code: '4000', name: 'Sales of Goods', type: 'income', subtype: 'operating_income', systemKey: SYSTEM_ACCOUNTS.SALES_INCOME },
  { code: '4100', name: 'Service Income', type: 'income', subtype: 'operating_income', systemKey: SYSTEM_ACCOUNTS.SERVICE_INCOME },
  { code: '4200', name: 'Shipping Income', type: 'income', subtype: 'operating_income' },
  { code: '4900', name: 'Discounts Given', type: 'income', subtype: 'contra_income', systemKey: SYSTEM_ACCOUNTS.DISCOUNTS },
  { code: '4950', name: 'Other Income', type: 'income', subtype: 'other_income' },

  // Cost of goods sold
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', subtype: 'cost_of_goods_sold', systemKey: SYSTEM_ACCOUNTS.COGS },
  { code: '5050', name: 'Freight & Delivery', type: 'expense', subtype: 'cost_of_goods_sold' },
  {
    code: '5100',
    name: 'Inventory Adjustments',
    type: 'expense',
    subtype: 'cost_of_goods_sold',
    systemKey: SYSTEM_ACCOUNTS.INVENTORY_ADJUSTMENT,
  },

  // Operating expenses
  { code: '6000', name: 'Advertising & Marketing', type: 'expense', subtype: 'operating_expense' },
  { code: '6100', name: 'Salaries & Wages', type: 'expense', subtype: 'payroll', systemKey: SYSTEM_ACCOUNTS.PAYROLL_EXPENSE },
  { code: '6150', name: 'Payroll Tax Expense', type: 'expense', subtype: 'payroll', systemKey: SYSTEM_ACCOUNTS.PAYROLL_TAX_EXPENSE },
  { code: '6200', name: 'Rent', type: 'expense', subtype: 'operating_expense' },
  { code: '6300', name: 'Utilities', type: 'expense', subtype: 'operating_expense' },
  { code: '6400', name: 'Office Supplies', type: 'expense', subtype: 'operating_expense' },
  { code: '6500', name: 'Software & Subscriptions', type: 'expense', subtype: 'operating_expense' },
  {
    code: '6600',
    name: 'Bank & Merchant Fees',
    type: 'expense',
    subtype: 'operating_expense',
    systemKey: SYSTEM_ACCOUNTS.MERCHANT_FEES,
  },
  { code: '6700', name: 'Travel', type: 'expense', subtype: 'operating_expense' },
  { code: '6800', name: 'Insurance', type: 'expense', subtype: 'operating_expense' },
  { code: '6900', name: 'Professional Fees', type: 'expense', subtype: 'operating_expense' },
  { code: '6950', name: 'Depreciation Expense', type: 'expense', subtype: 'operating_expense' },
  { code: '7000', name: 'Interest Expense', type: 'expense', subtype: 'other_expense' },
  {
    code: '7900',
    name: 'Exchange Rate Gain / Loss',
    type: 'expense',
    subtype: 'other_expense',
    systemKey: SYSTEM_ACCOUNTS.FX_GAIN_LOSS,
  },
  {
    code: '8000',
    name: 'Uncategorized Expense',
    type: 'expense',
    subtype: 'operating_expense',
    systemKey: SYSTEM_ACCOUNTS.UNCATEGORIZED_EXPENSE,
  },
];

const INDUSTRY_ACCOUNTS: Record<string, AccountTemplate[]> = {
  general: [],
  retail: [
    { code: '4300', name: 'Retail Sales', type: 'income', subtype: 'operating_income' },
    { code: '5150', name: 'Inventory Shrinkage', type: 'expense', subtype: 'cost_of_goods_sold' },
    { code: '6210', name: 'Store Supplies', type: 'expense', subtype: 'operating_expense' },
  ],
  services: [
    { code: '4150', name: 'Consulting Income', type: 'income', subtype: 'operating_income' },
    { code: '6750', name: 'Subcontractors', type: 'expense', subtype: 'operating_expense' },
  ],
  construction: [
    { code: '4400', name: 'Contract Revenue', type: 'income', subtype: 'operating_income' },
    { code: '5700', name: 'Subcontractor Costs', type: 'expense', subtype: 'cost_of_goods_sold' },
    { code: '5710', name: 'Job Materials', type: 'expense', subtype: 'cost_of_goods_sold' },
    { code: '6800', name: 'Equipment Rental', type: 'expense', subtype: 'operating_expense' },
  ],
  nonprofit: [
    { code: '4600', name: 'Grants & Donations', type: 'income', subtype: 'operating_income' },
    { code: '4700', name: 'Fundraising Income', type: 'income', subtype: 'operating_income' },
  ],
  restaurant: [
    { code: '4350', name: 'Food & Beverage Sales', type: 'income', subtype: 'operating_income' },
    { code: '5300', name: 'Food & Beverage Cost', type: 'expense', subtype: 'cost_of_goods_sold' },
    { code: '6320', name: 'Kitchen Supplies', type: 'expense', subtype: 'operating_expense' },
  ],
  technology: [
    { code: '4250', name: 'Subscription Revenue', type: 'income', subtype: 'operating_income' },
    { code: '6960', name: 'Hosting & Infrastructure', type: 'expense', subtype: 'operating_expense' },
  ],
  freelance: [
    { code: '4150', name: 'Consulting Income', type: 'income', subtype: 'operating_income' },
    { code: '6500', name: 'Software & Subscriptions', type: 'expense', subtype: 'operating_expense' },
  ],
};

export const INDUSTRIES = Object.keys(INDUSTRY_ACCOUNTS);

export function chartTemplate(industry: string): AccountTemplate[] {
  const extras = INDUSTRY_ACCOUNTS[industry] ?? INDUSTRY_ACCOUNTS.general;
  const byCode = new Map(BASE_ACCOUNTS.map((a) => [a.code, a]));
  for (const account of extras) {
    if (!byCode.has(account.code)) byCode.set(account.code, account);
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function normalBalanceFor(type: string): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

export function isDebitNormal(type: string): boolean {
  return normalBalanceFor(type) === 'debit';
}

/** Account type ordering used by the balance sheet and P&L. */
export const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
