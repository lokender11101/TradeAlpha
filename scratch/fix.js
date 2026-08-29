const fs = require('fs');
let code = fs.readFileSync('apps/api/src/services/portfolio-valuation.service.ts', 'utf8');
code = code.replace(/\\n/g, '\n');
fs.writeFileSync('apps/api/src/services/portfolio-valuation.service.ts', code);
