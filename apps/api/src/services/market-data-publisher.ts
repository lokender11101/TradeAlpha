import { Redis } from 'ioredis';
import { MarketSimulatorService, MarketTick } from './market-simulator.service';
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, ignore: 'pid,hostname' }
  }
});

export class MarketDataPublisher {
  constructor(private readonly redis: Redis, private readonly simulator: MarketSimulatorService) {
    this.simulator.on('tick', this.handleTick.bind(this));
  }

  private handleTick(tick: MarketTick): void {
    const channel = `market:tick:${tick.symbol}`;
    const payload = JSON.stringify({
      symbol: tick.symbol,
      price: tick.price,
      timestamp: tick.timestamp.toISOString()
    });

    this.redis.publish(channel, payload).catch((error) => {
      logger.error({ err: error, symbol: tick.symbol }, 'Failed to publish MarketTick to Redis Pub/Sub');
    });
  }
}
