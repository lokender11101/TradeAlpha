# ADR 002: PostgreSQL

## Status
Accepted

## Context
A paper-trading application handles financial transactions, balances, and orders. Data integrity, ACID compliance, and concurrency control are paramount.

## Decision
We will use **PostgreSQL** as the primary relational database. We will leverage its robust transaction support and row-level locking (`SELECT ... FOR UPDATE`) to manage concurrent balance and position updates safely.

## Consequences
- **Pros**: Proven reliability, strict schema validation, excellent concurrency control, JSONB support if semi-structured data is needed.
- **Cons**: Scaling writes horizontally requires complex sharding or moving to a NewSQL database, though a single beefy instance will suffice for our target load.
