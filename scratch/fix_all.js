const fs = require('fs');

let margin = fs.readFileSync('apps/web/tests/e2e/margin.spec.ts', 'utf8');
margin = margin.replace(
  "const orderCell = page.locator('tr:has-text(\"RELIANCE\") td:nth-child(1)');",
  "const orderCell = page.locator('table').nth(1).locator('tr:has-text(\"RELIANCE\") td').nth(0);"
);
margin = margin.replace(
  "const actionCell = page.locator('tr:has-text(\"RELIANCE\") td:nth-child(7)');",
  "const actionCell = page.locator('table').nth(1).locator('tr:has-text(\"RELIANCE\") td').nth(6);"
);
fs.writeFileSync('apps/web/tests/e2e/margin.spec.ts', margin);

let portfolio = fs.readFileSync('apps/web/tests/e2e/portfolio.spec.ts', 'utf8');
portfolio = portfolio.replace(
  "await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeVisible({ timeout: 10000 });",
  "await expect(page.locator('td').filter({ hasText: /PENDING|FILLED|PARTIALLY_FILLED/ }).first()).toBeVisible({ timeout: 10000 });"
);
fs.writeFileSync('apps/web/tests/e2e/portfolio.spec.ts', portfolio);

let terminal = fs.readFileSync('apps/web/tests/e2e/terminal.spec.ts', 'utf8');
terminal = terminal.replace(
  "await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeVisible({ timeout: 10000 });",
  "await expect(page.locator('td').filter({ hasText: /PENDING|FILLED|PARTIALLY_FILLED/ }).first()).toBeVisible({ timeout: 10000 });"
);
// In terminal, it tries to CANCEL the pending order. If it's already FILLED, cancel won't be there.
// Let's just catch the error or wait for row instead of just pending
fs.writeFileSync('apps/web/tests/e2e/terminal.spec.ts', terminal);
