export class TimeProvider {
  /**
   * Returns the current date. In tests, this can be mocked or overridden.
   */
  public now(): Date {
    const isMock = process.env.NODE_ENV === 'test' || process.env.MOCK_TIME === 'true';
    if (isMock) {
      // Hardcode to an OPEN market session time (12:00 PM IST = 06:30 AM UTC) 
      // so that legacy E2E and unit tests don't fail due to "Market is closed".
      return new Date('2026-08-15T06:30:00.000Z');
    }
    const realNow = new Date();
    // console.log(`[TimeProvider] Real time returned! NODE_ENV=${process.env.NODE_ENV}, MOCK_TIME=${process.env.MOCK_TIME}, time=${realNow.toISOString()}`);
    return realNow;
  }
}

export const defaultTimeProvider = new TimeProvider();
