-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "total_cash" DECIMAL(19,4) NOT NULL,
    "market_value" DECIMAL(19,4) NOT NULL,
    "total_nav" DECIMAL(19,4) NOT NULL,
    "unrealized_pnl" DECIMAL(19,4) NOT NULL,
    "realized_pnl" DECIMAL(19,4) NOT NULL,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portfolio_snapshots_portfolio_id_snapshot_date_idx" ON "portfolio_snapshots"("portfolio_id", "snapshot_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_snapshots_portfolio_id_snapshot_date_key" ON "portfolio_snapshots"("portfolio_id", "snapshot_date");

-- AddForeignKey
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
