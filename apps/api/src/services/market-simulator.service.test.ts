import { MarketSimulatorService, MarketTick } from './market-simulator.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('Market Data Simulator (Phase 2.5)', () => {
  let simulator: MarketSimulatorService;

  beforeEach(() => {
    simulator = new MarketSimulatorService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    simulator.stopAll();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('should push a deterministic tick and emit an event', (done) => {
    simulator.on('tick', (tick: MarketTick) => {
      expect(tick.symbol).toBe('AAPL');
      expect(tick.price.toString()).toBe('150.5');
      expect(tick.timestamp).toBeInstanceOf(Date);
      done();
    });

    simulator.pushTick('AAPL', '150.50');
    expect(simulator.getLatestPrice('AAPL')?.toString()).toBe('150.5');
  });

  it('should start a simulation and emit ticks automatically', () => {
    const tickHandler = jest.fn();
    simulator.on('tick', tickHandler);

    simulator.startSimulation({
      symbol: 'TSLA',
      initialPrice: '200',
      volatility: 0.05,
      intervalMs: 1000
    });

    expect(simulator.getLatestPrice('TSLA')?.toString()).toBe('200');
    expect(tickHandler).not.toHaveBeenCalled();

    // Advance 1 interval
    jest.advanceTimersByTime(1000);
    expect(tickHandler).toHaveBeenCalledTimes(1);

    const firstTick: MarketTick = tickHandler.mock.calls[0][0];
    expect(firstTick.symbol).toBe('TSLA');
    
    // Price should have changed slightly
    const priceStr = firstTick.price.toString();
    // With 5% volatility, it should be between 190 and 210
    const priceVal = parseFloat(priceStr);
    expect(priceVal).toBeGreaterThanOrEqual(190);
    expect(priceVal).toBeLessThanOrEqual(210);

    // Advance 5 more intervals
    jest.advanceTimersByTime(5000);
    expect(tickHandler).toHaveBeenCalledTimes(6);
  });

  it('should stop simulations correctly', () => {
    const tickHandler = jest.fn();
    simulator.on('tick', tickHandler);

    simulator.startSimulation({
      symbol: 'MSFT',
      initialPrice: 300,
      volatility: 0.01,
      intervalMs: 500
    });

    jest.advanceTimersByTime(500);
    expect(tickHandler).toHaveBeenCalledTimes(1);

    simulator.stopSimulation('MSFT');

    jest.advanceTimersByTime(5000);
    // Should still only have been called once since it was stopped
    expect(tickHandler).toHaveBeenCalledTimes(1);
  });

  it('should prevent price from falling to zero or negative', () => {
    const tickHandler = jest.fn();
    simulator.on('tick', tickHandler);

    simulator.startSimulation({
      symbol: 'PENNY',
      initialPrice: '0.0002',
      volatility: 0.99, // 99% volatility could drive it down fast
      intervalMs: 100
    });

    // Advance enough time to potentially crash the price
    jest.advanceTimersByTime(10000);

    const latestPrice = simulator.getLatestPrice('PENNY');
    expect(latestPrice).toBeDefined();
    expect(latestPrice!.gte(new Decimal('0.0001'))).toBe(true);
  });
});
