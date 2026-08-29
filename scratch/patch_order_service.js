const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../apps/api/src/services/order.service.ts');
let code = fs.readFileSync(filePath, 'utf8');

const targetBlock = `    let reservationPrice = new Prisma.Decimal(0);
    
    if (dto.side === 'BUY') {
      if (dto.type === 'LIMIT' || dto.type === 'STOP_LIMIT') {
        reservationPrice = new Prisma.Decimal(dto.limitPrice!);
      } else {
        reservationPrice = currentMarketPrice.mul(1.05);
      }
    }

    const requiredCash = dto.side === 'BUY' ? requestedQuantity.mul(reservationPrice) : new Prisma.Decimal(0);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw\`SELECT 1 FROM portfolios WHERE id = \${dto.portfolioId} FOR UPDATE\`;
        const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: dto.portfolioId } });
        
        if (portfolio.userId !== dto.userId) throw new Error('Unauthorized: Portfolio does not belong to user');

        if (dto.side === 'SELL') {
          await PositionService.checkPosition(tx, dto.portfolioId, dto.symbol, requestedQuantity);
        }

        if (dto.side === 'BUY') {
          const availableCash = new Prisma.Decimal(portfolio.totalCash).minus(portfolio.lockedCash);
          if (availableCash.lt(requiredCash)) throw new Error(\`Insufficient funds: Required \${requiredCash.toString()}, Available \${availableCash.toString()}\`);
          await tx.portfolio.update({
            where: { id: portfolio.id },
            data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).plus(requiredCash) }
          });
        } else if (dto.side === 'SELL') {
          await PositionService.lockPosition(tx, dto.portfolioId, dto.symbol, requestedQuantity);
        }

        const order = await tx.order.create({`;

const newBlock = `    let reservationPrice = new Prisma.Decimal(0);
    
    if (dto.type === 'LIMIT' || dto.type === 'STOP_LIMIT') {
      reservationPrice = new Prisma.Decimal(dto.limitPrice!);
    } else {
      reservationPrice = dto.side === 'BUY' ? currentMarketPrice.mul(1.05) : currentMarketPrice.mul(0.95);
    }

    const requiredCash = dto.side === 'BUY' ? requestedQuantity.mul(reservationPrice) : new Prisma.Decimal(0);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw\`SELECT 1 FROM portfolios WHERE id = \${dto.portfolioId} FOR UPDATE\`;
        const portfolio = await tx.portfolio.findUniqueOrThrow({ where: { id: dto.portfolioId } });
        
        if (portfolio.userId !== dto.userId) throw new Error('Unauthorized: Portfolio does not belong to user');

        let reservedMargin = new Prisma.Decimal(0);
        const IM_RATE = new Prisma.Decimal('0.50');

        if (portfolio.isMarginEnabled) {
          // Margin check
          let currentQty = new Prisma.Decimal(0);
          const pos = await tx.position.findUnique({
            where: { portfolioId_symbol: { portfolioId: dto.portfolioId, symbol: dto.symbol } }
          });
          if (pos) currentQty = new Prisma.Decimal(pos.quantity);

          let exposureIncreasingQty = new Prisma.Decimal(0);
          if (dto.side === 'BUY') {
            if (currentQty.gte(0)) exposureIncreasingQty = requestedQuantity;
            else {
              const absQty = currentQty.abs();
              exposureIncreasingQty = Prisma.Decimal.max(0, requestedQuantity.minus(absQty));
            }
          } else {
            if (currentQty.lte(0)) exposureIncreasingQty = requestedQuantity;
            else {
              exposureIncreasingQty = Prisma.Decimal.max(0, requestedQuantity.minus(currentQty));
            }
          }

          if (exposureIncreasingQty.gt(0)) {
            reservedMargin = exposureIncreasingQty.mul(reservationPrice).mul(IM_RATE);
            
            // Calculate free margin natively in tx
            const valuationService = require('./portfolio-valuation.service').PortfolioValuationService;
            const vs = new valuationService();
            const val = await vs.getValuation(portfolio.id, tx);
            const currentFreeMargin = new Prisma.Decimal(val.freeMargin);

            if (currentFreeMargin.lt(reservedMargin)) {
              throw new Error(\`Insufficient Free Margin: Required \${reservedMargin.toFixed(4)}, Available \${currentFreeMargin.toFixed(4)}\`);
            }

            await tx.portfolio.update({
              where: { id: portfolio.id },
              data: { lockedMargin: new Prisma.Decimal(portfolio.lockedMargin).plus(reservedMargin) }
            });
          }
        } else {
          // Cash check
          if (dto.side === 'BUY') {
            const availableCash = new Prisma.Decimal(portfolio.totalCash).minus(portfolio.lockedCash);
            if (availableCash.lt(requiredCash)) throw new Error(\`Insufficient funds: Required \${requiredCash.toString()}, Available \${availableCash.toString()}\`);
            await tx.portfolio.update({
              where: { id: portfolio.id },
              data: { lockedCash: new Prisma.Decimal(portfolio.lockedCash).plus(requiredCash) }
            });
          }
        }

        if (dto.side === 'SELL') {
          await PositionService.lockPosition(tx, dto.portfolioId, dto.symbol, requestedQuantity);
        }

        const order = await tx.order.create({`;

code = code.replace(targetBlock, newBlock);
fs.writeFileSync(filePath, code);
