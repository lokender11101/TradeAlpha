import { formatInTimeZone } from 'date-fns-tz';
import { TimeProvider, defaultTimeProvider } from './time.provider';

export type SessionStatus = 'OPEN' | 'CLOSED';

export interface MarketSessionState {
  status: SessionStatus;
  serverTime: Date;
  nextTransition: Date;
}

export class MarketSessionService {
  private readonly timeProvider: TimeProvider;
  private readonly TIMEZONE = 'Asia/Kolkata';

  constructor(timeProvider: TimeProvider = defaultTimeProvider) {
    this.timeProvider = timeProvider;
  }

  public getStatus(): MarketSessionState {
    const now = this.timeProvider.now();
    const currentTimeStr = formatInTimeZone(now, this.TIMEZONE, 'HH:mm:ss');
    
    let status: SessionStatus = 'CLOSED';
    if (currentTimeStr >= '09:15:00' && currentTimeStr < '15:30:00') {
      status = 'OPEN';
    }
    
    const nowLocalStr = formatInTimeZone(now, this.TIMEZONE, 'yyyy-MM-dd');
    let nextTransition: Date;

    if (status === 'CLOSED') {
      if (currentTimeStr < '09:15:00') {
        // Next transition is today at 09:15:00
        nextTransition = new Date(`${nowLocalStr}T09:15:00.000+05:30`);
      } else {
        // Next transition is tomorrow at 09:15:00
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const tomorrowStr = formatInTimeZone(tomorrow, this.TIMEZONE, 'yyyy-MM-dd');
        nextTransition = new Date(`${tomorrowStr}T09:15:00.000+05:30`);
      }
    } else {
      // Next transition is today at 15:30:00
      nextTransition = new Date(`${nowLocalStr}T15:30:00.000+05:30`);
    }

    return {
      status,
      serverTime: now,
      nextTransition
    };
  }

  public isOpen(): boolean {
    return this.getStatus().status === 'OPEN';
  }

  public assertOpen(): void {
    if (!this.isOpen()) {
      throw new Error('Market is closed');
    }
  }

  public getSessionOriginState(timestamp: Date): SessionStatus {
    const timeStr = formatInTimeZone(timestamp, this.TIMEZONE, 'HH:mm:ss');
    if (timeStr >= '09:15:00' && timeStr < '15:30:00') {
      return 'OPEN';
    }
    return 'CLOSED';
  }
}

export const defaultMarketSessionService = new MarketSessionService();
