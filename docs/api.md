# API Design

TradeAlpha utilizes a RESTful API architecture for state mutations and historical data retrieval, complemented by WebSockets for real-time streaming.

## 1. Base URL
`https://api.tradealpha.com/v1`

## 2. Authentication
All endpoints (except public market data and auth) require a Bearer JWT token in the `Authorization` header.

## 3. Endpoints

### Market Data
- `GET /stocks/:symbol` - Retrieve current quote and basic info.
- `GET /stocks/:symbol/history?interval=1d` - Retrieve OHLCV data.

### Portfolio & Positions
- `GET /portfolio` - Retrieve cash balance, total equity, and daily P&L.
- `GET /positions` - Retrieve all open positions with average entry prices.

### Orders
- `GET /orders?status=PENDING` - List orders with optional filtering.
- `POST /orders` - Place a new order.
  - Body: `{ symbol, side, type, quantity, requested_price, idempotency_key }`
- `DELETE /orders/:id` - Cancel a pending order.

### Watchlists
- `GET /watchlists` - List user watchlists.
- `POST /watchlists` - Create a new watchlist.
- `POST /watchlists/:id/items` - Add a stock to a watchlist.
- `DELETE /watchlists/:id/items/:symbol` - Remove a stock from a watchlist.

## 4. Standard Responses
- **Success (200/201)**: `{ "data": { ... }, "meta": { ... } }`
- **Error (400/401/403/404/500)**: `{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "..." }, "request_id": "abc-123" }`
