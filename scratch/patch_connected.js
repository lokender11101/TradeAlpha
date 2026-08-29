const fs = require('fs');
const file = 'apps/web/src/components/dashboard/portfolio-metrics.tsx';
let code = fs.readFileSync(file, 'utf8');
code = code.replace(/isConnected/g, 'connected');
fs.writeFileSync(file, code);
