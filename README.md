# TradeAlpha

TradeAlpha is a full-stack, distributed, high-performance financial trading simulator. It features a microservice backend architected around double-entry accounting, in-memory execution engines, and exact idempotency, fronted by a modern React-based Next.js web application.

## 1. Project Overview
TradeAlpha provides V1 capabilities for a trading exchange simulator, including:
- Spot trading (MARKET, LIMIT, STOP, STOP_LIMIT orders)
- Margin & short selling with forced liquidation protections
- Deterministic Double-Entry Ledger accounting
- Programmatic API with scoped API Keys, HMAC authentication, and Webhooks
- Real-time market ticks, OHLCV aggregates, and execution states via WebSockets
- A responsive frontend dashboard and trading terminal

## 2. Architecture Overview
- **`apps/api` (Backend):** Node.js/TypeScript monolith functionally partitioned into:
  - **API Service:** Handles REST boundaries, authentication, and HTTP request routing.
  - **Trading Engine:** In-memory order book execution and continuous matching, leasing partitions from Redis.
  - **Workers:** BullMQ consumers processing Outbox execution jobs, webhooks, and margin sweeps.
  - **Feed Simulator:** Generates deterministic synthetic market ticks.
- **`apps/web` (Frontend):** Next.js 16.3 React application leveraging TailwindCSS, Shadcn, and Playwright for E2E validation.
- **Infrastructure:**
  - **PostgreSQL 15:** Authoritative source of truth for all financial and relational data.
  - **Redis 7:** Ephemeral lease coordination, rate limiting, PubSub, and BullMQ queues.
  - **OpenTelemetry/Prometheus/Jaeger:** Full tracing and metrics instrumentation.

## 3. Prerequisites
- **Node.js:** v18 or v20
- **npm:** v9+
- **Docker & Docker Compose** (for local infrastructure)
- **kubectl & kind / minikube** (optional, for local Kubernetes validation)

## 4. Repository Structure
```text
TradeAlpha/
├── apps/
│   ├── api/          # Node.js Backend & Trading Engine
│   └── web/          # Next.js Frontend
├── k8s/              # Kubernetes local deployment manifests
├── docs/             # Extensive architectural documentation
├── docker-compose.yml# Local infrastructure (Postgres, Redis, Observability)
└── package.json      # NPM workspaces root
```

## 5. Environment Configuration
Create a `.env` file at the root of the repository. Use the provided `.env.example` if available, or configure the following block:

```bash
# Database & Redis
DATABASE_URL="postgresql://tradealpha:password@localhost:5433/tradealpha?schema=public"
REDIS_URL="redis://localhost:6379"

# Security (Use dummy values for local development)
JWT_SECRET="local-dev-secret-do-not-use-in-prod"
SESSION_SECRET="local-session-secret"

# Frontend / Public API
FRONTEND_URL="http://localhost:3000"
API_URL="http://localhost:4000"
```

## 6. Local Development Startup

### A. Infrastructure
Start the backend dependencies via Docker Compose:
```bash
docker-compose up -d postgres redis
```
*(Optional) To start observability tools (Jaeger, Prometheus, Grafana), run `docker-compose up -d`.*

### B. Database Setup
Initialize the database schema and generate the Prisma client:
```bash
cd apps/api
npx prisma generate
npx prisma db push
```

### C. Seeding the E2E Environment
Seed the database with the baseline user and portfolio required for testing:
```bash
npm run seed:e2e --workspace=api
```
*Creates user: `playwright@tradealpha.local` / `Playwright123!`*

### D. Starting the Application
Start the entire stack (API, Engine, Workers, Feed, and Frontend) concurrently from the root:
```bash
npm run dev:all
```
- **Frontend** is available at: `http://localhost:3000`
- **Backend API** is available at: `http://localhost:4000`

---

## 7. Development Commands
- **Linting:** `npm run lint:all`
- **Type Checking:** `npm run typecheck:all`
- **Building the Frontend:** `npm run build:all`
- **Running Backend Tests:** `npm run test:all`
- **Running Playwright UI Tests:** 
  ```bash
  # Ensure the dev server is running on localhost:3000 first, then:
  npm run test:e2e
  ```

## 8. Observability Endpoints (Local)
If started via `docker-compose up -d`:
- **Grafana:** `http://localhost:3001` (admin/admin)
- **Jaeger UI:** `http://localhost:16686`
- **Prometheus:** `http://localhost:9090`

## 9. Kubernetes Local Deployment
Local Kubernetes manifests are provided via Kustomize in the `/k8s` directory.
```bash
# Apply all manifests to the local cluster
kubectl apply -k k8s/
```
**Warning:** The provided StatefulSets are for local validation only (Minikube / Kind). 

## 10. Public API & Programmatic Access
TradeAlpha exposes public REST API endpoints under `/api/*` for algorithmic clients.
- **API Keys:** Generated via the Developer Portal UI (`/developer`). The raw secret is displayed exactly once.
- **HMAC Authentication:** Public endpoints require `X-API-Key`, `X-Timestamp`, and `X-Signature` headers. Signatures are generated using HMAC-SHA256 over the request body and timestamp to prevent replay attacks.
- **Webhooks:** Register webhook endpoints in the Developer Portal. TradeAlpha signs outgoing payloads with a symmetric secret utilizing the `X-TradeAlpha-Signature` header. Delivery operates on an exponential retry backoff queue.

---

## 11. ⚠️ LOCAL vs PRODUCTION DEPLOYMENT ⚠️
**The configurations within this repository represent LOCAL DEVELOPMENT and SIMULATOR READINESS.**

**NOT IMPLEMENTED FOR PRODUCTION:**
The current `docker-compose.yml` and `k8s/` configurations **DO NOT** constitute a Production High-Availability (HA) cloud deployment. 
Before public internet launch, DevOps teams MUST provision:
1. **Managed PostgreSQL:** (e.g., AWS Aurora) with Point-in-Time Recovery (PITR) and automated backups.
2. **Managed Redis:** (e.g., AWS ElastiCache) configured in cluster mode for HA PubSub and Queues.
3. **Ingress & TLS:** NGINX or ALB Ingress controllers with valid TLS certificates (Cert-Manager).
4. **WAF & DNS:** Cloudflare or AWS WAF to mitigate DDoS and manage public API rate limit boundaries aggressively.
5. **Secret Management:** AWS Secrets Manager or HashiCorp Vault to securely inject `JWT_SECRET` and `DATABASE_URL` instead of relying on `ConfigMap` or `.env` files.

*Do not deploy TradeAlpha to a public cloud by blindly applying the local k8s directory.*
