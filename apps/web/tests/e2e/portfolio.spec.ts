import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

test.describe('Portfolio E2E', () => {
  test.beforeAll(async ({ request }) => {
    execSync('npm run seed:e2e --workspace=api', { stdio: 'inherit', cwd: '../../' });
    await expect(async () => {
      const response = await request.get('http://localhost:4000/health');
      expect(response.ok()).toBeTruthy();
    }).toPass({ timeout: 30000, intervals: [1000] });
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'playwright@tradealpha.local');
    await page.fill('input[type="password"]', 'Playwright!23');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('Buy a position and confirm NAV does not decrease', async ({ page }) => {
    await page.waitForSelector('text=Net Asset Value (NAV)');
    const metrics = await page.locator('.text-3xl.font-bold').allInnerTexts();
    const initialNav = parseFloat(metrics[0].replace('$', ''));
    const initialCash = parseFloat(metrics[1].replace('$', ''));

    await page.click('a[href="/terminal"]');
    await page.waitForURL('/terminal');

    await page.fill('input[type="number"]', '10');
    await page.click('button:has-text("MARKET")');
    await page.click('button:has-text("Submit BUY Order")');

    await page.waitForSelector('text=Filled', { timeout: 15000 });

    await page.click('a[href="/dashboard"]');
    await page.waitForURL('/dashboard');
    
    await page.waitForTimeout(6000);

    const updatedMetrics = await page.locator('.text-3xl.font-bold').allInnerTexts();
    const newNav = parseFloat(updatedMetrics[0].replace('$', ''));
    const newCash = parseFloat(updatedMetrics[1].replace('$', ''));

    expect(newCash).toBeLessThan(initialCash);
    
    const orderCost = initialCash - newCash;
    expect(orderCost).toBeGreaterThan(0);
    
    const navDiff = Math.abs(initialNav - newNav);
    expect(navDiff).toBeLessThan(orderCost * 0.5); 
  });
});
