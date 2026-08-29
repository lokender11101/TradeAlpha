import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

test.describe('Phase 9.5: Margin & Liquidation UX', () => {
  let userId: string;
  let portfolioId: string;

  test.beforeAll(async ({ request }) => {
    execSync('npm run seed:e2e --workspace=api', { stdio: 'inherit', cwd: '../../' });
    await expect(async () => {
      const response = await request.get('http://localhost:4000/health');
      expect(response.ok()).toBeTruthy();
    }).toPass({ timeout: 30000, intervals: [1000] });
    
    // Find seeded user
    const user = await prisma.user.findUnique({ where: { email: 'playwright@tradealpha.local' }});
    userId = user!.id;
    const portfolio = await prisma.portfolio.findFirst({ where: { userId }});
    portfolioId = portfolio!.id;
  });

  test.beforeEach(async ({ page }) => {
    // Enable margin for tests by default
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { isMarginEnabled: true, totalCash: 100000, lockedCash: 0 }
    });
    
    // Clear old positions/orders
    await prisma.position.deleteMany({ where: { portfolioId } });
    await prisma.order.deleteMany({ where: { portfolioId } });

    await page.goto('/login');
    await page.fill('input[type="email"]', 'playwright@tradealpha.local');
    await page.fill('input[type="password"]', 'Playwright123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test('1. renders margin dashboard for margin-enabled account', async ({ page }) => {
    await expect(page.locator('h3:has-text("Equity / NAV")')).toBeVisible();
    await expect(page.locator('span[aria-label="Margin Status"]')).toBeVisible();
    await expect(page.locator('h3:has-text("Buying Power")')).toBeVisible();
    await expect(page.locator('h3:has-text("Maintenance Margin")')).toBeVisible();
    await expect(page.locator('h3:has-text("Gross Exposure")')).toBeVisible();
    // Non-margin only fields shouldn't be main heading if in margin layout
    // actually we still show "Total Cash"
    
    // Verify default state
    await expect(page.locator('span[aria-label="Current status: NORMAL"]')).toBeVisible();
  });

  test('2. renders non-margin dashboard correctly', async ({ page }) => {
    // Disable margin
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { isMarginEnabled: false }
    });

    await page.reload();
    await expect(page.locator('h3:has-text("Equity / NAV")')).toBeVisible();
    await expect(page.locator('h3:has-text("Buying Power")')).not.toBeVisible();
  });

  test('3. renders short position correctly in positions table', async ({ page }) => {
    await prisma.position.create({
      data: {
        portfolioId,
        symbol: 'TSLA',
        quantity: -50,
        averageEntryPrice: 200,
        status: 'OPEN'
      }
    });

    await page.reload();
    await expect(page.locator('h3', { hasText: 'Portfolio Positions' })).toBeVisible();
    
    // Qty & Side should display absolute qty + SHORT
    const cell = page.locator('tr:has-text("TSLA") td:nth-child(2)');
    await expect(cell).toContainText('50');
    await expect(cell).toContainText('SHORT');
  });

  test('4. renders FORCED_LIQUIDATION alert and LIQUIDATION order badge', async ({ page }) => {
    // Put portfolio into forced liquidation state
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { totalCash: -500000 }
    });
    
    await prisma.position.create({
      data: {
        portfolioId,
        symbol: 'RELIANCE',
        quantity: 1000,
        averageEntryPrice: 150,
        status: 'OPEN'
      }
    });

    await prisma.order.create({
      data: {
        portfolioId,
        userId,
        symbol: 'RELIANCE',
        side: 'SELL',
        type: 'MARKET',
        requestedQuantity: 1000,
        isLiquidation: true,
        status: 'PENDING',
        idempotencyKey: "client_123"
      }
    });

    await page.reload();
    
    // Liquidation Alert
    const alert = page.locator('div[role="alert"]:has-text("Forced liquidation in progress")');
    await expect(alert).toBeVisible();
    
    // Margin Level should be red/danger (not explicitly testing color, just value)
    
    // Order table should show LIQUIDATION badge
    const orderCell = page.locator('table').nth(1).locator('tr:has-text("RELIANCE") td').nth(0);
    await expect(orderCell).toContainText('LIQUIDATION');
    
    // Cancel button should NOT exist for liquidation order
    const actionCell = page.locator('table').nth(1).locator('tr:has-text("RELIANCE") td').nth(6);
    await expect(actionCell.locator('button:has-text("Cancel")')).not.toBeVisible();
  });

  test('5. Terminal Order Entry adapts to margin enablement', async ({ page }) => {
    await page.goto('/terminal');
    
    // Margin is enabled by default in beforeEach
    const sellBtn = page.locator('button[aria-label="Sell / Short"]');
    await expect(sellBtn).toBeVisible();

    // Disable margin
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { isMarginEnabled: false }
    });

    await page.reload();
    await expect(page.locator('button[aria-label="Sell"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Sell / Short"]')).not.toBeVisible();
  });

});
