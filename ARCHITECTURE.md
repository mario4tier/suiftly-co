# Suiftly Architecture

## Overview

Customer-facing platform for Suiftly services:
- Self-service configuration dashboard (SPA)
- Web3 wallet widget (fund management)
- API backend (api.suiftly.io)
- PostgreSQL database (customer data, configs, HAProxy logs)
- Billing worker (log analysis, usage charging)

Infrastructure (HAProxy, Seal servers, control plane) handled by **walrus** project.

## Principles

1. Self-hosted (control, cost)
2. Rapid development (simple stack)
3. TypeScript everywhere
4. Minimal complexity
5. Cloudflare-like UX

---

## Stack

### Frontend (SPA)

**Framework:** Vite + React 18+
**Routing:** TanStack Router (type-safe, page navigation)
**Styling:** Tailwind CSS + shadcn/ui
**State:**
- Server state: TanStack Query (via tRPC)
- Global UI state: Zustand (auth, theme, sidebar, preferences)
- Form state: React Hook Form
- Route state: URL params

**Forms:** React Hook Form + Zod
**Web3:** @mysten/sui.js + @mysten/dapp-kit (wallet widget component)

### Backend (API)

**Runtime:** Node.js 20+ with TypeScript 5+
**Framework:** Fastify 4+
**API:** tRPC v11 (end-to-end type safety)
**Validation:** Zod (shared schemas with frontend)
**Auth:** Wallet-based authentication (sign-in with Sui) → JWT via jose
**Rate Limit:** @fastify/rate-limit

### Database

**DB:** PostgreSQL 15+ (self-hosted, US-East)
**Extension:** TimescaleDB (HAProxy logs time-series)
**ORM:** Drizzle ORM (TypeScript-first, SQL-like)
**Migrations:** Drizzle Kit

### Billing Worker

**Type:** Periodic cron job (idempotent)
**Runtime:** Node.js or Bun
**Schedule:** Runs hourly (configurable)
**Tasks:** Log aggregation, usage calculation, billing

**Process:**
1. Acquire PostgreSQL advisory lock (prevent concurrent runs)
2. Query unbilled HAProxy logs from PostgreSQL
3. Group by customer, calculate charges
4. Insert billing records (atomic transaction)
5. Mark logs as billed
6. Release lock and exit (wait for next run)

**Design:**
- Idempotent (safe to run multiple times)
- Single-instance guarantee (PG advisory locks)
- Crash-safe (database transactions)
- Resumable (picks up unbilled logs on next run)
- PostgreSQL is source of truth (no job queue needed)

---

## Infrastructure

```
Origin Servers (Self-Hosted)
├─ HAProxy → static SPA (dist/) + /api proxy
├─ API servers → Fastify + tRPC
├─ PostgreSQL + TimescaleDB
└─ Billing Worker (cron job)
```

**Deployment:**
- Frontend: Static files from origin (HAProxy cache)
- API: PM2 on US-East servers
- DB: Self-hosted PostgreSQL (co-located with API)
- Backups: pg_dump → Cloudflare R2

---

## Project Structure

```
suiftly-co/
├─ apps/
│  ├─ webapp/
│  │  ├─ src/
│  │  │  ├─ components/
│  │  │  │  ├─ layout/          # Header, Sidebar, DashboardLayout
│  │  │  │  ├─ wallet/          # WalletWidget, DepositModal, WithdrawModal, EscrowPanel
│  │  │  │  └─ ui/              # shadcn components
│  │  │  ├─ pages/              # Dashboard, Services, Billing, etc.
│  │  │  ├─ lib/                # tRPC client, web3 setup
│  │  │  ├─ stores/             # Zustand stores (auth, ui, preferences, wallet)
│  │  │  └─ main.tsx
│  │  └─ package.json
│  │
│  └─ api/
│     ├─ src/
│     │  ├─ routes/             # tRPC routers
│     │  ├─ services/           # Business logic
│     │  ├─ db/                 # DB connection
│     │  └─ server.ts
│     └─ package.json
│
├─ packages/
│  ├─ database/                 # Drizzle schema, migrations
│  └─ shared/                   # Shared types, Zod schemas, utils
│
└─ services/
   └─ billing-worker/           # Cron-based billing processor
```

