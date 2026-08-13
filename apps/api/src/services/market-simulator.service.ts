import { EventEmitter } from 'events';
import { Decimal } from '@prisma/client/runtime/library';

export interface MarketTick {
  symbol: string;
  price: Decimal;
  timestamp: Date;
}

export interface SimulationConfig {
  symbol: string;
  initialPrice: string | number;
  volatility: number; // e.g., 0.01 for 1%
  intervalMs: number;
}

export class MarketSimulatorService extends EventEmitter {
  private activeSimulations: Map<string, NodeJS.Timeout> = new Map();
  private currentPrices: Map<string, Decimal> = new Map();

  constructor() {
    super();
  }

  /**
   * Starts an automated random walk simulation for a symbol.
   */
  public startSimulation(config: SimulationConfig): void {
    if (this.activeSimulations.has(config.symbol)) {
      this.stopSimulation(config.symbol);
    }

    let currentPrice = typeof config.initialPrice === 'string' 
      ? new Decimal(config.initialPrice)
      : new Decimal(config.initialPrice.toString());
      
    this.currentPrices.set(config.symbol, currentPrice);

    const timer = setInterval(() => {
      // Random walk: next price = current * (1 + random_change)
      // random_change is between -volatility and +volatility
      const change = (Math.random() * 2 - 1) * config.volatility;
      const multiplier = new Decimal(1).plus(new Decimal(change.toString()));
      
      currentPrice = currentPrice.mul(multiplier);
      
      // Ensure price doesn't drop to zero or below
      if (currentPrice.lte(new Decimal('0.0001'))) {
        currentPrice = new Decimal('0.0001');
      }

      this.currentPrices.set(config.symbol, currentPrice);
      this.emitTick(config.symbol, currentPrice);
    }, config.intervalMs);

    this.activeSimulations.set(config.symbol, timer);
  }

  /**
   * Stops an automated simulation for a symbol.
   */
  public stopSimulation(symbol: string): void {
    const timer = this.activeSimulations.get(symbol);
    if (timer) {
      clearInterval(timer);
      this.activeSimulations.delete(symbol);
    }
  }

  /**
   * Stops all automated simulations.
   */
  public stopAll(): void {
    for (const symbol of this.activeSimulations.keys()) {
      this.stopSimulation(symbol);
    }
  }

  /**
   * Get the last known price for a symbol.
   */
  public getLatestPrice(symbol: string): Decimal | undefined {
    return this.currentPrices.get(symbol);
  }

  /**
   * Push a deterministic tick. Useful for tests or manual price injection.
   */
  public pushTick(symbol: string, price: string | number): void {
    const decimalPrice = typeof price === 'string' 
      ? new Decimal(price)
      : new Decimal(price.toString());

    this.currentPrices.set(symbol, decimalPrice);
    this.emitTick(symbol, decimalPrice);
  }

  private emitTick(symbol: string, price: Decimal): void {
    const tick: MarketTick = {
      symbol,
      price,
      timestamp: new Date(),
    };
    this.emit('tick', tick);
  }
}
