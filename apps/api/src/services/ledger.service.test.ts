import { LedgerService, NewLedgerEntry } from './ledger.service';


describe('LedgerService Invariants', () => {
  it('should pass validation for a perfectly balanced single-asset transaction', () => {
    const entries: NewLedgerEntry[] = [
      { accountId: 'user_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 1000, credit: 0 },
      { accountId: 'platform_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 0, credit: 1000 },
    ];
    expect(() => LedgerService.validateEntries(entries)).not.toThrow();
  });

  it('should throw error for an unbalanced single-asset transaction', () => {
    const entries: NewLedgerEntry[] = [
      { accountId: 'user_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 1000, credit: 0 },
      { accountId: 'platform_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 0, credit: 999 },
    ];
    expect(() => LedgerService.validateEntries(entries)).toThrow(/Ledger imbalance detected for asset FIAT:INR/);
  });

  it('should pass validation for a perfectly balanced multi-asset transaction', () => {
    const entries: NewLedgerEntry[] = [
      // INR Leg
      { accountId: 'user_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 1000, credit: 0 },
      { accountId: 'platform_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 0, credit: 1000 },
      // Security Leg
      { accountId: 'platform_sec', assetType: 'SECURITY', assetSymbol: 'AAPL', debit: 10, credit: 0 },
      { accountId: 'user_sec', assetType: 'SECURITY', assetSymbol: 'AAPL', debit: 0, credit: 10 },
    ];
    expect(() => LedgerService.validateEntries(entries)).not.toThrow();
  });

  it('should throw error if assets are mixed in balancing', () => {
    // e.g. Trying to balance 1000 INR debit with 1000 AAPL credit
    const entries: NewLedgerEntry[] = [
      { accountId: 'user_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 1000, credit: 0 },
      { accountId: 'user_sec', assetType: 'SECURITY', assetSymbol: 'AAPL', debit: 0, credit: 1000 },
    ];
    expect(() => LedgerService.validateEntries(entries)).toThrow(/Ledger imbalance detected/);
  });

  it('should throw error for negative values', () => {
    const entries: NewLedgerEntry[] = [
      { accountId: 'user_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: -1000, credit: 0 },
      { accountId: 'platform_cash', assetType: 'FIAT', assetSymbol: 'INR', debit: 0, credit: -1000 },
    ];
    expect(() => LedgerService.validateEntries(entries)).toThrow(/Ledger entries cannot have negative debit or credit values/);
  });
});
