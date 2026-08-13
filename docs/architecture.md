# System Architecture Document

## 1. High-Level Architecture
TradeAlpha is designed as a **Modular Monolith**. This approach minimizes initial operational complexity while maintaining strict domain boundaries, allowing individual modules to be extracted into microservices in the future if required.

## 2. Tech Stack
- **Frontend**: Next.js, React, TypeScript, Tailwind CSS, TanStack Query, Lightweight Charts.
- **Backend API**: Node.js, Express.js, TypeScript.
- **Real-Time Gateway**: WebSockets (ws/Socket.io).
- **Database**: PostgreSQL (Primary source of truth).
- **Cache & Pub/Sub**: Redis.
- **Background Jobs**: BullMQ.

## 3. Core Modules
- `auth`: JWT token issuance, session management, password hashing.
- `users`: Profile management, preferences.
- `market-data`: Abstraction layer for external market data providers.
- `orders`: Order placement, validation, and lifecycle management.
- `execution`: The simulated matching engine (processes pending orders against real-time data).
- `portfolio` & `positions`: P&L calculation, risk evaluation, and balance tracking.
- `notifications`: Alerts, WebSockets dispatching.
- `analytics`: Performance metrics calculation.

## 4. Data Flow
1. **Market Data Ingestion**: The `market-data` service pulls/receives live prices, caches them in Redis, and publishes updates via Redis Pub/Sub.
2. **Order Execution**: A user places an order via REST API. The `orders` module validates funds/risk and saves the order to PostgreSQL. The `execution` engine listens to market data ticks and processes open orders.
3. **Real-time Updates**: When an order executes, it updates PostgreSQL, emits an event to Redis, and the WebSocket Gateway pushes the update to the connected client.
