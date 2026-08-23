import { EventEmitter } from 'events';
import crypto from 'crypto';
import { defaultTimeProvider } from './time.provider';

export interface MarketTick {
  tickId: string;
  symbol: string;
  price: string;
  volume: string;
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
  private currentPrices: Map<string, number> = new Map();

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
      ? parseFloat(config.initialPrice)
      : config.initialPrice;
      
    this.currentPrices.set(config.symbol, currentPrice);

    const timer = setInterval(() => {
      // Random walk: next price = current * (1 + random_change)
      // random_change is between -volatility and +volatility
      const change = (Math.random() * 2 - 1) * config.volatility;
      
      currentPrice = currentPrice * (1 + change);
      
      // Ensure price doesn't drop to zero or below
      if (currentPrice <= 0.0001) {
        currentPrice = 0.0001;
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
   * Get the last known price for a symbol as a formatted string.
   */
  public getLatestPrice(symbol: string): string | undefined {
    const price = this.currentPrices.get(symbol);
    return price !== undefined ? price.toFixed(4) : undefined;
  }

  /**
   * Push a deterministic tick. Useful for tests or manual price injection.
   */
  public pushTick(symbol: string, price: string | number, volume: string = '100', tickId?: string): void {
    const numericPrice = typeof price === 'string' 
      ? parseFloat(price)
      : price;

    this.currentPrices.set(symbol, numericPrice);
    this.emitTick(symbol, numericPrice, volume, tickId);
  }

  private emitTick(symbol: string, price: number, forcedVolume?: string, forcedTickId?: string): void {
    // Generate synthetic volume if not forced
    const volume = forcedVolume || (Math.floor(Math.random() * 500) + 1).toString();
    const tickId = forcedTickId || crypto.randomUUID();

    const tick: MarketTick = {
      tickId,
      symbol,
      price: price.toFixed(4),
      volume,
      timestamp: defaultTimeProvider.now(),
    };
    this.emit('tick', tick);
  }
}
