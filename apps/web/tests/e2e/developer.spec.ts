import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

test.describe('Developer Portal', () => {
  test.setTimeout(120000);
  test.beforeAll(async ({ request }) => {
    execSync('npm run seed:e2e --workspace=api', { stdio: 'inherit', cwd: '../../' });
    await expect(async () => {
      const response = await request.get('http://127.0.0.1:4000/health');
      expect(response.ok()).toBeTruthy();
    }).toPass({ timeout: 30000, intervals: [1000] });
  });

  test.beforeEach(async ({ page }) => {
    // Register and login
    await page.goto('/login');
    await page.fill('input[type="email"]', 'playwright@tradealpha.local');
    await page.fill('input[type="password"]', 'Playwright123!');
    await page.click('button[type="submit"]');
    
    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('should manage API keys', async ({ page }) => {
    await page.goto('/developer');
    await expect(page.locator('h1')).toContainText('Developer Settings');

    // Wait to ensure previous run artifacts (like keys) are loaded before we do anything
    await page.waitForLoadState('networkidle');
    
    // Create Key
    await page.fill('input#keyName', 'My Test Bot');
    await page.click('button:has-text("Create API Key")');

    // Verify secret is shown
    await expect(page.locator('text=Key Created Successfully')).toBeVisible();
    const secretText = await page.locator('.font-mono.select-all').innerText();
    expect(secretText.length).toBeGreaterThan(20);

    // Verify metadata
    await expect(page.locator('text=My Test Bot').first()).toBeVisible();

    // Reload page to verify secret is gone
    await page.reload();
    await expect(page.locator('text=Key Created Successfully')).not.toBeVisible();
    await expect(page.locator('.font-mono.select-all')).not.toBeVisible();

    // Revoke key
    page.once('dialog', dialog => dialog.accept());
    // Only delete the one we created
    await page.locator('tr:has-text("My Test Bot")').locator('button:has-text("Revoke")').click();

    // Verify it is gone
    await expect(page.locator('text=My Test Bot')).not.toBeVisible();
  });

  test('should manage webhooks', async ({ page }) => {
    await page.goto('/developer');
    await expect(page.locator('h1')).toContainText('Developer Settings');

    await page.waitForLoadState('networkidle');

    // Create Webhook
    const uniqueUrl = `https://example.com/hook-${Date.now()}`;
    await page.fill('input#webhookUrl', uniqueUrl);
    await page.click('button:has-text("Add Webhook")');

    // Verify metadata
    await expect(page.locator('td', { hasText: uniqueUrl })).toBeVisible();
    
    // Check active
    const row = page.locator('tr', { hasText: uniqueUrl });
    await expect(row.locator('td', { hasText: /^Active$/ })).toBeVisible();

    // Revoke webhook
    page.once('dialog', dialog => dialog.accept());
    await row.locator('button:has-text("Delete")').click();

    // Verify it is gone
    await expect(page.locator('text=' + uniqueUrl)).not.toBeVisible();
  });
});
