import { expect, type Page } from '@playwright/test';

let counter = 0;

export function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

export const PASSWORD = 'CorrectHorse123!';

export async function registerCompany(
  page: Page,
  options: { company?: string; name?: string; email?: string; currency?: string } = {},
): Promise<{ email: string; company: string }> {
  const email = options.email ?? uniqueEmail('e2e');
  const company = options.company ?? `E2E Co ${Date.now()}`;
  const name = options.name ?? 'Ada Lovelace';

  await page.goto('/register');
  await page.getByLabel('Company name').fill(company);
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /create company/i }).click();

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return { email, company };
}

export async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function createCustomer(page: Page, name: string, email?: string): Promise<void> {
  await page.goto('/customers');
  await page.getByRole('button', { name: /new customer|add customer/i }).first().click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (email) await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /add customer|save changes/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

export async function createInvoice(page: Page, customer: string, amount: string, options: { saveAndSend?: boolean } = {}): Promise<void> {
  await page.goto('/invoices?new=1');
  const dialog = page.getByRole('dialog', { name: /new invoice/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Customer').selectOption({ label: customer });
  await dialog.getByLabel('Description 1').fill('Consulting services');
  await dialog.getByLabel('Unit price').fill(amount);
  await dialog.getByRole('button', { name: options.saveAndSend ? /save and send/i : /save draft/i }).click();
  await expect(dialog).toBeHidden();
}

export async function createBill(page: Page, vendor: string, amount: string): Promise<void> {
  await page.goto('/bills?new=1');
  const dialog = page.getByRole('dialog', { name: /new bill/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Vendor').selectOption({ label: vendor });
  await dialog.getByLabel('Description 1').fill('Office supplies');
  await dialog.getByLabel('Unit price').fill(amount);
  await dialog.getByRole('button', { name: /save and post/i }).click();
  await expect(dialog).toBeHidden();
}

export async function createVendor(page: Page, name: string): Promise<void> {
  await page.goto('/vendors');
  await page.getByRole('button', { name: /new vendor|add vendor/i }).first().click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: /add vendor/i }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}
