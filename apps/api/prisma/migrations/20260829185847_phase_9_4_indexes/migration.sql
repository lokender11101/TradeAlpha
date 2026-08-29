-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "is_liquidation" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "orders_portfolio_id_is_liquidation_status_idx" ON "orders"("portfolio_id", "is_liquidation", "status");

-- CreateIndex
CREATE INDEX "positions_symbol_idx" ON "positions"("symbol");
