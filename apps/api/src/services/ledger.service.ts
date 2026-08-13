import { Prisma, PrismaClient } from '@prisma/client';

export type NewLedgerEntry = {
  accountId: string;
  assetType: string;
  assetSymbol: string;
  debit: string | number | Prisma.Decimal;
  credit: string | number | Prisma.Decimal;
};

export class LedgerService {
  /**
   * Validates that for every asset in the entries, SUM(debit) == SUM(credit).
   * Throws an error if unbalanced.
   */
  public static validateEntries(entries: NewLedgerEntry[]): void {
    const balances = new Map<string, Prisma.Decimal>();

    for (const entry of entries) {
      const assetKey = `${entry.assetType}:${entry.assetSymbol}`;
      const debit = new Prisma.Decimal(entry.debit);
      const credit = new Prisma.Decimal(entry.credit);

      if (debit.isNegative() || credit.isNegative()) {
        throw new Error('Ledger entries cannot have negative debit or credit values.');
      }

      const currentBalance = balances.get(assetKey) || new Prisma.Decimal(0);
      balances.set(assetKey, currentBalance.plus(debit).minus(credit));
    }

    for (const [asset, balance] of balances.entries()) {
      if (!balance.isZero()) {
        throw new Error(`Ledger imbalance detected for asset ${asset}. Net difference: ${balance.toString()}`);
      }
    }
  }

  /**
   * Records a strictly validated LedgerTransaction.
   */
  public static async recordTransaction(
    tx: Prisma.TransactionClient,
    referenceType: string,
    referenceId: string,
    entries: NewLedgerEntry[]
  ): Promise<void> {
    this.validateEntries(entries);

    await tx.ledgerTransaction.create({
      data: {
        referenceType,
        referenceId,
        entries: {
          create: entries.map(e => ({
            accountId: e.accountId,
            assetType: e.assetType,
            assetSymbol: e.assetSymbol,
            debit: e.debit,
            credit: e.credit
          }))
        }
      }
    });
  }

  /**
   * Reconciles a Portfolio's totalCash against the Ledger.
   * Assuming User Cash Account uses standard logic: 
   * A deposit credits the User Cash Account. A withdrawal debits it.
   * So User Balance = SUM(credit) - SUM(debit).
   */
  public static async reconcilePortfolioCash(
    prisma: PrismaClient | Prisma.TransactionClient,
    portfolioId: string,
    userCashAccountId: string
  ): Promise<{ isBalanced: boolean; ledgerBalance: Prisma.Decimal; portfolioBalance: Prisma.Decimal }> {
    const portfolio = await prisma.portfolio.findUniqueOrThrow({
      where: { id: portfolioId }
    });

    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: userCashAccountId, assetType: 'FIAT' }
    });

    let ledgerBalance = new Prisma.Decimal(0);
    for (const entry of entries) {
      ledgerBalance = ledgerBalance.plus(entry.credit).minus(entry.debit);
    }

    const portfolioBalance = new Prisma.Decimal(portfolio.totalCash);
    
    return {
      isBalanced: ledgerBalance.equals(portfolioBalance),
      ledgerBalance,
      portfolioBalance
    };
  }

  /**
   * Reconciles a Position's quantity against the Ledger.
   * Position quantity = SUM(credit) - SUM(debit) for the Security account.
   */
  public static async reconcilePosition(
    prisma: PrismaClient | Prisma.TransactionClient,
    positionId: string,
    userSecurityAccountId: string,
    assetSymbol: string
  ): Promise<{ isBalanced: boolean; ledgerQuantity: Prisma.Decimal; positionQuantity: Prisma.Decimal }> {
    const position = await prisma.position.findUniqueOrThrow({
      where: { id: positionId }
    });

    if (position.symbol !== assetSymbol) {
      throw new Error(`Position symbol ${position.symbol} does not match assetSymbol ${assetSymbol}`);
    }

    const entries = await prisma.ledgerEntry.findMany({
      where: { accountId: userSecurityAccountId, assetType: 'SECURITY', assetSymbol }
    });

    let ledgerQuantity = new Prisma.Decimal(0);
    for (const entry of entries) {
      ledgerQuantity = ledgerQuantity.plus(entry.credit).minus(entry.debit);
    }

    const positionQuantity = new Prisma.Decimal(position.quantity);

    return {
      isBalanced: ledgerQuantity.equals(positionQuantity),
      ledgerQuantity,
      positionQuantity
    };
  }
}
