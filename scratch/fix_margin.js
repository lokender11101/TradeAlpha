const fs = require('fs');
let code = fs.readFileSync('apps/web/tests/e2e/margin.spec.ts', 'utf8');

code = code.replace(
  "const orderCell = page.locator('h3:has-text(\"Open Orders\"), h3:has-text(\"Portfolio Positions\")').locator('..').nth(1).locator('tr:has-text(\"RELIANCE\") td:nth-child(1)');",
  "const orderCell = page.locator('table').nth(1).locator('tr:has-text(\"RELIANCE\") td').nth(0);"
);

code = code.replace(
  "const actionCell = page.locator('tr:has-text(\"RELIANCE\") td:nth-child(7)');",
  "const actionCell = page.locator('table').nth(1).locator('tr:has-text(\"RELIANCE\") td').nth(6);"
);

fs.writeFileSync('apps/web/tests/e2e/margin.spec.ts', code);
