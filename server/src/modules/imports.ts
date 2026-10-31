/**
 * CSV import engine with a mapping + dry-run workflow.
 *
 * Templates follow the column names used by common accounting exports
 * (QuickBooks Online "Customer Contact List", "Chart of Accounts", "Invoice
 * List", "Bill List", plus 1-2-3 column bank statements) so a bookkeeper can
 * export from another system and import here without editing the file.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../db/driver.js';
import { csvToObjects, toCsv } from '../lib/csv.js';
import { toMinor } from '../lib/money.js';
import { badRequest } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { emitEvent } from '../services/events.js';
import { createBill, createInvoice } from '../services/documents.js';

export const IMPORT_KINDS = ['accounts', 'customers', 'vendors', 'items', 'invoices', 'bills', 'journal', 'bank'] as const;
type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_TEMPLATES: Record<ImportKind, { label: string; description: string; columns: string[]; sample: Record<string, string>[] }> = {
  accounts: {
    label: 'Chart of accounts',
    description: 'Account list with type and number. Matches the QuickBooks "Chart of Accounts" export.',
    columns: ['Account Number', 'Account Name', 'Type', 'Detail Type', 'Description', 'Balance'],
    sample: [
      { 'Account Number': '1010', 'Account Name': 'Business Checking', Type: 'Bank', 'Detail Type': 'Checking', Description: 'Operating account', Balance: '12500.00' },
      { 'Account Number': '4010', 'Account Name': 'Consulting Revenue', Type: 'Income', 'Detail Type': 'Service/Fee Income', Description: '', Balance: '0' },
    ],
  },
  customers: {
    label: 'Customers',
    description: 'Customer contact list with billing address and payment terms.',
    columns: ['Customer', 'Company Name', 'Email', 'Phone', 'Billing Address Line 1', 'Billing Address City', 'Billing Address Postal Code', 'Billing Address Country', 'Terms', 'Credit Limit', 'Currency', 'Notes'],
    sample: [
      {
        Customer: 'Northwind Traders',
        'Company Name': 'Northwind Traders LLC',
        Email: 'ap@northwind.example',
        Phone: '+233 30 000 0000',
        'Billing Address Line 1': '12 Commerce Street',
        'Billing Address City': 'Accra',
        'Billing Address Postal Code': 'GA-123',
        'Billing Address Country': 'GH',
        Terms: 'Net 30',
        'Credit Limit': '5000.00',
        Currency: 'USD',
        Notes: '',
      },
    ],
  },
  vendors: {
    label: 'Vendors',
    description: 'Supplier contact list.',
    columns: ['Vendor', 'Company Name', 'Email', 'Phone', 'Billing Address Line 1', 'Billing Address City', 'Billing Address Country', 'Terms', 'Currency', 'Notes'],
    sample: [
      {
        Vendor: 'CloudHost Inc.',
        'Company Name': 'CloudHost Inc.',
        Email: 'billing@cloudhost.example',
        Phone: '',
        'Billing Address Line 1': '1 Cloud Way',
        'Billing Address City': 'Austin',
        'Billing Address Country': 'US',
        Terms: 'Net 15',
        Currency: 'USD',
        Notes: '',
      },
    ],
  },
  items: {
    label: 'Products & services',
    description: 'Item list with SKU, price and cost.',
    columns: ['Item Name', 'SKU', 'Type', 'Sales Price', 'Purchase Cost', 'Quantity On Hand', 'Description'],
    sample: [{ 'Item Name': 'Widget Pro', SKU: 'WIDGET-01', Type: 'Inventory', 'Sales Price': '120.00', 'Purchase Cost': '75.00', 'Quantity On Hand': '120', Description: 'Flagship widget' }],
  },
  invoices: {
    label: 'Invoices',
    description: 'One row per invoice line. Rows are grouped by invoice number.',
    columns: ['Invoice Number', 'Customer', 'Invoice Date', 'Due Date', 'Item(Product/Service)', 'Item Quantity', 'Item Rate', 'Item Description', 'Tax Name', 'Currency', 'Memo'],
    sample: [
      {
        'Invoice Number': 'INV-1042',
        Customer: 'Northwind Traders',
        'Invoice Date': '2024-05-01',
        'Due Date': '2024-05-31',
        'Item(Product/Service)': 'Consulting',
        'Item Quantity': '10',
        'Item Rate': '150.00',
        'Item Description': 'Advisory services',
        'Tax Name': 'VAT15',
        Currency: 'USD',
        Memo: 'Imported from previous system',
      },
    ],
  },
  bills: {
    label: 'Bills',
    description: 'One row per bill line, grouped by bill number.',
    columns: ['Bill Number', 'Vendor', 'Bill Date', 'Due Date', 'Account', 'Line Amount', 'Description', 'Tax Amount'],
    sample: [{ 'Bill Number': 'B-2001', Vendor: 'CloudHost Inc.', 'Bill Date': '2024-05-02', 'Due Date': '2024-05-17', Account: '6500', 'Line Amount': '299.00', Description: 'Hosting', 'Tax Amount': '0' }],
  },
  journal: {
    label: 'Journal entries',
    description: 'Trial balance style import: one row per journal line, grouped by journal number.',
    columns: ['Journal Number', 'Journal Date', 'Account', 'Debit', 'Credit', 'Description', 'Name'],
    sample: [{ 'Journal Number': 'JE-1', 'Journal Date': '2024-01-01', Account: '1010', Debit: '5000.00', Credit: '', Description: 'Opening bank balance', Name: '' }],
  },
  bank: {
    label: 'Bank statement',
    description: 'Statement lines for the reconciliation workflow.',
    columns: ['Date', 'Description', 'Amount'],
    sample: [
      { Date: '2024-05-03', Description: 'NORTHWIND TRADERS WIRE IN', Amount: '2400.00' },
      { Date: '2024-05-05', Description: 'OFFICE DEPOT', Amount: '-430.00' },
    ],
  },
};

type Row = Record<string, string>;

function detectColumn(available: string[], candidates: string[]): string | undefined {
  const normalized = available.map((c) => ({ raw: c, key: c.toLowerCase().replace(/[^a-z0-9]/g, '') }));
  for (const candidate of candidates) {
    const match = normalized.find((c) => c.key === candidate);
    if (match) return match.raw;
  }
  for (const candidate of candidates) {
    const match = normalized.find((c) => c.key.includes(candidate));
    if (match) return match.raw;
  }
  return undefined;
}

export function suggestMapping(kind: ImportKind, headers: string[]): Record<string, string> {
  const common: Record<string, string[]> = { date: ['date', 'invoicedate', 'billdate', 'journaldate', 'transactiondate'] };
  const map: Record<ImportKind, Record<string, string[]>> = {
    accounts: {
      accountNumber: ['accountnumber', 'number', 'code'],
      accountName: ['accountname', 'name'],
      type: ['type', 'accounttype'],
      detailType: ['detailtype', 'detail'],
      description: ['description'],
      balance: ['balance', 'openingbalance'],
    },
    customers: {
      name: ['customer', 'customername', 'name'],
      companyName: ['companyname', 'company'],
      email: ['email', 'emailaddress'],
      phone: ['phone', 'phonenumber'],
      addressLine1: ['billingaddressline1', 'addressline1', 'address'],
      city: ['billingaddresscity', 'city'],
      postalCode: ['billingaddresspostalcode', 'postalcode', 'zip'],
      country: ['billingaddresscountry', 'country'],
      terms: ['terms', 'paymentterms'],
      creditLimit: ['creditlimit'],
      currency: ['currency'],
    },
    vendors: {
      name: ['vendor', 'vendorname', 'name'],
      companyName: ['companyname'],
      email: ['email', 'emailaddress'],
      phone: ['phone'],
      addressLine1: ['billingaddressline1', 'addressline1'],
      city: ['billingaddresscity', 'city'],
      country: ['billingaddresscountry', 'country'],
      terms: ['terms'],
      currency: ['currency'],
    },
    items: {
      name: ['itemname', 'name', 'productservice'],
      sku: ['sku', 'itemsku'],
      type: ['type', 'itemtype'],
      salesPrice: ['salesprice', 'price', 'rate'],
      purchaseCost: ['purchasecost', 'cost'],
      quantityOnHand: ['quantityonhand', 'qtyonhand', 'quantity'],
      description: ['description', 'salesdescription'],
    },
    invoices: {
      number: ['invoicenumber', 'number', 'invoice'],
      customer: ['customer', 'customername'],
      date: common.date,
      dueDate: ['duedate'],
      itemName: ['itemproductservice', 'item', 'productservice'],
      quantity: ['itemquantity', 'quantity', 'qty'],
      rate: ['itemrate', 'rate', 'price'],
      description: ['itemdescription', 'description', 'memo'],
      taxName: ['taxname', 'tax'],
      currency: ['currency'],
    },
    bills: {
      number: ['billnumber', 'number'],
      vendor: ['vendor', 'vendorname'],
      date: common.date,
      dueDate: ['duedate'],
      account: ['account', 'accountnumber', 'expenseaccount'],
      amount: ['lineamount', 'amount'],
      description: ['description', 'memo'],
      taxAmount: ['taxamount', 'tax'],
    },
    journal: {
      number: ['journalnumber', 'number'],
      date: common.date,
      account: ['account', 'accountnumber', 'accountname'],
      debit: ['debit'],
      credit: ['credit'],
      description: ['description', 'memo'],
    },
    bank: {
      date: common.date,
      description: ['description', 'memo', 'payee', 'narrative'],
      amount: ['amount', 'transactionamount'],
      debit: ['debit', 'withdrawal'],
      credit: ['credit', 'deposit'],
    },
  };
  const result: Record<string, string> = {};
  for (const [field, candidates] of Object.entries(map[kind])) {
    const found = detectColumn(headers, candidates);
    if (found) result[field] = found;
  }
  return result;
}

function parseTerms(value: string | undefined): number {
  if (!value) return 30;
  const digits = value.match(/\d+/);
  if (digits) return Number(digits[0]);
  return 30;
}

function normaliseType(value: string): string {
  const v = (value ?? '').toLowerCase();
  if (v.includes('bank')) return 'asset';
  if (v.includes('other current asset')) return 'asset';
  if (v.includes('fixed asset') || v.includes('equipment')) return 'asset';
  if (v.includes('accounts receivable')) return 'asset';
  if (v.includes('inventory')) return 'asset';
  if (v.includes('payable')) return 'liability';
  if (v.includes('credit card') || v.includes('liab')) return 'liability';
  if (v.includes('equity')) return 'equity';
  if (v.includes('income') || v.includes('revenue')) return 'income';
  if (v.includes('cost of goods')) return 'expense';
  if (v.includes('expense')) return 'expense';
  return 'expense';
}

interface PreviewResult {
  kind: ImportKind;
  headers: string[];
  mapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  errors: Array<{ row: number; message: string }>;
  preview: Array<Record<string, unknown>>;
}

async function validate(
  db: FastifyInstance['db'],
  tenantId: string,
  kind: ImportKind,
  rows: Row[],
  mapping: Record<string, string>,
): Promise<PreviewResult> {
  const errors: Array<{ row: number; message: string }> = [];
  const preview: Array<Record<string, unknown>> = [];
  let valid = 0;
  const accountCache = new Map<string, string | null>();
  const contactCache = new Map<string, string | null>();

  const findAccount = async (value: string): Promise<string | null> => {
    if (!value) return null;
    if (accountCache.has(value)) return accountCache.get(value)!;
    const account = await db.get<{ id: string }>(
      'SELECT id FROM accounts WHERE tenant_id = ? AND (code = ? OR LOWER(name) = ?)',
      [tenantId, value.trim(), value.trim().toLowerCase()],
    );
    accountCache.set(value, account?.id ?? null);
    return account?.id ?? null;
  };
  const findContact = async (value: string, kindFilter: 'customer' | 'vendor'): Promise<string | null> => {
    const key = `${kindFilter}:${value}`;
    if (contactCache.has(key)) return contactCache.get(key)!;
    const contact = await db.get<{ id: string }>(
      'SELECT id FROM contacts WHERE tenant_id = ? AND LOWER(name) = ? AND kind IN (?, \'both\')',
      [tenantId, value.trim().toLowerCase(), kindFilter],
    );
    contactCache.set(key, contact?.id ?? null);
    return contact?.id ?? null;
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 2;
    try {
      if (kind === 'accounts') {
        const code = row[mapping.accountNumber ?? ''] ?? '';
        const name = row[mapping.accountName ?? ''] ?? '';
        if (!name) throw new Error('Account name is required');
        const finalCode = code || String(1000 + index);
        const exists = await db.get('SELECT id FROM accounts WHERE tenant_id = ? AND code = ?', [tenantId, finalCode]);
        if (exists) throw new Error(`Account code ${finalCode} already exists`);
        valid += 1;
        preview.push({ code: finalCode, name, type: normaliseType(row[mapping.type ?? ''] ?? ''), balance: row[mapping.balance ?? ''] ?? '' });
      } else if (kind === 'customers' || kind === 'vendors') {
        const name = row[mapping.name ?? ''] ?? '';
        if (!name) throw new Error('Name is required');
        const exists = await db.get('SELECT id FROM contacts WHERE tenant_id = ? AND LOWER(name) = ?', [tenantId, name.toLowerCase()]);
        if (exists) throw new Error(`${name} already exists`);
        const email = row[mapping.email ?? ''] ?? '';
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Invalid email "${email}"`);
        valid += 1;
        preview.push({ name, kind: kind === 'customers' ? 'customer' : 'vendor', email, terms: parseTerms(row[mapping.terms ?? '']) });
      } else if (kind === 'items') {
        const name = row[mapping.name ?? ''] ?? '';
        const sku = row[mapping.sku ?? ''] ?? '';
        if (!name) throw new Error('Item name is required');
        valid += 1;
        preview.push({ name, sku: sku || `SKU-${index + 1}`, salesPrice: row[mapping.salesPrice ?? ''] ?? '' });
      } else if (kind === 'invoices') {
        const number = row[mapping.number ?? ''] ?? '';
        const customer = row[mapping.customer ?? ''] ?? '';
        if (!number) throw new Error('Invoice number is required');
        if (!customer) throw new Error('Customer is required');
        const contactId = await findContact(customer, 'customer');
        if (!contactId) throw new Error(`Customer "${customer}" not found — import customers first`);
        const qty = Number(row[mapping.quantity ?? ''] || 1);
        const rate = toMinor(row[mapping.rate ?? ''] ?? '0');
        if (!rate) throw new Error('Line rate is required');
        valid += 1;
        preview.push({ number, customer, date: row[mapping.date ?? ''] ?? '', quantity: qty, rate: (rate / 100).toFixed(2) });
      } else if (kind === 'bills') {
        const number = row[mapping.number ?? ''] ?? '';
        const vendor = row[mapping.vendor ?? ''] ?? '';
        if (!number) throw new Error('Bill number is required');
        const contactId = await findContact(vendor, 'vendor');
        if (!contactId) throw new Error(`Vendor "${vendor}" not found — import vendors first`);
        const amount = toMinor(row[mapping.amount ?? ''] ?? '0');
        if (!amount) throw new Error('Line amount is required');
        const accountId = await findAccount(row[mapping.account ?? ''] ?? '');
        if (!accountId) throw new Error(`Expense account "${row[mapping.account ?? '']}" not found`);
        valid += 1;
        preview.push({ number, vendor, amount: (amount / 100).toFixed(2) });
      } else if (kind === 'journal') {
        const account = row[mapping.account ?? ''] ?? '';
        const accountId = await findAccount(account);
        if (!accountId) throw new Error(`Account "${account}" not found`);
        const debit = toMinor(row[mapping.debit ?? ''] ?? '0');
        const credit = toMinor(row[mapping.credit ?? ''] ?? '0');
        if (!debit && !credit) throw new Error('Each row needs a debit or a credit');
        if (debit && credit) throw new Error('A line cannot have both a debit and a credit');
        valid += 1;
        preview.push({ date: row[mapping.date ?? ''] ?? '', account, debit: (debit / 100).toFixed(2), credit: (credit / 100).toFixed(2) });
      } else if (kind === 'bank') {
        const date = row[mapping.date ?? ''] ?? '';
        if (!date) throw new Error('Date is required');
        const amount = mapping.amount
          ? toMinor(row[mapping.amount] ?? '0')
          : toMinor(row[mapping.credit ?? ''] ?? '0') - toMinor(row[mapping.debit ?? ''] ?? '0');
        if (!amount) throw new Error('Amount is required');
        valid += 1;
        preview.push({ date, description: row[mapping.description ?? ''] ?? '', amount: (amount / 100).toFixed(2) });
      }
    } catch (err) {
      errors.push({ row: rowNumber, message: (err as Error).message });
    }
  }

  return {
    kind,
    headers: rows.length ? Object.keys(rows[0]) : [],
    mapping,
    totalRows: rows.length,
    validRows: valid,
    errors: errors.slice(0, 100),
    preview: preview.slice(0, 25),
  };
}

async function commit(
  app: FastifyInstance,
  tenantId: string,
  userId: string,
  kind: ImportKind,
  rows: Row[],
  mapping: Record<string, string>,
): Promise<{ created: number; skipped: number; errors: Array<{ row: number; message: string }> }> {
  const db = app.db;
  let created = 0;
  const errors: Array<{ row: number; message: string }> = [];
  const invoiceGroups = new Map<string, Row[]>();
  const billGroups = new Map<string, Row[]>();
  const journalGroups = new Map<string, Row[]>();

  const findAccount = async (value: string) =>
    (
      await db.get<{ id: string }>('SELECT id FROM accounts WHERE tenant_id = ? AND (code = ? OR LOWER(name) = ?)', [
        tenantId,
        value.trim(),
        value.trim().toLowerCase(),
      ])
    )?.id ?? null;
  const findContact = async (value: string, kind: 'customer' | 'vendor') =>
    (
      await db.get<{ id: string }>('SELECT id FROM contacts WHERE tenant_id = ? AND LOWER(name) = ? AND kind IN (?, \'both\')', [
        tenantId,
        value.trim().toLowerCase(),
        kind,
      ])
    )?.id ?? null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      if (kind === 'accounts') {
        const code = (row[mapping.accountNumber ?? ''] ?? '').trim() || String(1000 + index);
        const name = row[mapping.accountName ?? ''] ?? '';
        if (!name) throw new Error('Account name is required');
        const exists = await db.get('SELECT id FROM accounts WHERE tenant_id = ? AND code = ?', [tenantId, code]);
        if (exists) throw new Error(`Account code ${code} already exists`);
        const type = normaliseType(row[mapping.type ?? ''] ?? '');
        await db.run(
          `INSERT INTO accounts (id, tenant_id, code, name, type, subtype, description, is_system, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
          [newId(), tenantId, code, name, type, row[mapping.detailType ?? ''] ?? null, row[mapping.description ?? ''] ?? null, new Date().toISOString(), new Date().toISOString()],
        );
        created += 1;
      } else if (kind === 'customers' || kind === 'vendors') {
        const name = row[mapping.name ?? ''] ?? '';
        if (!name) throw new Error('Name is required');
        const exists = await db.get('SELECT id FROM contacts WHERE tenant_id = ? AND LOWER(name) = ?', [tenantId, name.toLowerCase()]);
        if (exists) throw new Error(`${name} already exists`);
        const address = {
          line1: row[mapping.addressLine1 ?? ''] ?? '',
          city: row[mapping.city ?? ''] ?? '',
          postalCode: row[mapping.postalCode ?? ''] ?? '',
          country: row[mapping.country ?? ''] ?? '',
        };
        await db.run(
          `INSERT INTO contacts (id, tenant_id, kind, name, company_name, email, phone, billing_address_json, payment_terms_days,
             credit_limit, currency, notes, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            newId(),
            tenantId,
            kind === 'customers' ? 'customer' : 'vendor',
            name,
            row[mapping.companyName ?? ''] ?? null,
            row[mapping.email ?? ''] || null,
            row[mapping.phone ?? ''] || null,
            JSON.stringify(address),
            parseTerms(row[mapping.terms ?? '']),
            toMinor(row[mapping.creditLimit ?? ''] ?? '0'),
            row[mapping.currency ?? ''] || null,
            row[mapping.description ?? ''] || null,
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        );
        created += 1;
      } else if (kind === 'items') {
        const name = row[mapping.name ?? ''] ?? '';
        if (!name) throw new Error('Item name is required');
        const sku = (row[mapping.sku ?? ''] ?? '').trim() || `SKU-${index + 1}`;
        await db.run(
          `INSERT INTO items (id, tenant_id, sku, name, description, item_type, sales_price, purchase_cost, quantity_on_hand, reorder_point, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
          [
            newId(),
            tenantId,
            sku,
            name,
            row[mapping.description ?? ''] ?? null,
            (row[mapping.type ?? ''] ?? '').toLowerCase().includes('service') ? 'service' : 'inventory',
            toMinor(row[mapping.salesPrice ?? ''] ?? '0'),
            toMinor(row[mapping.purchaseCost ?? ''] ?? '0'),
            Number(row[mapping.quantityOnHand ?? ''] || 0),
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        );
        created += 1;
      } else if (kind === 'invoices') {
        const number = row[mapping.number ?? ''] ?? '';
        if (!number) throw new Error('Invoice number is required');
        if (!invoiceGroups.has(number)) invoiceGroups.set(number, []);
        invoiceGroups.get(number)!.push(row);
      } else if (kind === 'bills') {
        const number = row[mapping.number ?? ''] ?? '';
        if (!number) throw new Error('Bill number is required');
        if (!billGroups.has(number)) billGroups.set(number, []);
        billGroups.get(number)!.push(row);
      } else if (kind === 'journal') {
        const number = row[mapping.number ?? ''] ?? `JE-${index + 1}`;
        if (!journalGroups.has(number)) journalGroups.set(number, []);
        journalGroups.get(number)!.push(row);
      } else if (kind === 'bank') {
        errors.push({ row: index + 2, message: 'Use the bank account import endpoint for statements (Banking → Import).' });
      }
    } catch (err) {
      errors.push({ row: index + 2, message: (err as Error).message });
    }
  }

  for (const [number, group] of invoiceGroups) {
    try {
      const first = group[0];
      const contactId = await findContact(first[mapping.customer ?? ''] ?? '', 'customer');
      if (!contactId) throw new Error(`Customer "${first[mapping.customer ?? '']}" not found`);
      const taxCode = await db.get<{ id: string }>(
        'SELECT id FROM tax_codes WHERE tenant_id = ? AND (LOWER(code) = ? OR LOWER(name) = ?)',
        [tenantId, (first[mapping.taxName ?? ''] ?? '').toLowerCase(), (first[mapping.taxName ?? ''] ?? '').toLowerCase()],
      );
      const defaultIncome = await db.get<{ id: string }>("SELECT id FROM accounts WHERE tenant_id = ? AND type = 'income' ORDER BY code LIMIT 1", [tenantId]);
      const invoiceId = await createInvoice(db, tenantId, userId, {
        contactId,
        issueDate: first[mapping.date ?? ''] || new Date().toISOString().slice(0, 10),
        dueDate: first[mapping.dueDate ?? ''] || null,
        currency: first[mapping.currency ?? ''] || undefined,
        memo: first[mapping.description ?? ''] ?? `Imported invoice ${number}`,
        status: 'draft',
        lines: group.map((line) => ({
          description: line[mapping.description ?? ''] || line[mapping.itemName ?? ''] || 'Imported line',
          quantity: Number(line[mapping.quantity ?? ''] || 1),
          unitPrice: toMinor(line[mapping.rate ?? ''] ?? '0'),
          accountId: defaultIncome?.id ?? null,
          taxCodeId: taxCode?.id ?? null,
        })),
      });
      await db.run('UPDATE invoices SET number = ? WHERE id = ?', [number, invoiceId]);
      created += 1;
    } catch (err) {
      errors.push({ row: 0, message: `${number}: ${(err as Error).message}` });
    }
  }

  for (const [number, group] of billGroups) {
    try {
      const first = group[0];
      const contactId = await findContact(first[mapping.vendor ?? ''] ?? '', 'vendor');
      if (!contactId) throw new Error(`Vendor "${first[mapping.vendor ?? '']}" not found`);
      const lines = [];
      for (const line of group) {
        const accountId = await findAccount(line[mapping.account ?? ''] ?? '');
        if (!accountId) throw new Error(`Account "${line[mapping.account ?? '']}" not found`);
        lines.push({
          description: line[mapping.description ?? ''] || 'Imported line',
          quantity: 1,
          unitPrice: toMinor(line[mapping.amount ?? ''] ?? '0'),
          accountId,
        });
      }
      const billId = await createBill(db, tenantId, userId, {
        vendorId: contactId,
        number,
        issueDate: first[mapping.date ?? ''] || new Date().toISOString().slice(0, 10),
        dueDate: first[mapping.dueDate ?? ''] || null,
        status: 'open',
        lines,
      });
      await db.run('UPDATE bills SET number = ? WHERE id = ?', [number, billId]);
      created += 1;
    } catch (err) {
      errors.push({ row: 0, message: `${number}: ${(err as Error).message}` });
    }
  }

  for (const [number, group] of journalGroups) {
    try {
      const lines = [];
      for (const line of group) {
        const accountId = await findAccount(line[mapping.account ?? ''] ?? '');
        if (!accountId) throw new Error(`Account "${line[mapping.account ?? '']}" not found`);
        lines.push({
          accountId,
          debit: toMinor(line[mapping.debit ?? ''] ?? '0'),
          credit: toMinor(line[mapping.credit ?? ''] ?? '0'),
          description: line[mapping.description ?? ''] ?? undefined,
        });
      }
      const { postJournal } = await import('../domain/ledger.js');
      await postJournal(db, {
        tenantId,
        date: group[0][mapping.date ?? ''] || new Date().toISOString().slice(0, 10),
        memo: `Imported journal ${number}`,
        sourceType: 'opening',
        currency: 'USD',
        createdBy: userId,
        lines,
      });
      created += 1;
    } catch (err) {
      errors.push({ row: 0, message: `${number}: ${(err as Error).message}` });
    }
  }

  return { created, skipped: errors.length, errors };
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get('/imports/templates', { preHandler: requireAuth('import:write') }, async () => ({
    kinds: IMPORT_KINDS.map((kind) => ({ kind, ...IMPORT_TEMPLATES[kind] })),
  }));

  app.get('/imports/templates/:kind.csv', { preHandler: requireAuth('import:write') }, async (req, reply) => {
    const { kind } = parse(z.object({ kind: z.enum(IMPORT_KINDS) }), req.params);
    const template = IMPORT_TEMPLATES[kind];
    const csv = toCsv(template.sample, template.columns);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="ledgerline-${kind}-template.csv"`)
      .send(csv);
  });

  app.post('/imports/preview', { preHandler: requireAuth('import:write') }, async (req) => {
    const body = parse(
      z.object({
        kind: z.enum(IMPORT_KINDS),
        csv: z.string().min(1).max(5_000_000),
        mapping: z.record(z.string(), z.string()).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const rows = csvToObjects(body.csv);
    if (!rows.length) throw badRequest('The file has no data rows');
    const headers = Object.keys(rows[0]);
    const mapping = body.mapping && Object.keys(body.mapping).length ? body.mapping : suggestMapping(body.kind, headers);
    const result = await validate(req.db, ctx.tenantId, body.kind, rows, mapping);
    return result;
  });

  app.post('/imports/execute', { preHandler: requireAuth('import:write') }, async (req) => {
    const body = parse(
      z.object({
        kind: z.enum(IMPORT_KINDS),
        csv: z.string().min(1).max(5_000_000),
        mapping: z.record(z.string(), z.string()).optional(),
        filename: z.string().max(200).optional(),
      }),
      req.body,
    );
    const ctx = req.ctx!;
    const rows = csvToObjects(body.csv);
    if (!rows.length) throw badRequest('The file has no data rows');
    const headers = Object.keys(rows[0]);
    const mapping = body.mapping && Object.keys(body.mapping).length ? body.mapping : suggestMapping(body.kind, headers);
    const jobId = newId();
    await req.db.run(
      `INSERT INTO import_jobs (id, tenant_id, kind, filename, mapping_json, status, dry_run, total_rows, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, ?)`,
      [jobId, ctx.tenantId, body.kind, body.filename ?? null, JSON.stringify(mapping), rows.length, ctx.user.id, new Date().toISOString()],
    );
    const result = await commit(app, ctx.tenantId, ctx.user.id, body.kind, rows, mapping);
    await req.db.run(
      `UPDATE import_jobs SET status = 'completed', stats_json = ?, errors_json = ? WHERE id = ?`,
      [JSON.stringify({ created: result.created, skipped: result.skipped }), JSON.stringify(result.errors.slice(0, 50)), jobId],
    );
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'import.completed',
      entityType: 'import_job',
      entityId: jobId,
      summary: `Imported ${result.created} ${body.kind} records`,
      after: { created: result.created, skipped: result.skipped },
    });
    await emitEvent(req.db, ctx.tenantId, 'import.completed', { importId: jobId, kind: body.kind, created: result.created });
    return { ...result, jobId };
  });

  app.get('/imports/history', { preHandler: requireAuth('import:write') }, async (req) => ({
    data: await req.db.all('SELECT * FROM import_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50', [req.ctx!.tenantId]),
  }));

  /** Full data export for backups / migration away from the platform. */
  app.get('/export/all', { preHandler: requireAuth('data:export') }, async (req) => {
    const ctx = req.ctx!;
    const tables = ['accounts', 'contacts', 'invoices', 'invoice_lines', 'bills', 'bill_lines', 'payments', 'payment_applications', 'journal_entries', 'journal_lines', 'items', 'tax_codes', 'bank_accounts', 'bank_transactions', 'employees', 'timesheets'];
    const payload: Record<string, unknown[]> = {};
    for (const table of tables) {
      payload[table] = await req.db.all(`SELECT * FROM ${table} WHERE tenant_id = ?`, [ctx.tenantId]);
    }
    await recordAudit(req.db, {
      tenantId: ctx.tenantId,
      actor: { id: ctx.user.id, email: ctx.user.email, role: ctx.role, ip: req.ip },
      action: 'data.exported',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      summary: 'Full company data export',
    });
    return { exportedAt: new Date().toISOString(), company: ctx.tenant.name, tables: payload };
  });
}
