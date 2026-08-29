const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../apps/api/src/services/order.service.ts');
let code = fs.readFileSync(filePath, 'utf8');

const targetCancel = `        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = remainingQty.mul(reservationPrice);
          const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: order.portfolioId } });
          
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased) }
          });
        } else {
          const position = await tx.position.findUniqueOrThrow({
            where: { portfolioId_symbol: { portfolioId: order.portfolioId, symbol: order.symbol } }
          });
          
          await tx.position.update({
            where: { id: position.id },
            data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).minus(remainingQty) }
          });
        }`;

const newCancel = `        const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: order.portfolioId } });
        const updateData: any = {};
        
        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = remainingQty.mul(reservationPrice);
          
          if (!portfolio.isMarginEnabled) {
            updateData.lockedCash = new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased);
          }
        } else {
          const position = await tx.position.findUniqueOrThrow({
            where: { portfolioId_symbol: { portfolioId: order.portfolioId, symbol: order.symbol } }
          });
          
          await tx.position.update({
            where: { id: position.id },
            data: { lockedQuantity: new Prisma.Decimal(position.lockedQuantity).minus(remainingQty) }
          });
        }

        if (portfolio.isMarginEnabled && order.reservedMargin) {
          const marginToRelease = new Prisma.Decimal(order.reservedMargin).mul(remainingQty).dividedBy(order.requestedQuantity);
          updateData.lockedMargin = new Prisma.Decimal(portfolio.lockedMargin).minus(marginToRelease);
        }

        if (Object.keys(updateData).length > 0) {
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: updateData
          });
        }`;

// Since cancelOrder and expireOrder have the same logic, we can replace all occurrences!
code = code.split(targetCancel).join(newCancel);
fs.writeFileSync(filePath, code);
