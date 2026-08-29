const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../apps/api/src/services/order.service.ts');
let code = fs.readFileSync(filePath, 'utf8');

const targetBlock = `        const order = await tx.order.create({
          data: {
            userId: dto.userId,
            portfolioId: dto.portfolioId,
            symbol: dto.symbol,
            side: dto.side,
            type: dto.type,
            requestedQuantity: requestedQuantity,
            limitPrice: dto.limitPrice ? new Prisma.Decimal(dto.limitPrice) : null,
            stopPrice: dto.stopPrice ? new Prisma.Decimal(dto.stopPrice) : null,
            idempotencyKey: dto.idempotencyKey,
            reservationPrice,
            status: dto.type === 'STOP' || dto.type === 'STOP_LIMIT' ? OrderStatus.PENDING : OrderStatus.RECEIVED
          }
        });`;

const newBlock = `        const order = await tx.order.create({
          data: {
            userId: dto.userId,
            portfolioId: dto.portfolioId,
            symbol: dto.symbol,
            side: dto.side,
            type: dto.type,
            requestedQuantity: requestedQuantity,
            limitPrice: dto.limitPrice ? new Prisma.Decimal(dto.limitPrice) : null,
            stopPrice: dto.stopPrice ? new Prisma.Decimal(dto.stopPrice) : null,
            idempotencyKey: dto.idempotencyKey,
            reservationPrice,
            reservedMargin: reservedMargin.gt(0) ? reservedMargin : null,
            status: dto.type === 'STOP' || dto.type === 'STOP_LIMIT' ? OrderStatus.PENDING : OrderStatus.RECEIVED
          }
        });`;

code = code.replace(targetBlock, newBlock);
fs.writeFileSync(filePath, code);
