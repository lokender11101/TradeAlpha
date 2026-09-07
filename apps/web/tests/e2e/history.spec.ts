import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

test.describe('Trade History & Statements', () => {
  test.beforeAll(async ({ request }) => {
    execSync('npm run seed:e2e --workspace=api', { stdio: 'inherit', cwd: '../../' });
    await expect(async () => {
      const response = await request.get('http://127.0.0.1:4000/health');
      expect(response.ok()).toBeTruthy();
    }).toPass({ timeout: 30000, intervals: [1000] });
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'playwright@tradealpha.local');
    await page.fill('input[type="password"]', 'Playwright123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('should display Execution History and Account Statement', async ({ page }) => {
    // Wait for the tables to load
    await expect(page.locator('h3:has-text("Execution History")')).toBeVisible();
    await expect(page.locator('h3:has-text("Account Statement")')).toBeVisible();

    // Since the user might not have trades yet, let's just make sure the component loaded correctly 
    // and didn't crash or throw a 404/500 error.
    await expect(page.locator('text=Loading trade history...')).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Failed to load trade history.')).not.toBeVisible();
    
    await expect(page.locator('text=Loading account statement...')).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Failed to load account statement.')).not.toBeVisible();
  });
});
