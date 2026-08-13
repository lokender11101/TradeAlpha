# ADR 005: BullMQ

## Status
Accepted

## Context
Some tasks in TradeAlpha, such as generating end-of-day portfolio snapshots, processing complex analytical queries, or sending email notifications, are too slow or resource-intensive to run on the main HTTP event loop.

## Decision
We will use **BullMQ** (backed by our existing Redis instance) for background job processing and message queuing.

## Consequences
- **Pros**: Robust job queuing, retries, delayed jobs, and concurrency control. Does not require a new infrastructure component since we already have Redis.
- **Cons**: Relies on Redis persistence characteristics, which are generally acceptable for background jobs.
