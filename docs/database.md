# Database / ER Design

The database is designed in PostgreSQL with strict concurrency controls and foreign key constraints to ensure ACID compliance for all financial transactions.

## 1. Core Entities

### Users & Auth
- `users`: id, email, password_hash, created_at, updated_at
- `sessions`: id, user_id, token, expires_at, created_at

### Portfolio & Positions
- `portfolios`: id, user_id, cash_balance, total_equity, created_at, updated_at
- `positions`: id, portfolio_id, symbol, quantity, average_entry_price, realized_pnl, updated_at

### Trading Engine
- `orders`: id, user_id, portfolio_id, symbol, side (BUY/SELL), type (MARKET/LIMIT/STOP), quantity, requested_price, execution_price, status (CREATED/PENDING/EXECUTED/REJECTED/CANCELLED), idempotency_key, created_at, updated_at
- `trades`: id, order_id, symbol, side, quantity, price, executed_at
- `transactions`: id, portfolio_id, type (DEPOSIT/WITHDRAWAL/TRADE_EXECUTION), amount, reference_id, created_at

### Watchlists & Analytics
- `watchlists`: id, user_id, name, created_at
- `watchlist_items`: id, watchlist_id, symbol, added_at
- `portfolio_snapshots`: id, portfolio_id, date, total_value, cash_balance, created_at

## 2. Concurrency & Integrity
- **Optimistic/Pessimistic Locking**: `SELECT ... FOR UPDATE` is used when modifying `portfolios.cash_balance` and `positions` during trade execution to prevent double spending or negative balances.
- **Idempotency**: The `orders` table enforces a unique constraint on `(user_id, idempotency_key)` to prevent duplicate order submissions.

## 3. Key Indexes
- `idx_orders_user_status`: `orders (user_id, status)` - For retrieving open orders efficiently.
- `idx_positions_portfolio`: `positions (portfolio_id, symbol)` - For calculating real-time portfolio metrics.
