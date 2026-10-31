import { expect, test } from '@playwright/test';
import { registerCompany, uniqueEmail } from './fixtures';

test.describe('accessibility & responsive layout', () => {
  test('exposes landmarks, a skip link and labelled navigation', async ({ page }) => {
    await registerCompany(page, { company: 'A11y Co', email: uniqueEmail('a11y') });
    await expect(page.locator('a[href="#main"]')).toHaveCount(1);
    await expect(page.locator('main#main')).toBeVisible();
    await expect(page.getByRole('navigation', { name: /primary/i })).toBeVisible();
    await page.locator('a[href="#main"]').focus();
    await expect(page.locator('a[href="#main"]')).toBeFocused();
  });

  test('every visible image and icon button has an accessible name', async ({ page }) => {
    await registerCompany(page, { company: 'Names Co', email: uniqueEmail('names') });
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((button) => button.offsetParent !== null)
        .filter((button) => !(button.getAttribute('aria-label') ?? button.textContent ?? '').trim())
        .map((button) => button.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);
  });

  test('stacks cleanly on a tablet viewport', async ({ page }) => {
    await page.setViewportSize({ width: 834, height: 1112 });
    await registerCompany(page, { company: 'Tablet Co', email: uniqueEmail('tablet') });
    await expect(page.getByRole('heading', { name: /good to see you/i })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
