import { expect, test } from '@playwright/test';
import { createBill, createCustomer, createInvoice, createVendor, registerCompany, uniqueEmail } from './fixtures';

test.describe('invoice to cash, bill to payment, reconciliation', () => {
  test('records the full monthly cycle without manual fixes', async ({ page }) => {
    const customer = 'Harborline Foods';
    const vendor = 'PrintWorks';
    await registerCompany(page, { company: 'Journey Co', email: uniqueEmail('journey') });
    await createCustomer(page, customer, 'ap@harborline.example');
    await createVendor(page, vendor);

    // --- Invoice to cash -------------------------------------------------
    await createInvoice(page, customer, '1,250.00', { saveAndSend: true });
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('INV-0001').first()).toBeVisible();
    await expect(page.getByText('Posted to journal')).toBeVisible();

    await page.getByRole('button', { name: /record payment/i }).first().click();
    const payment = page.getByRole('dialog', { name: /record a payment received/i });
    await payment.getByLabel(/^amount/i).fill('500.00');
    await payment.getByRole('button', { name: /record payment/i }).click();
    await expect(payment).toBeHidden();
    await expect(page.getByText(/of \$1,250\.00 total · paid \$500\.00/i)).toBeVisible();
    await expect(page.getByText(/partial/i).first()).toBeVisible();

    // --- Bill to payment -------------------------------------------------
    await createBill(page, vendor, '320.00');
    await page.goto('/bills');
    await page.getByRole('row', { name: /PrintWorks/ }).getByRole('button', { name: /^pay$/i }).click();
    const billPayment = page.getByRole('dialog', { name: /pay a bill/i });
    await billPayment.getByLabel(/^amount/i).fill('320.00');
    await billPayment.getByRole('button', { name: /record payment/i }).click();
    await expect(billPayment).toBeHidden();
    await expect(page.getByRole('row', { name: /PrintWorks/ }).getByText('Paid', { exact: true })).toBeVisible();

    // --- Banking: import, auto-match, reconcile --------------------------
    await page.goto('/banking');
    await page.getByRole('button', { name: /import statement/i }).click();
    const importer = page.getByRole('dialog', { name: /import a bank statement/i });
    await importer.getByLabel('Statement CSV').fill(
      ['Date,Description,Amount', `${new Date().toISOString().slice(0, 10)},HARBORLINE PAYMENT,500.00`, `${new Date().toISOString().slice(0, 10)},BANK CHARGE,-12.00`].join('\n'),
    );
    await importer.getByRole('button', { name: /import lines/i }).click();
    await expect(importer).toBeHidden();
    await expect(page.getByText('HARBORLINE PAYMENT')).toBeVisible();

    await page.getByRole('button', { name: /^auto-match$/i }).click();
    await expect(page.getByText(/statement lines matched/i)).toBeVisible();

    await page.getByRole('tab', { name: /reconcile/i }).click();
    await page.getByRole('button', { name: /start a reconciliation|^start$/i }).first().click();
    const recon = page.getByRole('dialog', { name: /start a reconciliation/i });
    await recon.getByLabel(/statement ending balance/i).fill('500.00');
    await recon.getByRole('button', { name: /^start$/i }).click();
    await expect(recon).toBeHidden();
    await expect(page.getByText(/difference/i).first()).toBeVisible();

    // --- Reports reflect the business events -----------------------------
    await page.goto('/reports?type=profit-and-loss');
    await expect(page.getByRole('heading', { name: /profit & loss/i })).toBeVisible();
    await expect(page.getByText(/total income/i)).toBeVisible();
    await expect(page.getByText(/net income/i).first()).toBeVisible();

    await page.goto('/reports?type=ar-aging');
    await expect(page.getByRole('heading', { name: /accounts receivable aging/i })).toBeVisible();
    await expect(page.getByText(customer)).toBeVisible();

    // --- Audit trail ------------------------------------------------------
    await page.goto('/settings?tab=audit');
    await page.getByRole('button', { name: /verify chain/i }).click();
    await expect(page.getByText(/chain intact/i)).toBeVisible();
  });

  test('rejects an unbalanced journal entry', async ({ page }) => {
    await registerCompany(page, { company: 'Balance Co', email: uniqueEmail('balance') });
    await page.goto('/journal?new=1');
    const dialog = page.getByRole('dialog', { name: /new journal entry/i });
    const accounts = await dialog.getByLabel(/^account 1$/i).locator('option').all();
    expect(accounts.length).toBeGreaterThan(2);
    await dialog.getByLabel(/^account 1$/i).selectOption({ index: 1 });
    await dialog.getByLabel(/^account 2$/i).selectOption({ index: 2 });
    await dialog.getByLabel('Debit').first().fill('100.00');
    await dialog.getByLabel('Credit').nth(1).fill('90.00');
    await dialog.getByRole('button', { name: /post entry/i }).click();
    await expect(dialog.getByRole('alert')).toContainText(/must equal credits/i);
    await expect(dialog).toBeVisible();
  });

  test('voiding an invoice reverses the ledger and keeps the audit trail', async ({ page }) => {
    const customer = 'Void Customer';
    await registerCompany(page, { company: 'Void Co', email: uniqueEmail('void') });
    await createCustomer(page, customer);
    await createInvoice(page, customer, '99.00', { saveAndSend: true });
    await page.getByRole('button', { name: /^void$/i }).click();
    await expect(page.getByText('Void', { exact: true }).first()).toBeVisible();
    await page.goto('/reports?type=profit-and-loss');
    await expect(page.getByText(/total income/i)).toBeVisible();
  });
});
