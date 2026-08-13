# WebSocket Architecture

TradeAlpha uses WebSockets to deliver low-latency real-time updates for market data, order executions, and portfolio changes.

## 1. Connection Lifecycle
- **Authentication**: Clients connect using an auth token (e.g., `ws://api.tradealpha.com/?token=...`). Connections without a valid JWT are immediately terminated.
- **Heartbeats**: The server sends a ping every 30 seconds. Clients must respond with a pong. Stale connections are dropped.
- **Reconnection**: Handled by the client library (e.g., Socket.io client or native reconnect logic) with exponential backoff.

## 2. Subscription Management
Clients subscribe to specific channels/rooms to receive targeted data:
- `subscribe:ticker:AAPL` -> Receives price ticks for Apple.
- `subscribe:portfolio:{user_id}` -> Receives private portfolio and order updates (enforced via JWT validation).

## 3. Redis Pub/Sub Integration
Since the backend may scale horizontally, Redis Pub/Sub is used as the message broker.
- Market Data Service publishes tick -> Redis `channel:market:AAPL`
- All Node.js instances subscribe to Redis.
- Node.js instances push the tick to connected WS clients in the `ticker:AAPL` room.

## 4. Rate Limiting and Backpressure
- Market data ticks are throttled at the service level (e.g., max 4 updates per second per symbol) to prevent overwhelming the browser.