**Monorepo:** Turborepo + npm workspaces

---

## State Management Strategy

**Zustand (Global UI):**
- `stores/auth.ts` - user session, login/logout
- `stores/ui.ts` - theme, sidebar open/closed
- `stores/preferences.ts` - pinned services, default views
- `stores/wallet.ts` - wallet widget expanded state
- All use `persist()` middleware for localStorage

**TanStack Query (Server Data):**
- API data fetching via tRPC
- Auto-caching, invalidation
- On-demand queries (`enabled: false` for charts/stats)

**React Hook Form (Forms):**
- Temporary edit state
- `watch()` for conditional fields
- Zod resolver for validation

**Custom Logic (Pricing):**
- `useMemo()` for price calculations
- Conditional field visibility
- Zod `.refine()` for cross-field validation

---

## Web3 Integration

**Wallet Widget Component:**
- Lives in dashboard header (persistent across routes)
- Collapsible dropdown showing balance
- Actions: Deposit, Withdraw
- Expandable escrow options (modal/accordion)

**Implementation:**
```typescript
<Header>
  <Logo />
  <WalletWidget />  {/* @mysten/dapp-kit */}
  <UserMenu />
</Header>
```

---

## Database Schema

**customers** - id, email, name, subscription_tier, wallet_address
**service_configs** - id, customer_id, service_type, config_json
**haproxy_logs** (TimescaleDB) - timestamp, customer_id, method, path, status, bytes_sent
**usage_metrics** - customer_id, period, total_requests, total_bandwidth, amount_charged
**billing_transactions** - customer_id, amount, status, transaction_hash

**TimescaleDB:**
```sql
SELECT create_hypertable('haproxy_logs', 'timestamp');
SELECT add_retention_policy('haproxy_logs', INTERVAL '90 days');
SELECT add_compression_policy('haproxy_logs', INTERVAL '7 days');
```

---

## API Routes (tRPC)

```typescript
appRouter = {
  auth: { connectWallet, verifySignature, refresh },
  customer: { getProfile, updateProfile },
  services: { list, getConfig, updateConfig },
  billing: { getUsage, getInvoices },
  logs: { query },
  wallet: { getBalance, deposit, withdraw }
}
```

---

## Development

**Local Setup:**
```bash
npm install
cd packages/database && npm run db:push

# Terminal 1: API
cd apps/api && npm run dev

# Terminal 2: WebApp
cd apps/webapp && npm run dev

# Terminal 3: Worker (optional)
cd services/billing-worker && npm run dev
```

**CI/CD Pipeline (GitHub Actions):**
```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  validate:
    - npm ci
    - turborepo build (all packages)
    - typecheck (tRPC + Drizzle schemas)
    - lint + tests
    - migration check (fail if schema changed but no migration)

  deploy (main branch only):
    - build artifacts
    - run migrations (db:migrate)
    - rolling deploy to API servers
```

**Migration Validation:**
- CI fails if `packages/database/src/schema/**` changed but no new migration in `migrations/`
- Prevents accidental `db:push` to production
- Enforces migration-first workflow for production deploys

**Database Workflow:**

**Development (rapid iteration):**
```bash
# Edit schema, push instantly (no migration files)
vim packages/database/src/schema/services.ts
npm run db:push

# Change your mind? Push again (overwrites)
npm run db:push

# Experiment freely - iterations not tracked
```

**Production (clean deployment):**
```bash
# When feature ready, generate ONE migration
npm run db:generate

# Review generated SQL (ensure backward-compatible)
cat packages/database/migrations/0005_feature.sql

# Commit migration
git add packages/database/migrations/
git commit -m "Migration: add feature"

# Deploy (runs migration first)
./deploy.sh
```

**Commands:**
- `npm run db:push` - Dev: instant sync (no migration files)
- `npm run db:generate` - Prod: create migration from schema
- `npm run db:migrate` - Prod: apply migrations
- `npm run db:studio` - Visual DB editor

