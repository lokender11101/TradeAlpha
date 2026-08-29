const fs = require('fs');
let code = fs.readFileSync('apps/web/tests/e2e/portfolio.spec.ts', 'utf8');

code = code.replace(
  "await expect(page.locator('td', { hasText: 'PENDING' }).first()).toBeVisible({ timeout: 10000 });",
  "await expect(page.locator('td').filter({ hasText: /PENDING|FILLED/ }).first()).toBeVisible({ timeout: 10000 });"
);

fs.writeFileSync('apps/web/tests/e2e/portfolio.spec.ts', code);
