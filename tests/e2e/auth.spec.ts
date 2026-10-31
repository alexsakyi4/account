import { expect, test } from '@playwright/test';
import { registerCompany, uniqueEmail } from './fixtures';

test.describe('authentication', () => {
  test('registers a company, lands on onboarding and reaches the dashboard', async ({ page }) => {
    const email = uniqueEmail('owner');
    await registerCompany(page, { company: 'Northwind Traders', name: 'Ada Lovelace', email });

    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole('heading', { name: /get set up/i })).toBeVisible();
    await page.getByRole('link', { name: /go to dashboard/i }).click();
    await expect(page.getByRole('heading', { name: /good to see you/i })).toBeVisible();
    await expect(page.getByText('Cash and bank')).toBeVisible();
  });

  test('rejects a wrong password without leaking whether the account exists', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill('nobody@example.com');
    await page.getByLabel('Password').fill('WrongPassword123!');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page.getByRole('alert')).toContainText(/invalid/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs out and blocks the protected routes', async ({ page }) => {
    await registerCompany(page, { company: 'Signout Co', email: uniqueEmail('signout') });
    await page.getByRole('button', { name: /account menu|sandbox user|ada lovelace/i }).click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/invoices');
    await expect(page).toHaveURL(/\/login/);
  });

  test('supports keyboard navigation to the invoice list', async ({ page }) => {
    await registerCompany(page, { company: 'Keyboard Co', email: uniqueEmail('keys') });
    await page.locator('body').press('g');
    await page.locator('body').press('i');
    await expect(page).toHaveURL(/\/invoices/);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
  });
});
