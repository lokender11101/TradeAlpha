import { MarketSessionService } from './market-session.service';
import { TimeProvider } from './time.provider';

class MockTimeProvider extends TimeProvider {
  private mockDate: Date;
  constructor(dateStr: string) {
    super();
    this.mockDate = new Date(dateStr);
  }
  public now(): Date {
    return this.mockDate;
  }
}

describe('MarketSessionService', () => {
  it('should be CLOSED at 09:14:59', () => {
    // 09:14:59 IST = 03:44:59 UTC
    const timeProvider = new MockTimeProvider('2026-08-15T03:44:59.000Z');
    const service = new MarketSessionService(timeProvider);
    const status = service.getStatus();
    expect(status.status).toBe('CLOSED');
    expect(status.nextTransition.toISOString()).toBe('2026-08-15T03:45:00.000Z');
  });

  it('should be OPEN at 09:15:00', () => {
    // 09:15:00 IST = 03:45:00 UTC
    const timeProvider = new MockTimeProvider('2026-08-15T03:45:00.000Z');
    const service = new MarketSessionService(timeProvider);
    const status = service.getStatus();
    expect(status.status).toBe('OPEN');
    expect(status.nextTransition.toISOString()).toBe('2026-08-15T10:00:00.000Z'); // 15:30:00 IST
  });

  it('should be OPEN at 15:29:59', () => {
    // 15:29:59 IST = 09:59:59 UTC
    const timeProvider = new MockTimeProvider('2026-08-15T09:59:59.000Z');
    const service = new MarketSessionService(timeProvider);
    const status = service.getStatus();
    expect(status.status).toBe('OPEN');
    expect(status.nextTransition.toISOString()).toBe('2026-08-15T10:00:00.000Z');
  });

  it('should be CLOSED at 15:30:00', () => {
    // 15:30:00 IST = 10:00:00 UTC
    const timeProvider = new MockTimeProvider('2026-08-15T10:00:00.000Z');
    const service = new MarketSessionService(timeProvider);
    const status = service.getStatus();
    expect(status.status).toBe('CLOSED');
    expect(status.nextTransition.toISOString()).toBe('2026-08-16T03:45:00.000Z'); // Next day 09:15:00
  });

  it('should return correct origin state', () => {
    const service = new MarketSessionService();
    expect(service.getSessionOriginState(new Date('2026-08-15T03:44:59.000Z'))).toBe('CLOSED');
    expect(service.getSessionOriginState(new Date('2026-08-15T03:45:00.000Z'))).toBe('OPEN');
    expect(service.getSessionOriginState(new Date('2026-08-15T09:59:59.000Z'))).toBe('OPEN');
    expect(service.getSessionOriginState(new Date('2026-08-15T10:00:00.000Z'))).toBe('CLOSED');
  });
});
