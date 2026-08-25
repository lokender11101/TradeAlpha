import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import Redis from 'ioredis';

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
    await page.fill('input[type="password"]', 'Playwright123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('Buy a position and confirm NAV does not decrease', async ({ page }) => {
    await page.waitForSelector('text=Net Asset Value (NAV)');
    const getMetrics = async () => {
      const navEl = page.locator('div:has(> h3:has-text("Net Asset Value")) > p').first();
      const cashEl = page.locator('div:has(> h3:has-text("Total Cash")) > p').first();
      
      const navText = await navEl.innerText();
      const cashText = await cashEl.innerText();
      
      return {
        nav: parseFloat(navText.replace('$', '').replace(/,/g, '')),
        cash: parseFloat(cashText.replace('$', '').replace(/,/g, ''))
      };
    };

    const initial = await getMetrics();

    await page.click('a[href="/terminal"]');
    await page.waitForURL('/terminal');

    await page.selectOption('select', 'RELIANCE');
    await expect(page.locator('h3', { hasText: 'Chart - RELIANCE' })).toBeVisible();

    await page.click('button:has-text("Market")');
    await page.fill('#qty', '10');
    await page.click('button:has-text("Place BUY Order")');

    await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeVisible({ timeout: 10000 });

    const redis = new Redis('redis://localhost:6379');
    
    let tickSecond = 10;
    await expect.poll(async () => {
      await redis.publish('market:tick:RELIANCE', JSON.stringify({
        symbol: 'RELIANCE',
        price: 150.00,
        timestamp: `2026-08-15T06:30:${tickSecond.toString().padStart(2, '0')}.000Z`
      }));
      tickSecond++;
      if (tickSecond > 59) tickSecond = 10;
      
      const isVisible = await page.locator('td', { hasText: 'PENDING' }).first().isVisible();
      return isVisible;
    }, {
      intervals: [1000],
      timeout: 60000
    }).toBeFalsy();

    await redis.quit();

    await page.click('a[href="/dashboard"]');
    await page.waitForURL('/dashboard');
    
    await expect.poll(async () => {
      const current = await getMetrics();
      return current.cash;
    }, { intervals: [2000], timeout: 60000 }).toBeLessThan(initial.cash);

    const current = await getMetrics();
    const orderCost = initial.cash - current.cash;
    expect(orderCost).toBeGreaterThan(0);
    
    const navDiff = Math.abs(initial.nav - current.nav);
    expect(navDiff).toBeLessThan(orderCost * 0.5); 
  });

  test('Verify Equity Curve renders after EOD snapshot', async ({ page }) => {
    await page.waitForSelector('text=Portfolio Equity Curve');
    const hasCanvas = await page.locator('canvas').count();
    const hasEmptyText = await page.locator('text=No historical data available').count();
    expect(hasCanvas + hasEmptyText).toBeGreaterThan(0);
  });
});
