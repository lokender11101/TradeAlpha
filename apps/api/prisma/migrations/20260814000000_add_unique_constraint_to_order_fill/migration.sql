-- CreateIndex
CREATE UNIQUE INDEX "order_fills_order_id_execution_idempotency_key_key" ON "order_fills"("order_id", "execution_idempotency_key");
