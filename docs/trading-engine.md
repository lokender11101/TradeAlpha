# Trading Engine Design

The trading engine is the core of TradeAlpha, responsible for accurately simulating order execution against real-time market data while ensuring concurrency safety.

## 1. Order Lifecycle
- **CREATED**: Received via API, basic format validation passed.
- **VALIDATED**: Risk and funding checks passed (e.g., sufficient cash for BUY).
- **PENDING**: Added to the matching queue waiting for market conditions.
- **EXECUTED**: Matched against market price, trade created, balances updated.
- **REJECTED**: Failed risk check or market condition.
- **CANCELLED**: User manually aborted before execution.

## 2. Concurrency & Race Conditions
When multiple requests attempt to execute simultaneously (e.g., spending the same cash balance), the engine uses PostgreSQL transactions with `SELECT ... FOR UPDATE` on the `portfolios` row. This locks the portfolio during the transaction, forcing subsequent requests to queue and eventually fail validation once the cash is depleted.

## 3. Order Types Supported
- **Market Order**: Executes immediately at the next available market price tick.
- **Limit Order**: Executes only if the market price is at or better than the requested price.
- **Stop Order**: Becomes a market order once the stop price is breached.

## 4. Execution Flow
1. API receives POST `/orders`.
2. DB Transaction begins.
3. Lock portfolio row.
4. Calculate required margin/cash.
5. If insufficient funds -> Rollback, status `REJECTED`.
6. Insert order with status `PENDING`, commit transaction.
7. Background Execution Worker (listening to market data events) processes pending orders.
8. If matched, new DB transaction: lock portfolio, deduct cash, update position, create trade, update order status to `EXECUTED`. Emit WebSocket event.
