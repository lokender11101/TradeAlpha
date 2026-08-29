const fs = require('fs');
const file = 'apps/api/src/services/portfolio-valuation.service.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/if \(ml\.lt\(120\)\) marginStatus = "MARGIN_CALL";/g, 'if (ml.lt(100)) marginStatus = "FORCED_LIQUIDATION";\\n      else if (ml.lt(120)) marginStatus = "MARGIN_CALL";');
code = code.replace(/marginStatus: "NORMAL" \| "MARGIN_CALL"/g, 'marginStatus: "NORMAL" | "MARGIN_CALL" | "FORCED_LIQUIDATION"');

fs.writeFileSync(file, code);
