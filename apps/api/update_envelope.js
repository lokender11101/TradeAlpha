const fs = require('fs');

function updateFile(file) {
  let content = fs.readFileSync(file, 'utf8');
  
  if (!content.includes('import { createEnvelope }')) {
    content = "import { createEnvelope } from '../utils/envelope';\n" + content;
  }

  content = content.replace(/type:\s*'([^']+)',\s*aggregateType:[^,]+,\s*aggregateId:[^,]+,\s*payload:\s*({[^}]+})/g, (match, type, payloadBlock) => {
    return match.replace(payloadBlock, `createEnvelope('${type}', ${payloadBlock})`);
  });

  fs.writeFileSync(file, content);
  console.log('Updated ' + file);
}

updateFile('src/services/order.service.ts');
updateFile('src/services/position.service.ts');
