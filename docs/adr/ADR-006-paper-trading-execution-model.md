# ADR 006: Paper-Trading Execution Model

## Status
Accepted

## Context
We need a simulated trading engine. It must safely execute orders without race conditions (e.g., spending the same cash twice).

## Decision
The engine will use an **asynchronous matching model**.
1. API validates order and reserves cash/margin via DB transaction.
2. Order is saved as `PENDING`.
3. A background worker (or in-memory loop on the monolith) listens to market data ticks and matches `PENDING` orders.
4. Execution triggers a DB transaction using pessimistic locking (`SELECT ... FOR UPDATE`) to verify the balance hasn't changed illegally, finalize the trade, and update the portfolio.

## Consequences
- **Pros**: Deterministic, scalable, closely mimics real exchange async behavior.
- **Cons**: More complex than synchronously executing the trade in the API request, but safer and more realistic.
