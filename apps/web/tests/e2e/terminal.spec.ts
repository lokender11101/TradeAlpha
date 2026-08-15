import { test, expect } from '@playwright/test';

test.describe('Terminal E2E', () => {
  test.beforeAll(async () => {
    // We assume the DB is seeded beforehand via `npm run seed:e2e`
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
    await expect(page).toHaveURL('/dashboard');
    await expect(page.locator('h1', { hasText: 'Portfolio Dashboard' })).toBeVisible();

    // Verify portfolio exists
    await expect(page.getByRole('heading', { name: 'Total Value' })).toBeVisible();

    // 2. Navigate to Terminal
    await page.click('a[href="/terminal"]');
    await expect(page).toHaveURL('/terminal');
    
    // 3. Symbol Selection
    // Ensure RELIANCE is selected
    // For now we will select RELIANCE since the backend defaults to it in Phase 5
    await page.selectOption('select', 'RELIANCE');
    await expect(page.locator('h3', { hasText: 'Chart - RELIANCE' })).toBeVisible();
    
    // 4. Observe live price (ensure WebSocket is connected and streaming)
    const priceElement = page.getByTestId('live-price');
    await expect(priceElement).not.toHaveText('---', { timeout: 15000 });
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

    // 9. Portfolio / Position update
    // Go back to dashboard and check if positions are updated
    await page.click('a[href="/dashboard"]');
    await expect(page).toHaveURL('/dashboard');
    await expect(page.locator('td', { hasText: 'RELIANCE' }).first()).toBeVisible({ timeout: 10000 });

    // 11. WebSocket Reconnect
    // Simulate a brief disconnection
    await page.context().setOffline(true);
    await page.waitForTimeout(2000);
    await page.context().setOffline(false);
    
    // Reconnect should happen automatically, and we should see price updates again
    await page.click('a[href="/terminal"]');
    await expect(page).toHaveURL('/terminal');
    await expect(page.getByTestId('live-price')).not.toHaveText('---', { timeout: 15000 });
  });
});
