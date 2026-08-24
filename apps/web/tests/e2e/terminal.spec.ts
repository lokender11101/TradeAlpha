import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import Redis from 'ioredis';

test.describe('Terminal E2E', () => {
  test.beforeAll(async ({ request }) => {
    // Dynamically run the seed script to ensure E2E user exists
    execSync('npm run seed:e2e --workspace=api', { stdio: 'inherit', cwd: '../../' });
    
    // Wait for the API to be ready to avoid ERR_CONNECTION_REFUSED
    await expect(async () => {
      const response = await request.get('http://localhost:4000/health');
      expect(response.ok()).toBeTruthy();
    }).toPass({ timeout: 30000, intervals: [1000] });
  });

  test('Baseline E2E Flow', async ({ page }) => {
    page.on('console', msg => console.log(`[browser] ${msg.text()}`));
    
    page.on('console', msg => console.log(`[browser] ${msg.text()}`));
    
    // 1. Navigate to login
    await page.goto('/login');
    await page.fill('input[type="email"]', 'playwright@tradealpha.local');
    await page.fill('input[type="password"]', 'Playwright123!');
    await page.click('button:has-text("Sign in")');

    // Wait for redirect to dashboard
    await page.waitForURL('/dashboard');
    await expect(page.locator('h1', { hasText: 'Portfolio Dashboard' })).toBeVisible();

    // Verify portfolio exists
    await expect(page.getByRole('heading', { name: 'Total Value' })).toBeVisible();

    // 2. Navigate to Terminal
    await page.click('a[href="/terminal"]');
    await page.waitForURL('/terminal');
    
    // 3. Symbol Selection
    // Ensure RELIANCE is selected
    // For now we will select RELIANCE since the backend defaults to it in Phase 5
    await page.selectOption('select', 'RELIANCE');
    await expect(page.locator('h3', { hasText: 'Chart - RELIANCE' })).toBeVisible();
    
    // 4. Observe live price (ensure WebSocket is connected and streaming)
    // Deterministically trigger the execution by publishing a tick to Redis early
    const initRedis = new Redis('redis://localhost:6379');
    const priceElement = page.getByTestId('live-price');
    
    await expect(async () => {
      await initRedis.publish('market:tick:RELIANCE', JSON.stringify({
        symbol: 'RELIANCE',
        price: 150.00,
        timestamp: '2026-08-15T06:30:00.000Z'
      }));
      await expect(priceElement).not.toHaveText('---', { timeout: 1000 });
    }).toPass({ timeout: 15000, intervals: [500] });
    
    await initRedis.quit();
    
    const initialPriceText = await priceElement.innerText();
    expect(parseFloat(initialPriceText)).toBeGreaterThan(0);

    // 5. Place a LIMIT order
    await page.click('button:has-text("Limit")');
    await page.fill('#qty', '10'); // Quantity
    await page.fill('#price', '140.00'); // Limit Price (low so it pends)
    await page.click('button:has-text("Place BUY Order")');

    // 6. Observe PENDING
    // The order history should show the new order
    await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeVisible({ timeout: 10000 });

    // 7. Cancel the PENDING order
    await page.click('button:has-text("Cancel")');
    await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeHidden({ timeout: 10000 });

    // 8. Place a MARKET order
    await page.click('button:has-text("Market")');
    await page.fill('#qty', '5'); // Quantity
    await page.click('button:has-text("Place BUY Order")');

    // Deterministically trigger the execution by publishing a tick to Redis
    // using the top level import Redis. We loop to ensure TradingEngine processes it.
    const redis = new Redis('redis://localhost:6379');
    for (let i = 0; i < 5; i++) {
      await redis.publish('market:tick:RELIANCE', JSON.stringify({
        symbol: 'RELIANCE',
        price: 150.00,
        timestamp: '2026-08-15T06:30:00.000Z'
      }));
      await page.waitForTimeout(500);
    }
    await redis.quit();

    // Wait for the MARKET order to be FILLED (it should disappear from Open Orders)
    await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeHidden({ timeout: 10000 });

    // 9. Portfolio / Position update
    // Go back to dashboard and check if positions are updated
    await page.click('a[href="/dashboard"]');
    await page.waitForURL('/dashboard');
    await expect(page.locator('td', { hasText: 'RELIANCE' }).first()).toBeVisible({ timeout: 10000 });

    // 11. WebSocket Reconnect
    // Simulate a brief disconnection
    await page.context().setOffline(true);
    await page.waitForTimeout(2000);
    await page.context().setOffline(false);
    
    // Reconnect should happen automatically, and we should see price updates again
    await page.click('a[href="/terminal"]');
    await page.waitForURL('/terminal');
    
    const reconnectRedis = new Redis('redis://localhost:6379');
    const newPriceElement = page.getByTestId('live-price');
    await expect(async () => {
      await reconnectRedis.publish('market:tick:RELIANCE', JSON.stringify({
        symbol: 'RELIANCE',
        price: 155.00,
        timestamp: '2026-08-15T06:30:00.000Z'
      }));
      await expect(newPriceElement).not.toHaveText('---', { timeout: 1000 });
    }).toPass({ timeout: 15000, intervals: [500] });
    await reconnectRedis.quit();
  });

  test('Phase 6.4 Charting E2E', async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.fill('input[type="email"]', 'playwright@tradealpha.local');
    await page.fill('input[type="password"]', 'Playwright123!');
    await page.click('button:has-text("Sign in")');
    await page.waitForURL('/dashboard');

    // Terminal
    await page.click('a[href="/terminal"]');
    await page.waitForURL('/terminal');
    
    // Check Sim Depth
    await expect(page.locator('h3', { hasText: 'Simulated Market Depth' })).toBeVisible();

    // Chart container
    await expect(page.getByTestId('chart-container')).toBeVisible();

    const redis = new Redis('redis://localhost:6379');
    
    // Inject MARKET_CANDLE
    await redis.publish('market:candle:RELIANCE', JSON.stringify({
      type: 'MARKET_CANDLE',
      payload: {
        symbol: 'RELIANCE',
        timeframe: '1m',
        timestamp: '2026-08-15T06:31:00.000Z',
        open: '150.00',
        high: '155.00',
        low: '149.00',
        close: '154.00',
        volume: '1000',
        isClosed: false
      }
    }));
    
    // Let chart receive it
    await page.waitForTimeout(1000);
    
    // Update same candle
    await redis.publish('market:candle:RELIANCE', JSON.stringify({
      type: 'MARKET_CANDLE',
      payload: {
        symbol: 'RELIANCE',
        timeframe: '1m',
        timestamp: '2026-08-15T06:31:00.000Z',
        open: '150.00',
        high: '156.00',
        low: '149.00',
        close: '155.00',
        volume: '1500',
        isClosed: true
      }
    }));

    await page.waitForTimeout(1000);
    
    // Timeframe switch
    await page.click('[data-testid="timeframe-5m"]');
    await page.waitForTimeout(1000);
    
    await redis.quit();
  });
});
