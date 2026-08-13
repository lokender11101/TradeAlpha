# ADR 003: Redis

## Status
Accepted

## Context
The platform requires real-time capabilities (WebSockets), caching for frequent read-heavy endpoints (e.g., market data quotes), and rate-limiting.

## Decision
We will use **Redis** for ephemeral state, caching, rate-limiting, and as a Pub/Sub message broker for WebSocket horizontal scaling.

## Consequences
- **Pros**: Extremely fast in-memory operations. Natively supports Pub/Sub. Built-in TTLs make cache invalidation straightforward.
- **Cons**: Adds another infrastructure dependency.
