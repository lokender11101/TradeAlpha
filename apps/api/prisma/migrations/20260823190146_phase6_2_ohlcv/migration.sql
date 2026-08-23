-- CreateTable
CREATE TABLE "market_tick_receipts" (
    "tick_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_tick_receipts_pkey" PRIMARY KEY ("tick_id")
);

-- CreateTable
CREATE TABLE "market_candles" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(19,4) NOT NULL,
    "high" DECIMAL(19,4) NOT NULL,
    "low" DECIMAL(19,4) NOT NULL,
    "close" DECIMAL(19,4) NOT NULL,
    "volume" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "last_tick_timestamp" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_candles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_candles_symbol_timeframe_timestamp_idx" ON "market_candles"("symbol", "timeframe", "timestamp" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "market_candles_symbol_timeframe_timestamp_key" ON "market_candles"("symbol", "timeframe", "timestamp");
