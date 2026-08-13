# Repository Structure

TradeAlpha uses a monorepo structure to keep frontend and backend in sync, simplifying CI/CD and developer setup.

```text
TradeAlpha/
├── apps/
│   ├── web/                # Next.js Frontend
│   │   ├── src/
│   │   │   ├── components/ # Reusable UI components
│   │   │   ├── pages/      # Route definitions
│   │   │   ├── lib/        # API clients, WS logic
│   │   │   └── styles/     # Tailwind config, global CSS
│   │   └── package.json
│   │
│   ├── api/                # Node.js Express Backend (Modular Monolith)
│   │   ├── src/
│   │   │   ├── modules/    # Domain modules (auth, orders, portfolio)
│   │   │   ├── db/         # Knex/Prisma config and migrations
│   │   │   ├── ws/         # WebSocket server logic
│   │   │   ├── core/       # Error handling, middleware, logger
│   │   │   └── index.ts    # Entry point
│   │   └── package.json
│
├── packages/               # Shared code (optional, e.g., types)
│   └── types/              # Shared TypeScript definitions
│
├── docs/                   # Architecture, ADRs, PRD
├── infra/                  # Docker Compose, Terraform/AWS scripts
├── .github/workflows/      # CI/CD pipelines
├── package.json            # Root workspace config
└── README.md
```
