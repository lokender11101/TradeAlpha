# ADR 001: Modular Monolith

## Status
Accepted

## Context
TradeAlpha is a complex platform with distinct domains (auth, trading, analytics). A microservices architecture could provide independent scalability, but introduces significant operational overhead (deployment, distributed tracing, network latency).

## Decision
We will build the backend as a **Modular Monolith**. All domains will run in a single Node.js process, but will be strictly separated into logical modules. Modules communicate via standard function calls or an internal event bus.

## Consequences
- **Pros**: Easy to deploy, test, and debug. No network latency between domains. Strong typing and refactoring capabilities across the codebase.
- **Cons**: Requires strict discipline to maintain module boundaries. Cannot scale domains independently out of the box (must scale the entire monolith).
