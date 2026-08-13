-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('RECEIVED', 'VALIDATED', 'ACCEPTED', 'PENDING', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "total_cash" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "locked_cash" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "locked_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "average_entry_price" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "requested_quantity" DECIMAL(19,4) NOT NULL,
    "filled_quantity" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "limit_price" DECIMAL(19,4),
    "stop_price" DECIMAL(19,4),
    "status" "OrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_fills" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "price" DECIMAL(19,4) NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "executed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" TEXT NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "asset_symbol" TEXT NOT NULL,
    "debit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,4) NOT NULL DEFAULT 0,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "positions_portfolio_id_symbol_key" ON "positions"("portfolio_id", "symbol");

-- CreateIndex
CREATE INDEX "idx_orders_user_status" ON "orders"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_user_id_idempotency_key_key" ON "orders"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_fills_order_id_idx" ON "order_fills"("order_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_reference_type_reference_id_idx" ON "ledger_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries"("account_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_fills" ADD CONSTRAINT "order_fills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