**Strategy:** Push freely in dev (separate DB), generate once for prod. Final migration = working solution only.

---

## Key Dependencies

**Frontend:**
- react, @tanstack/react-router, @tanstack/react-query
- @trpc/client, @trpc/react-query
- zustand, react-hook-form, zod
- @mysten/sui.js, @mysten/dapp-kit
- tailwindcss, vite

**Backend:**
- fastify, @fastify/jwt, @fastify/cors
- @trpc/server, drizzle-orm, postgres
- zod, jose, pino

**Worker:**
- node-cron, drizzle-orm, postgres

---

## Deployment (Zero-Downtime)

**Build:**
```bash
cd apps/webapp && npm run build  # → dist/
cd apps/api && npm run build     # → dist/
cd services/billing-worker && npm run build
```

**Rolling Deployment Script:**
```bash
#!/bin/bash
# deploy.sh

# 1. Run migrations (backward-compatible only)
npm run db:migrate

# 2. Rolling update API servers (zero downtime)
for SERVER in api1 api2 api3; do
  # Upload new version
  rsync -avz apps/api/dist/ $SERVER:/var/www/api/

  # Graceful reload (PM2 handles zero-downtime)
  ssh $SERVER "pm2 reload suiftly-api"

  # Health check
  sleep 3
  curl -f http://$SERVER:3000/health || exit 1

  echo "$SERVER deployed"
done

# 3. Deploy frontend (static files)
rsync -avz apps/webapp/dist/ origin:/var/www/suiftly-app/

# 4. Deploy worker
rsync -avz services/billing-worker/dist/ api1:/var/www/billing/
ssh api1 "pm2 reload suiftly-billing"

echo "Deployment complete!"
```

**How Zero-Downtime Works:**
```
HAProxy (load balancer)
  ├─→ API Server 1 → PM2 reload → new version (graceful)
  ├─→ API Server 2 → still serving old version
  └─→ API Server 3 → still serving old version

HAProxy automatically routes around restarting servers
```

**Fastify Graceful Shutdown:**
```typescript
// apps/api/src/server.ts
fastify.get('/health', async () => {
  await db.execute(sql`SELECT 1`)
  return { status: 'ok' }
})

process.on('SIGTERM', async () => {
  await fastify.close()  // Finishes existing requests
  process.exit(0)
})
```

**Requirements:**
- HAProxy health checks (`option httpchk GET /health`)
- PM2 graceful reload (`pm2 reload` not `pm2 restart`)
- Stateless JWT (customer can hit any server)
- Backward-compatible migrations (old + new code works)

---

## MCP Servers

**Essential:**
1. @modelcontextprotocol/server-postgres
2. @modelcontextprotocol/server-filesystem
3. @modelcontextprotocol/server-github

**Custom (later):**
4. Sui Blockchain MCP (query network, balances, transactions)
5. HAProxy Logs MCP (parse logs, generate reports)
6. Billing Analytics MCP (usage queries, revenue reports)

---

## Observability

**Logging:**
- Structured JSON logs (pino)
- Request/response logging with trace IDs
- Worker job execution logs

**Metrics (future):**
- API latency, error rates
- Billing worker runs, failures
- Database connection pool stats

**Monitoring (future):**
- Health check endpoints
- Error tracking (Sentry or similar)
- Alert on billing worker failures

---

## Security

- JWT (15min access, 7d refresh, HttpOnly cookies)
- Wallet signature verification (nonce-based challenge)
- Rate limiting (per-user/IP)
- Zod validation (all inputs)
- Drizzle ORM (parameterized queries)
- Never store private keys
- pg_dump backups daily → R2

---

## Next Steps

1. Scaffold monorepo structure
2. Setup PostgreSQL + TimescaleDB
3. Create Drizzle schema
4. Build API (Fastify + tRPC)
5. Build webapp (Vite + React)
6. Connect tRPC client → API → DB
7. Deploy (SCP + PM2)
