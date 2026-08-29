const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../apps/api/src/services/order.service.ts');
let code = fs.readFileSync(filePath, 'utf8');

const targetBlock1 = `        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = fillQty.mul(reservationPrice);

          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: {
              lockedCash: new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased),
              totalCash: new Prisma.Decimal(portfolio.totalCash).minus(actualCost)
            }
          });`;

const newBlock1 = `        if (order.side === 'BUY') {
          const reservationPrice = new Prisma.Decimal(order.reservationPrice || 0);
          const lockedReleased = fillQty.mul(reservationPrice);

          const updateData: any = {
            totalCash: new Prisma.Decimal(portfolio.totalCash).minus(actualCost)
          };

          if (!portfolio.isMarginEnabled) {
            updateData.lockedCash = new Prisma.Decimal(portfolio.lockedCash).minus(lockedReleased);
          } else if (order.reservedMargin) {
            const marginToRelease = new Prisma.Decimal(order.reservedMargin).mul(fillQty).dividedBy(order.requestedQuantity);
            updateData.lockedMargin = new Prisma.Decimal(portfolio.lockedMargin).minus(marginToRelease);
          }

          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: updateData
          });`;

code = code.replace(targetBlock1, newBlock1);

const targetBlock2 = `        } else {
          
          const { realizedPnl } = await PositionService.adjustOnSell(tx, order.portfolioId, order.symbol, fillQty, fillPrice);
          fillRealizedPnl = realizedPnl;

          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: {
              totalCash: new Prisma.Decimal(portfolio.totalCash).plus(actualCost)
            }
          });
        }`;

const newBlock2 = `        } else {
          
          const { realizedPnl } = await PositionService.adjustOnSell(tx, order.portfolioId, order.symbol, fillQty, fillPrice);
          fillRealizedPnl = realizedPnl;

          const updateData: any = {
            totalCash: new Prisma.Decimal(portfolio.totalCash).plus(actualCost)
          };

          if (portfolio.isMarginEnabled && order.reservedMargin) {
            const marginToRelease = new Prisma.Decimal(order.reservedMargin).mul(fillQty).dividedBy(order.requestedQuantity);
            updateData.lockedMargin = new Prisma.Decimal(portfolio.lockedMargin).minus(marginToRelease);
          }

          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: updateData
          });
        }`;

code = code.replace(targetBlock2, newBlock2);
fs.writeFileSync(filePath, code);
