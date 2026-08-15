const fs = require('fs');
let code = fs.readFileSync('src/services/order.service.ts', 'utf8');
code = code.replace(/data:\s*\{\s*status:\s*OrderStatus\.EXPIRED\s*\}/g, 'data: { status: OrderStatus.EXPIRED }\n      }, /*@@@*/\n      function(tx) { console.log("@@@ EXPIRING: " + order.id, new Error().stack); return tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.EXPIRED } }); }() /*@@@*/');
// Wait, replacing Prisma data object with a function call will break the syntax.
// Let's just put console.log inside expireOrder at the very top!
code = code.replace(/public async expireOrder\(orderId: string\): Promise<Order> \{/, 'public async expireOrder(orderId: string): Promise<Order> {\n    console.log("@@@ EXPIRE ORDER CALLED: " + orderId, new Error().stack);\n');
fs.writeFileSync('src/services/order.service.ts', code);
