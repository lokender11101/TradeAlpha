# ADR 004: WebSockets

## Status
Accepted

## Context
TradeAlpha needs to push real-time market data ticks, order executions, and portfolio updates to clients with sub-100ms latency. Polling (HTTP GET) would overwhelm the server and be too slow.

## Decision
We will use **WebSockets** (ws or Socket.io) for full-duplex communication. The WebSocket server will integrate with Redis Pub/Sub to allow horizontal scaling of the Node.js instances.

## Consequences
- **Pros**: Low latency, reduced HTTP overhead.
- **Cons**: Connection management is complex (heartbeats, reconnects). Load balancers must support sticky sessions or WebSockets properly.
