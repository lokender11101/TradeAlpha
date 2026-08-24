import { Prisma, OrderSide } from '@prisma/client';

export interface LiquidityProfile {
  symbol: string;
  baseSpread: string;
  availableDepth: string;
  slippageFactor: string;
}

// Decimal-safe liquidity configurations per symbol
export const LIQUIDITY_PROFILES: Record<string, LiquidityProfile> = {
  'RELIANCE': {
    symbol: 'RELIANCE',
    baseSpread: '0.10',
    availableDepth: '500', // high liquidity
    slippageFactor: '0.05'
  },
  'TCS': {
    symbol: 'TCS',
    baseSpread: '0.20',
    availableDepth: '200', // low liquidity
    slippageFactor: '0.10'
  },
  'DEFAULT': {
    symbol: 'DEFAULT',
    baseSpread: '0.05',
    availableDepth: '1000',
    slippageFactor: '0.02'
  }
};

export const getLiquidityProfile = (symbol: string): LiquidityProfile => {
  return LIQUIDITY_PROFILES[symbol] || LIQUIDITY_PROFILES['DEFAULT'];
};

/**
 * Calculates the exact executable price for an order, taking into account
 * the bid/ask spread and deterministic slippage based on filled depth.
 * MUST use Prisma.Decimal strictly.
 */
export const calculateExecutablePrice = (
  side: OrderSide,
  refPrice: Prisma.Decimal,
  profile: LiquidityProfile,
  filledQty: Prisma.Decimal
): Prisma.Decimal => {
  const baseSpread = new Prisma.Decimal(profile.baseSpread);
  const slippageFactor = new Prisma.Decimal(profile.slippageFactor);
  const availableDepth = new Prisma.Decimal(profile.availableDepth);

  // Level = floor(filledQty / availableDepth) using decimal arithmetic safely
  // Prisma.Decimal (decimal.js) provides .dividedToIntegerBy() which is perfect for this.
  const level = filledQty.dividedToIntegerBy(availableDepth);

  const slippage = slippageFactor.mul(level);

  if (side === OrderSide.BUY) {
    // Buy at Ask: RefPrice + spread/2 + slippage
    const l0Ask = refPrice.plus(baseSpread.dividedBy(2));
    return l0Ask.plus(slippage);
  } else {
    // Sell at Bid: RefPrice - spread/2 - slippage
    const l0Bid = refPrice.minus(baseSpread.dividedBy(2));
    return l0Bid.minus(slippage);
  }
};
