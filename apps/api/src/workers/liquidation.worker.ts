import { Worker, Job } from 'bullmq';
import { PrismaClient, Prisma, OrderStatus, OrderType, OrderSide } from '@prisma/client';
import pino from 'pino';
import { trace } from '@opentelemetry/api';
import { PortfolioValuationService } from '../services/portfolio-valuation.service';
import { PriceCacheService } from '../services/price-cache.service';
import { defaultMarketSessionService } from '../services/market-session.service';
import { createEnvelope } from '../utils/envelope';
import { calculateExecutablePrice, getLiquidityProfile } from '../engine/liquidity.config';
import Redis from 'ioredis';

const logger = pino({
  name: 'LiquidationWorker',
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
});

const prisma = new PrismaClient();
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const priceCache = new PriceCacheService(connection);
const valuationService = new PortfolioValuationService(prisma, priceCache);

export class LiquidationWorker {
  private worker: Worker;

  constructor() {
    this.worker = new Worker(
      'liquidation-eval-queue',
      async (job: Job) => {
        const tracer = trace.getTracer('tradealpha-api');
        return tracer.startActiveSpan('LiquidationWorker.process', async (span) => {
          try {
            const { portfolioId } = job.data;
            span.setAttribute('portfolioId', portfolioId);
            await this.evaluatePortfolio(portfolioId);
          } catch (error: any) {
            span.recordException(error);
            logger.error({ error: error.message, stack: error.stack }, 'LiquidationWorker error');
            throw error;
          } finally {
            span.end();
          }
        });
      },
      { connection, concurrency: 5 }
    );
  }

  private async evaluatePortfolio(portfolioId: string) {
    if (!defaultMarketSessionService.isOpen()) {
       return;
    }
    
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM portfolios WHERE id = ${portfolioId} FOR UPDATE`;
      const portfolio = await tx.portfolio.findUnique({ where: { id: portfolioId } });
      if (!portfolio || !portfolio.isMarginEnabled) return;

      const val = await valuationService.getValuation(portfolioId, tx);
      const marginLevel = val.marginLevel ? new Prisma.Decimal(val.marginLevel) : null;
      if (!marginLevel) return;

      const activeStates = [
        OrderStatus.RECEIVED,
        OrderStatus.VALIDATED,
        OrderStatus.ACCEPTED,
        OrderStatus.PENDING,
        OrderStatus.PARTIALLY_FILLED,
      ];
      
      const activeLiquidations = await tx.order.findMany({
        where: {
          portfolioId,
          isLiquidation: true,
          status: { in: activeStates }
        }
      });

      if (marginLevel.gte(120)) {
        for (const order of activeLiquidations) {
           await tx.order.update({
             where: { id: order.id },
             data: { status: OrderStatus.CANCELLED }
           });
           await tx.outboxEvent.create({
             data: {
               type: 'ORDER_CANCELLED',
               aggregateType: 'Order',
               aggregateId: order.id,
               payload: createEnvelope('ORDER_CANCELLED', { orderId: order.id, portfolioId: order.portfolioId })
             }
           });
        }
        return;
      }

      if (marginLevel.lt(120) && marginLevel.gte(100)) {
        return;
      }

      if (activeLiquidations.length > 0) {
        return;
      }

      const positions = await tx.position.findMany({
        where: { portfolioId, quantity: { not: new Prisma.Decimal(0) } }
      });

      if (positions.length === 0) return;

      const IM_RATE = new Prisma.Decimal('0.50');
      const candidates = await Promise.all(positions.map(async p => {
        const qty = new Prisma.Decimal(p.quantity);
        const absQty = qty.abs();
        const { price: priceStr } = await priceCache.getLatestPrice(p.symbol);
        const refPrice = priceStr ? new Prisma.Decimal(priceStr) : new Prisma.Decimal(0);
        
        const isLong = qty.gt(0);
        const liquidationSide = isLong ? OrderSide.SELL : OrderSide.BUY;
        
        const liquidityProfile = getLiquidityProfile(p.symbol);
        // For LONG (liquidationSide = SELL), executable price is BID (lower than ref).
        // For SHORT (liquidationSide = BUY), executable price is ASK (higher than ref).
        const executablePrice = calculateExecutablePrice(liquidationSide, refPrice, liquidityProfile, new Prisma.Decimal(0));
        
        // Notional uses refPrice natively
        const notional = absQty.mul(refPrice);
        // IM Contribution uses executablePrice
        const imContribution = absQty.mul(executablePrice).mul(IM_RATE);
        
        return { symbol: p.symbol, qty, notional, imContribution };
      }));

      candidates.sort((a, b) => {
        const imDiff = b.imContribution.minus(a.imContribution).toNumber();
        if (imDiff !== 0) return imDiff;
        
        const notionalDiff = b.notional.minus(a.notional).toNumber();
        if (notionalDiff !== 0) return notionalDiff;
        
        return a.symbol.localeCompare(b.symbol);
      });

      const topCandidate = candidates[0];
      if (topCandidate.notional.lte(0)) return;

      const countRes = await tx.$queryRaw<{count: bigint}[]>`
        SELECT COUNT(*) as count FROM orders WHERE portfolio_id = ${portfolioId} AND symbol = ${topCandidate.symbol} AND is_liquidation = true;
      `;
      const roundCount = countRes[0].count.toString();
      const riskEventId = `round_${roundCount}`;
      const idempotencyKey = `liq_${portfolioId}_${topCandidate.symbol}_${riskEventId}`;

      const side = topCandidate.qty.gt(0) ? OrderSide.SELL : OrderSide.BUY;
      
      logger.info({ symbol: topCandidate.symbol, qty: topCandidate.qty.abs().toString() }, `Generating liquidation order for ${portfolioId}`);

      const order = await tx.order.create({
        data: {
          userId: portfolio.userId,
          portfolioId: portfolio.id,
          symbol: topCandidate.symbol,
          side,
          type: OrderType.MARKET,
          requestedQuantity: topCandidate.qty.abs(),
          idempotencyKey,
          isLiquidation: true,
          status: OrderStatus.RECEIVED
        }
      });

      await tx.outboxEvent.create({
        data: {
          type: 'ORDER_PLACED',
          aggregateType: 'Order',
          aggregateId: order.id,
          payload: createEnvelope('ORDER_PLACED', { orderId: order.id, symbol: order.symbol, idempotencyKey, portfolioId: order.portfolioId })
        }
      });

    });
  }

  async close() {
    await this.worker.close();
  }
}
