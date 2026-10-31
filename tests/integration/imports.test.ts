import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestApp, journalTotals, registerCompany, today, type Session, type TestContext } from '../helpers.js';

let ctx: TestContext;
let session: Session;

beforeAll(async () => {
  ctx = await createTestApp();
  session = await registerCompany(ctx, 'Import Test Co');
});
afterAll(async () => {
  await ctx.close();
});

const quickBooksCustomers = [
  'Customer,Company Name,Email,Phone,Billing Address Line 1,Billing Address City,Billing Address Country,Terms,Credit Limit,Currency',
  'Northwind Traders,Northwind Traders LLC,ap@northwind.example,+233300000000,12 Commerce Street,Accra,GH,Net 30,5000.00,USD',
  'Bluepeak Studio,Bluepeak Studio Ltd,accounts@bluepeak.example,+233300000001,4 Studio Lane,Accra,GH,Net 15,2500.00,USD',
].join('\n');

const quickBooksInvoices = [
  'Invoice Number,Customer,Invoice Date,Due Date,Item(Product/Service),Item Quantity,Item Rate,Item Description,Tax Name,Currency',
  'INV-1042,Northwind Traders,2024-05-01,2024-05-31,Consulting,10,150.00,Advisory services,TAX0,USD',
  'INV-1043,Bluepeak Studio,2024-05-03,2024-05-18,Design,2,400.00,Brand package,VAT15,USD',
].join('\n');

describe('CSV import', () => {
  it('lists import templates including QuickBooks-compatible headers', async () => {
    const res = await authed(ctx, session, 'GET', '/imports/templates');
    expect(res.statusCode).toBe(200);
    const kinds = res.json().kinds.map((k: { kind: string }) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining(['accounts', 'customers', 'vendors', 'invoices', 'bills', 'journal', 'bank']));
    const customers = res.json().kinds.find((k: { kind: string }) => k.kind === 'customers');
    expect(customers.columns).toContain('Billing Address Line 1');
  });

  it('downloads a CSV template', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/imports/templates/customers.csv',
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\n')[0]).toContain('Customer');
  });

  it('dry-runs an import and reports validation problems', async () => {
    const bad = 'Customer,Email\n,not-an-email\nGood Co,ok@example.com';
    const preview = await authed(ctx, session, 'POST', '/imports/preview', { kind: 'customers', csv: bad });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().validRows).toBe(1);
    expect(preview.json().errors).toHaveLength(1);
    expect(preview.json().errors[0].message).toMatch(/required/i);
  });

  it('maps QuickBooks customer columns automatically and imports them', async () => {
    const preview = await authed(ctx, session, 'POST', '/imports/preview', { kind: 'customers', csv: quickBooksCustomers });
    const body = preview.json();
    expect(body.mapping.name).toBe('Customer');
    expect(body.mapping.email).toBe('Email');
    expect(body.mapping.addressLine1).toBe('Billing Address Line 1');
    expect(body.validRows).toBe(2);
    expect(body.errors).toHaveLength(0);

    const run = await authed(ctx, session, 'POST', '/imports/execute', { kind: 'customers', csv: quickBooksCustomers, filename: 'customers.csv' });
    expect(run.statusCode).toBe(200);
    expect(run.json().created).toBe(2);

    const contacts = await authed(ctx, session, 'GET', '/contacts?kind=customer');
    const names = contacts.json().data.map((c: { name: string }) => c.name);
    expect(names).toContain('Northwind Traders');
    expect(names).toContain('Bluepeak Studio');
  });

  it('imports invoices from a QuickBooks invoice export', async () => {
    const preview = await authed(ctx, session, 'POST', '/imports/preview', { kind: 'invoices', csv: quickBooksInvoices });
    expect(preview.json().validRows).toBe(2);
    const run = await authed(ctx, session, 'POST', '/imports/execute', { kind: 'invoices', csv: quickBooksInvoices });
    expect(run.json().created).toBe(2);
    const invoices = await authed(ctx, session, 'GET', '/invoices?pageSize=100');
    const numbers = invoices.json().data.map((i: { number: string }) => i.number);
    expect(numbers).toEqual(expect.arrayContaining(['INV-1042', 'INV-1043']));

    // Imported invoices stay as drafts until the bookkeeper reviews and posts them.
    const draft = invoices.json().data.find((i: { number: string }) => i.number === 'INV-1042');
    const post = await authed(ctx, session, 'POST', `/invoices/${draft.id}/post`);
    expect(post.statusCode).toBe(200);
    const after = await authed(ctx, session, 'GET', `/invoices/${draft.id}`);
    expect(after.json().invoice.journal_entry_id).toBeTruthy();
  });

  it('imports opening journal entries and keeps the trial balance balanced', async () => {
    const csv = [
      'Journal Number,Journal Date,Account,Debit,Credit,Description',
      `JE-OPEN,2024-01-01,1010,25000.00,,Opening bank`,
      `JE-OPEN,2024-01-01,3900,,25000.00,Opening equity`,
    ].join('\n');
    const run = await authed(ctx, session, 'POST', '/imports/execute', { kind: 'journal', csv });
    expect(run.json().created).toBe(1);
    const totals = await journalTotals(ctx, session.tenantId);
    expect(totals.debit).toBe(totals.credit);
  });

  it('records import history and exports all company data', async () => {
    const history = await authed(ctx, session, 'GET', '/imports/history');
    expect(history.json().data.length).toBeGreaterThanOrEqual(3);
    const exported = await authed(ctx, session, 'GET', '/export/all');
    expect(exported.json().tables.accounts.length).toBeGreaterThan(20);
    expect(exported.json().tables.contacts.length).toBeGreaterThan(0);
  });

  it('reports invalid rows without partially corrupting data', async () => {
    const csv = 'Bill Number,Vendor,Bill Date,Line Amount,Account\nB-1,Unknown Vendor,2024-05-01,100.00,6500';
    const run = await authed(ctx, session, 'POST', '/imports/execute', { kind: 'bills', csv });
    expect(run.json().created).toBe(0);
    expect(run.json().errors.length).toBe(1);
  });
});
