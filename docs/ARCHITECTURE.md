# Suiftly Architecture

## Overview

Customer-facing platform for Suiftly services:
- Self-service configuration dashboard (SPA)
- Web3 wallet widget (fund management)
- API backend (api.suiftly.io)
- PostgreSQL database (customer data, configs, HAProxy logs)
- Global Manager (centralized worker: billing, metering, vault generation)

Infrastructure (HAProxy, Seal servers, Local Manager) handled by **walrus** project (local repos always at ~/walrus). The control plane spans both repositories - see [CONTROL_PLANE_DESIGN.md](./CONTROL_PLANE_DESIGN.md) for the complete architecture.

## Principles

1. Self-hosted (control, cost)
2. Rapid development (simple stack)
3. TypeScript everywhere
4. Minimal complexity
5. Cloudflare-like UX

---

## Stack

### Frontend (SPA)

**Framework:** Vite 7 + React 19
**Routing:** TanStack Router v1 (type-safe, page navigation)
**Styling:** Tailwind CSS + shadcn/ui
**State:**
- Server state: TanStack Query v5 (via tRPC)
- Global UI state: Zustand (auth, theme, sidebar, preferences)
- Form state: React Hook Form
- Route state: URL params

**Forms:** React Hook Form + Zod
**Web3:** @mysten/sui.js + @mysten/dapp-kit (wallet widget component)

### Backend (API)

**Runtime:** Node.js 22 LTS with TypeScript 5.9
**Framework:** Fastify 5 (v4 EOL June 2025)
**API:** tRPC v11 (end-to-end type safety, SSE subscriptions)
**Validation:** Zod (shared schemas with frontend)
**Auth:** Wallet-based authentication (sign-in with Sui) → JWT via jose
**Rate Limit:** @fastify/rate-limit
**Logging:** pino (structured JSON logs)
**Caching:** lru-cache (application-level LRU cache)
**Process Manager:** PM2 (production process management)

### Database

**DB:** PostgreSQL 17.6+ (avoid 17.1 due to ABI break)
**Extension:** TimescaleDB 2.17+ (fully PG 17 compatible)
**ORM:** Drizzle ORM (TypeScript-first, identity columns, SQL-like)
**Migrations:** Drizzle Kit

**Config Caching:** `config_global` table loaded into memory at server startup (`apps/api/src/lib/config-cache.ts`). Retries for 60s if DB unavailable, then exits (fail-fast for production monitoring). All config reads use O(1) cache lookups (zero DB queries). Tier pricing, bandwidth limits accessed via `getTierPriceUsdCents()`, `getConfig()`. Config updates require server restart.

**Why PostgreSQL 17:**
- 30% better throughput vs PG 16 (1,575 vs 1,238 RPS)
- Improved vacuum memory management (critical for HAProxy log ingestion)
- 2x write throughput for high concurrency workloads
- Longer support timeline (EOL Sep 2029 vs PG 16 EOL Nov 2028)
- TimescaleDB 2.17+ fully supports PG 15, 16, and 17

**Note:** Avoid PostgreSQL 17.1 specifically due to ABI break that affected TimescaleDB. Use 17.2+ (fixed Nov 2024).

### Global Manager

**Type:** Long-lived daemon process (managed by systemd)
**Runtime:** Node.js 22 LTS with TypeScript
**Location:** Co-located with PostgreSQL (primary database server)
**Schedule:** Internal setInterval loop (every 5 minutes, configurable)

**Responsibilities:**
1. **Metering** - Aggregate HAProxy logs into usage metrics
2. **Billing** - Calculate customer charges from usage data
3. **Vault Generation** - Generate MA_VAULT (customer API keys, rate limits, tier configs)
4. **Data Cleanup** - Remove old logs and maintain database health

**Process (each cycle):**
1. Acquire PostgreSQL advisory lock (prevent concurrent runs)
2. Aggregate unbilled HAProxy logs into usage metrics
3. Calculate charges and insert billing records (atomic transaction)
4. Generate MA_VAULT with customer configurations
5. Clean up old data
6. Release lock and wait for next cycle

**Design:**
- Long-lived daemon (systemd keeps process running)
- Internal scheduling (setInterval loop, zero dependencies)
- Single-instance guarantee (PG advisory locks)
- Idempotent cycles (safe to run multiple times)
- Crash-safe (database transactions)
- Resumable (picks up unbilled logs on next cycle)
- Graceful shutdown (handles SIGTERM/SIGINT)
- PostgreSQL is source of truth (no job queue needed)
- Admin dashboard (port 22600) for debugging and monitoring

**For detailed design, see [CONTROL_PLANE_DESIGN.md](./CONTROL_PLANE_DESIGN.md)**

---

## Infrastructure

```
Origin Servers (Self-Hosted)
├─ HAProxy → static SPA (dist/) + /api proxy
├─ API servers → Fastify + tRPC
├─ PostgreSQL + TimescaleDB
└─ Global Manager (daemon service, co-located with PostgreSQL)
```

**Deployment:**
- Frontend: Static files from origin (HAProxy cache)
- API: PM2 on US-East servers
- DB: Self-hosted PostgreSQL (co-located with API)
- Backups: pg_dump → Cloudflare R2 (daily via cron)
- **All operations via idempotent Python scripts** (disaster recovery ready)

---

## Cross-Repository Dependencies

### Layered Architecture

The Suiftly infrastructure uses a two-repository model with clear dependency direction:

```
┌─────────────────────────────────────────────────────────────────┐
│  ~/walrus (Base Layer)                                          │
│  Deployed: ALL servers (gateway + primary)                      │
│                                                                 │
│  Contains:                                                      │
│  - Infrastructure scripts (Python)                              │
│  - HAProxy configuration                                        │
│  - SEAL key-server management                                   │
│  - sync-files.py (VAULT distribution)                          │
│  - Local Manager (TypeScript service)                          │
│  - @mhaxbe/shared (shared types package)                       │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                              │ suiftly-co imports from walrus
                              │ (never the reverse)
┌─────────────────────────────────────────────────────────────────┐
│  ~/suiftly-co (NetOps Layer)                                    │
│  Deployed: Primary server only (eu-w1-1)                        │
│                                                                 │
│  Contains:                                                      │
│  - Global Manager (billing, metering, VAULT generation)        │
│  - API Server (customer-facing)                                │
│  - Webapp (dashboard SPA)                                      │
│  - PostgreSQL schemas                                          │
└─────────────────────────────────────────────────────────────────┘
```

**Key principle**: Gateway servers only need `~/walrus` deployed. The `~/suiftly-co` repository is only deployed on the primary server (eu-w1-1) where PostgreSQL and the Global Manager run.

### @mhaxbe/shared Package

Shared TypeScript types are defined in `~/walrus/services/shared/` and imported by both repositories:

**Package location:** `~/walrus/services/shared/`

**Importing in suiftly-co:**

```json
// package.json (root or services/global-manager)
{
  "dependencies": {
    "@mhaxbe/shared": "file:../walrus/services/shared"
  }
}
```

**Usage:**
```typescript
// services/global-manager/src/tasks/aggregate-status.ts
import { ServerStatusReport, CustomerConfig } from '@mhaxbe/shared'

// Full type safety for:
// - Status reports from Local Managers
// - VAULT file format (customer configs)
// - Health check interfaces
```

### Shared Types

Types defined in `@mhaxbe/shared`:

| Type | Description | Used By |
|------|-------------|---------|
| `ServerStatusReport` | Health reports from Local Manager | Global Manager (receives), Local Manager (sends) |
| `CustomerConfig` | Customer API keys, tier, limits | Global Manager (generates), Local Manager (consumes) |
| `TierLimits` | Rate limit configuration | Both |
| `HealthCheck` | Health check request/response | Both |

### Development Workflow

When working on features that span both repositories:

1. **Update shared types first** (if needed):
   ```bash
   cd ~/walrus/services/shared
   # Edit types
   npm run build
   ```

2. **Update Local Manager** (walrus):
   ```bash
   cd ~/walrus/services/local-manager
   npm run dev
   ```

3. **Update Global Manager** (suiftly-co):
   ```bash
   cd ~/suiftly-co/services/global-manager
   npm install  # Picks up @mhaxbe/shared changes
   npm run dev
   ```

### Deployment Model

| Server | Repositories | Services |
|--------|--------------|----------|
| **eu-w1-1** (Primary) | walrus + suiftly-co | Global Manager, API, Webapp, PostgreSQL, HAProxy, Local Manager |
| **us-e1-1** (Gateway) | walrus only | HAProxy, Local Manager, SEAL key-server |
| **us-w1-1** (Gateway) | walrus only | HAProxy, Local Manager, SEAL key-server |
| **as-s1-1** (Gateway) | walrus only | HAProxy, Local Manager, SEAL key-server |

**For detailed control plane design, see [CONTROL_PLANE_DESIGN.md](./CONTROL_PLANE_DESIGN.md)**

**For Local Manager implementation, see [~/walrus/docs/LOCAL_MANAGER_FEATURE.md](~/walrus/docs/LOCAL_MANAGER_FEATURE.md)**

---

## Caching Strategy

**Application-Level Caching (No Redis)**

For simplicity and reduced operational overhead, the platform uses **application-level caching** instead of external cache services like Redis.

**Cache Layers:**
1. **PostgreSQL Built-in** - Automatic query result caching in shared_buffers
2. **Materialized Views** - Pre-computed aggregates refreshed every 30 seconds
3. **Application Memory** - In-memory LRU cache with TTL for frequently accessed data
4. **HTTP Cache Headers** - CDN/browser caching for public endpoints

**Implementation:**
```typescript
// Application-level cache for API responses
// Using lru-cache package: npm install lru-cache
import { LRUCache } from 'lru-cache'

class AppCache {
  private cache = new LRUCache<string, any>({
    max: 10000,      // Max entries
    ttl: 30 * 1000   // 30 second TTL
  });

  async get(key: string, fetcher: () => Promise<any>) {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const fresh = await fetcher();
    this.cache.set(key, fresh);
    return fresh;
  }
}
```

**Benefits:**
- No external dependencies to maintain or secure
- Simpler disaster recovery (no Redis to restore)
- Sufficient performance for dashboard operations
- Each API server maintains its own cache (acceptable redundancy)

**Trade-offs:**
- Cache not shared across API servers (acceptable for 1-3 servers)
- Cache lost on server restart (rebuilds quickly from DB)

**Security: Per-User Cache Keys**
- Protected endpoints MUST use per-user cache keys: `cache.get(\`user:\${userId}:api-keys\`)`
- Public endpoints can use global keys: `cache.get('public:service-list')`
- Never cache sensitive data globally (prevents data leakage across users)

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
│     │  ├─ services/           # Enterprise logic
│     │  ├─ db/                 # DB connection
│     │  └─ server.ts
│     └─ package.json
│
├─ packages/
│  ├─ database/                 # Drizzle schema, migrations, fixtures
│  │  ├─ src/
│  │  │  ├─ schema/             # Table definitions
│  │  │  ├─ migrations/         # Generated SQL migrations
│  │  │  └─ testUtils.ts        # resetTestDB, seed helpers
│  │  └─ tests/                 # Migration tests
│  └─ shared/                   # Shared types, Zod schemas, utils
│
├─ services/
│  └─ global-manager/           # Centralized worker (metering, billing, vault generation)
│     ├─ src/
│     │  ├─ index.ts            # Main daemon (scheduler loop)
│     │  ├─ admin-server.ts     # Admin dashboard (port 3001)
│     │  ├─ admin/              # HTML templates (TypeScript functions)
│     │  ├─ tasks/              # Worker tasks (aggregate, bill, vault, cleanup)
│     │  └─ lib/                # Utilities (lock, db)
│     └─ package.json
│
└─ scripts/                     # Idempotent deployment scripts (see Deployment section)
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

**For complete database schema with all tables, see [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md#database-schema-summary).**

**For API key format and implementation, see [API_KEY_DESIGN.md](./API_KEY_DESIGN.md).**

**Key tables used by this architecture:**

- **customers** - customer_id (random 32-bit), wallet_address, escrow_contract_id, balance, monthly limits
- **service_instances** - instance_id, customer_id, service_type, tier, is_user_enabled, config (JSONB)
- **api_keys** - api_key_id, customer_id, service_type, derivation, is_user_enabled (see [API_KEY_DESIGN.md](./API_KEY_DESIGN.md))
- **haproxy_logs** (TimescaleDB hypertable) - timestamp, customer_id, service_type, method, status_code, bytes_out
- **usage_records** - customer_id, service_type, request_count, window_start, window_end, charged_amount
- **escrow_transactions** - customer_id, tx_digest, tx_type, amount, timestamp
- **config_global** - key-value configuration table for system-wide settings (see below)

### ConfigGlobal Table

**Purpose:** Single source of truth for system-wide configuration that controls both frontend display and backend behavior.

**Schema:**
```typescript
{
  key: string (primary key)  // Unique configuration key
  value: string               // Configuration value (string representation)
}
```

**Access:**
- Each development environment has its own ConfigGlobal (from local test DB)
- Production has a single ConfigGlobal (in production DB)
- Heavily cached by application layer (LRU cache with TTL)
- No fallback/default values - database is single source of truth

**Frontend Configuration Keys (f*):**

Controls what is displayed on the Seal service overview page:

| Key | Description | Example Value |
|-----|-------------|---------------|
| `fver` | Config version (increment to force client reload) | `1` |
| `freg_count` | Number of regions (for calculating global bandwidth) | `3` |
| `fbw_sta` | Starter tier bandwidth (req/s per region) | `3` |
| `fbw_pro` | Pro tier bandwidth (req/s per region) | `15` |
| `fbw_ent` | Enterprise tier bandwidth (req/s per region) | `100` |
| `fsubs_usd_sta` | Starter tier subscription fee | `9` |
| `fsubs_usd_pro` | Pro tier subscription fee | `29` |
| `fsubs_usd_ent` | Enterprise tier subscription fee | `185` |
| `freqs_usd` | Usage-based pricing (USD) | `1.00` |
| `freqs_count` | Requests per pricing unit | `10000` |
| `fskey_incl` | Included Seal keys | `1` |
| `fskey_pkg_incl` | Included packages per key | `3` |

**Version Tracking:**
- `fver` should be incremented whenever important fields change (e.g., pricing)
- Client can periodically check version and force reload if out of sync
- Future enhancement: background polling to detect version mismatch

**Backend Configuration Keys (b*):**

Controls backend behavior and rate limiting:

| Key | Description | Example Value |
|-----|-------------|---------------|
| `bglim_sta` | Guaranteed limit for Starter tier (req/s) | `3` |
| `bglim_pro` | Guaranteed limit for Pro tier (req/s) | `15` |
| `bglim_ent` | Guaranteed limit for Enterprise tier (req/s) | `100` |

**Usage Pattern:**
```typescript
// API endpoint fetches all f* keys for frontend
GET /api/config/frontend -> { fbw_sta: "100", ... }

// Backend reads b* keys for rate limiting
const guaranteedLimit = await getConfig('bglim_pro') // "500"
```

**Caching Strategy:**
- Cache invalidation: Manual (admin dashboard or script)
- TTL: 5 minutes (values rarely change)
- Cache key: `config:global:{key}` for single values, `config:global:frontend` for all fe_* keys

**TimescaleDB Configuration:**
```sql
SELECT create_hypertable('haproxy_logs', 'timestamp', chunk_time_interval => INTERVAL '7 days');
SELECT add_retention_policy('haproxy_logs', INTERVAL '90 days');
SELECT add_compression_policy('haproxy_logs', INTERVAL '7 days');
```

**Tiers:** Starter, Pro, Enterprise (see [UI_DESIGN.md](./UI_DESIGN.md) (pricing and tier configuration) for rate limits and pricing)

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

**PostgreSQL Setup (Native - Production Parity):**

Both development and production use **native PostgreSQL** (no Docker). This ensures identical behavior, performance, and troubleshooting.

**Development Environment:** Ubuntu 22.04 LTS (native or WSL2)

```bash
# Install PostgreSQL 17 + TimescaleDB 2.17+
sudo apt update
sudo apt install postgresql-17 postgresql-17-timescaledb

# Start PostgreSQL service
sudo service postgresql start

# Create deploy user (minimal permissions for API runtime)
sudo -u postgres psql <<SQL
CREATE USER deploy WITH PASSWORD 'deploy_password_change_me';
SQL
```

**Database Users (Two-User Model):**

We use **production-like minimal permissions** even in development to catch permission issues early:

1. **`postgres` (superuser)** - Database setup, migrations, test data reset
2. **`deploy` (minimal runtime)** - DML operations (SELECT/INSERT/UPDATE/DELETE/TRUNCATE)

**Why:** The `deploy` user has NO DDL permissions (can't CREATE/ALTER/DROP tables). This ensures:
- Permission issues are caught in dev, not production
- Migrations run as `postgres`, API runs as `deploy`
- Production-ready security model from day one
- Automated verification runs on server startup (fails fast if DDL not blocked)

**First-Time Project Setup:**
```bash
# Install dependencies
npm install

# Create databases and apply migrations (uses postgres for setup, grants permissions to deploy)
./scripts/dev/reset-database.sh

# This will:
# 1. Create suiftly_dev database
# 2. Install TimescaleDB extension
# 3. Apply migrations
# 4. Grant minimal permissions to deploy user
# 5. Verify permissions

# API will use deploy user from DATABASE_URL in packages/database/.env
# DATABASE_URL=postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev
```

**Development Ports (Fixed - No Port Hopping):**

| Service | Port | Configuration File | Notes |
|---------|------|-------------------|-------|
| **API Server** | **22700** | `apps/api/.env` (PORT=22700) | tRPC + REST endpoints |
| **Web App (Vite)** | **22710** | `apps/webapp/vite.config.ts` | Frontend SPA (dev only) |
| **Global Manager** | **22600** | `services/global-manager/.env` | Admin dashboard (localhost only) |

**Port Allocation:** See [~/walrus/PORT_MAP.md](~/walrus/PORT_MAP.md) for the single source of truth. In production, multiple API servers (22700-22703) run behind HAProxy.

**Port Enforcement:**
- Playwright config uses `baseURL: 'http://localhost:22710'` (see [playwright.config.ts](../playwright.config.ts))
- Vite should NOT auto-increment ports - always use 22710
- If port 22710 is occupied, kill the process: `lsof -ti:22710 | xargs kill`
- Test files should use `page.goto(BASE_URL)` from playwright `baseURL`, NOT hardcoded ports

**Daily Development Workflow:**

**Background Mode (Recommended - Claude Code can observe output):**
```bash
# Start dev servers in background (Claude Code observes hot reloads, errors, logs)
npm run dev --prefix apps/api &
npm run dev --prefix apps/webapp &

# Optional: Global Manager (typically runs as systemd daemon in production)
npm run dev --prefix services/global-manager &

# Claude Code can monitor output using BashOutput tool
# This accelerates development by detecting errors, confirming hot reloads, analyzing logs

# Run tests (uses suiftly_test database)
npm run test
```

**Manual Mode (Alternative - direct terminal control):**
```bash
# Terminal 1: API
cd apps/api && npm run dev

# Terminal 2: WebApp
cd apps/webapp && npm run dev

# Terminal 3: Global Manager (optional)
cd services/global-manager && npm run dev
```

**Database Management:**
```bash
# Development scripts
./scripts/dev/reset-database.sh    # Full reset: drop, create, migrate, grant permissions

# Test data reset (no sudo required - uses deploy user TRUNCATE permission)
curl -X POST http://localhost:22700/test/data/truncate-all  # Quick reset: truncate all tables

# Drizzle commands
npm run db:studio        # Visual database browser (Drizzle Studio)
npm run db:push          # Dev: sync schema instantly (no migration files)
npm run db:generate      # Prod: create migration from schema changes
npm run db:migrate       # Prod: apply migrations (run as postgres)

# Deploy user permissions (what API can do)
# ✅ SELECT, INSERT, UPDATE, DELETE, TRUNCATE on all tables (dev includes TRUNCATE for test resets)
# ✅ USAGE on sequences (for auto-increment IDs)
# ❌ NO CREATE/ALTER/DROP tables (DDL blocked, verified on startup)
# Startup verification: Server checks DDL operations fail (fail-fast if misconfigured)
```

**CI/CD Pipeline (GitHub Actions):**
```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  test:
    services:
      postgres:
        image: timescale/timescaledb:latest-pg17
        env:
          POSTGRES_DB: suiftly_test
    steps:
      - npm ci
      - npm run test:unit          # Fast unit tests
      - npm run test:integration   # API + DB tests
      - npm run test:e2e          # E2E (main branch only)

  validate:
    - turborepo build (all packages)
    - typecheck (tRPC + Drizzle schemas)
    - lint
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

## Deployment (Zero-Downtime)

**Philosophy:** All deployment and server provisioning uses **idempotent Python scripts** (Python 3.10+). Scripts check current state and only perform necessary actions. Safe to run repeatedly. Critical for disaster recovery and spinning up new servers quickly.

**Deployment Scripts Structure:**
```
scripts/
├─ provision-server.py      # New server setup (PostgreSQL, Node.js, PM2)
├─ deploy.py                # Application deployment (rolling updates)
├─ backup.py                # Database backup to R2
├─ restore.py               # Restore from backup
└─ lib/
   ├─ server.py             # SSH, rsync utilities
   ├─ postgres.py           # PostgreSQL management
   └─ healthcheck.py        # Health check utilities
```

**Build Artifacts:**
```bash
# Local build (before deployment)
npm run build  # Turborepo builds all apps
# → apps/webapp/dist/
# → apps/api/dist/
# → services/global-manager/dist/
```

**Provision New Server (Idempotent):**
```python
#!/usr/bin/env python3
# scripts/provision-server.py

"""
Idempotent server provisioning for Suiftly API/DB servers.
Safe to run multiple times - only installs missing components.
"""

import argparse
from lib.server import SSH

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('host', help='Server hostname or IP')
    parser.add_argument('--role', choices=['api', 'db'], required=True)
    args = parser.parse_args()

    ssh = SSH(args.host)

    # Install PostgreSQL 17 + TimescaleDB 2.17+ (idempotent)
    if args.role == 'db':
        if not ssh.check_installed('postgresql-17'):
            ssh.apt_install(['postgresql-17', 'postgresql-17-timescaledb'])
            ssh.systemctl('enable', 'postgresql')
            ssh.systemctl('start', 'postgresql')

        # Create databases if not exist
        ssh.run_as_postgres("""
            SELECT 'CREATE DATABASE suiftly_prod'
            WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'suiftly_prod')
            \\gexec
        """)

        ssh.run_as_postgres("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE", db='suiftly_prod')

    # Install Node.js 22 LTS + PM2 (idempotent)
    if args.role == 'api':
        if not ssh.check_command('node --version | grep v22'):
            ssh.run('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -')
            ssh.apt_install(['nodejs'])

        if not ssh.check_command('pm2 --version'):
            ssh.run('npm install -g pm2')
            ssh.run('pm2 startup systemd -u deploy --hp /home/deploy')

    # Create directory structure (idempotent)
    ssh.run('mkdir -p /var/www/{api,global-manager,webapp}')
    ssh.run('chown -R deploy:deploy /var/www')

    print(f"✓ Server {args.host} provisioned successfully")

if __name__ == '__main__':
    main()
```

**Application Deployment (Rolling Updates):**
```python
#!/usr/bin/env python3
# scripts/deploy.py

"""
Zero-downtime rolling deployment.
Idempotent - safe to re-run if deployment fails mid-way.
"""

import sys
from lib.server import SSH, rsync
from lib.postgres import run_migrations
from lib.healthcheck import wait_for_health

SERVERS = {
    'api': ['api1.suiftly.io', 'api2.suiftly.io', 'api3.suiftly.io'],
    'db': 'db1.suiftly.io'
}

def deploy():
    # 1. Run database migrations (idempotent by design)
    print("→ Running migrations...")
    run_migrations(SERVERS['db'], database='suiftly_prod')

    # 2. Rolling update API servers (zero downtime)
    for server in SERVERS['api']:
        print(f"→ Deploying to {server}...")
        ssh = SSH(server)

        # Upload new version (rsync is idempotent)
        rsync('apps/api/dist/', f'{server}:/var/www/api/')

        # Graceful reload (PM2 handles zero-downtime)
        ssh.run('pm2 reload suiftly-api || pm2 start /var/www/api/server.js --name suiftly-api')

        # Health check (wait up to 30s)
        if not wait_for_health(f'http://{server}:3000/health', timeout=30):
            print(f"✗ Health check failed for {server}")
            sys.exit(1)

        print(f"✓ {server} deployed successfully")

    # 3. Deploy frontend (static files, idempotent)
    print("→ Deploying webapp...")
    rsync('apps/webapp/dist/', 'origin.suiftly.io:/var/www/webapp/')

    # 4. Deploy global manager (idempotent)
    print("→ Deploying global manager...")
    db_server = SERVERS['db']
    ssh = SSH(db_server)
    rsync('services/global-manager/dist/', f'{db_server}:/var/www/global-manager/')
    ssh.run('systemctl restart suiftly-global-manager.service')

    print("✓ Deployment complete!")

if __name__ == '__main__':
    deploy()
```

**Database Backup (Idempotent):**
```python
#!/usr/bin/env python3
# scripts/backup.py

"""
Backup PostgreSQL to Cloudflare R2.
Runs daily via cron. Idempotent - safe to run multiple times.
"""

from datetime import datetime
from lib.postgres import pg_dump
from lib.r2 import upload_to_r2

def backup():
    timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    backup_file = f'/tmp/suiftly_backup_{timestamp}.sql.gz'

    # Dump database (compressed)
    pg_dump(
        host='db1.suiftly.io',
        database='suiftly_prod',
        output=backup_file,
        compress=True
    )

    # Upload to R2 (idempotent - same filename overwrites)
    upload_to_r2(
        bucket='suiftly-backups',
        local_file=backup_file,
        remote_key=f'daily/{timestamp}.sql.gz'
    )

    # Keep only last 30 days (cleanup old backups)
    cleanup_old_backups(bucket='suiftly-backups', keep_days=30)

    print(f"✓ Backup completed: {backup_file}")

if __name__ == '__main__':
    backup()
```

**Usage:**
```bash
# Provision new server (disaster recovery)
python scripts/provision-server.py api4.suiftly.io --role=api
python scripts/provision-server.py db2.suiftly.io --role=db

# Deploy application (rolling update)
python scripts/deploy.py

# Backup database
python scripts/backup.py

# Restore from backup
python scripts/restore.py --backup=20250109_120000.sql.gz --target=db1.suiftly.io
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

**Minimal, high-value MCP servers for optimal Claude Code development.**

**Philosophy:** Only install MCPs that add UNIQUE value over built-in tools (Read, Write, Edit, Bash, Glob, Grep).

**Installation:** See [.claude/mcp-setup.md](.claude/mcp-setup.md) for step-by-step setup guide.

**Essential MCPs (Installed):**
1. **context7** - Live documentation for third-party packages (prevents outdated API suggestions for React 19, Vite 7, tRPC v11, Drizzle, @mysten/sui.js)

**Optional MCPs (Add When Needed):**
2. **@modelcontextprotocol/server-postgres** - Database schema inspection (add when database exists)
3. **drizzle-mcp** - Drizzle ORM integration (add after scaffolding drizzle.config.ts)

**Not Installed (Built-in Tools Sufficient):**
- ❌ Filesystem MCP - Use Read, Write, Edit, Bash tools instead
- ❌ Git MCP - Use Bash + git commands instead
- ❌ GitHub MCP - Use Bash + gh CLI instead

**Recommended Workflow:**

Use the `/g` custom command for every feature:
```
/g add tRPC route for fetching usage metrics
```

This automatically:
- ✅ Enables Context7 (live docs)
- ✅ Reads CLAUDE.md and ARCHITECTURE.md
- ✅ Uses TodoWrite for multi-step tasks

See [.claude/commands/g.md](.claude/commands/g.md) for command definition.

---

## Observability

**Logging:**
- Structured JSON logs (pino)
- Request/response logging with trace IDs
- Worker job execution logs

**Metrics (future):**
- API latency, error rates
- Global Manager runs, task success/failure
- Database connection pool stats

**Monitoring (future):**
- Health check endpoints
- Error tracking (Sentry or similar)
- Alert on Global Manager failures

**Internal Error Tracking:**
- `admin_notifications` table stores billing validation failures and system errors
- Call `logInternalError()` from `@suiftly/database/billing` for internal errors requiring admin attention
- Logs to both console and database with severity (error/warning/info), category, and details
- Used by billing engine to report DRAFT validation failures, duplicate charges, etc.

---

## Security

- JWT (15min access, 30d refresh, HttpOnly cookies)
- Wallet signature verification (nonce-based challenge)
- Rate limiting (per-user/IP)
- Zod validation (all inputs)
- Drizzle ORM (parameterized queries)
- Application-level encryption for secrets (see Database Security below)
- Never store private keys
- pg_dump backups daily → R2

---

## Database Security

**For complete database security details including encryption, backup procedures, and disaster recovery, see [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md).**

**Quick Summary:**
- Application-level AES-256-GCM encryption for sensitive fields (API keys, refresh tokens)
- Master key stored in `~/.suiftly.env` (separate from database)
- Database backups contain only ciphertext (safe to store remotely)
- Environment (production vs development) determined by `/etc/walrus/system.conf`
- See [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md) for implementation details and procedures

---

## Testing Strategy

**Test Infrastructure (Vitest + Playwright):**

Fast, low-maintenance testing for rapid bug isolation during Claude Code-assisted development.

**Test Pyramid:**
```
E2E Tests (Playwright)      ← Minimal (critical paths only)
Integration Tests (Vitest)  ← Medium (API + DB)
Unit Tests (Vitest)         ← Maximum (business logic)
```

**Project Structure:**
```
apps/
├─ webapp/
│  └─ tests/
│     ├─ unit/              # Components, utilities
│     └─ e2e/               # Playwright (critical flows)
└─ api/
   └─ tests/
      ├─ unit/              # Services, utilities
      └─ integration/       # tRPC routers + DB queries
packages/
└─ database/
   └─ tests/
      ├─ migrations.test.ts # Migration idempotency
      └─ fixtures/          # Seed data for tests
```

**Test Commands:**
```bash
npm run test              # All tests (CI)
npm run test:unit         # Fast (<5s) - business logic
npm run test:integration  # Medium (10-30s) - API + DB
npm run test:e2e          # Slow (1-2min) - critical flows only
npm run test:watch        # Dev mode (auto-rerun)
```

**Test Database Strategy:**
- Uses `suiftly_test` database (separate from dev)
- Reset between test suites (`TRUNCATE CASCADE`)
- Fixtures in `packages/database/fixtures/` for seed data
- Real PostgreSQL queries (no mocks) for integration tests

**Unit Tests (Vitest):**
```typescript
// packages/shared/tests/validation.test.ts
import { serviceConfigSchema } from '../schemas'

test('validates service config', () => {
  const result = serviceConfigSchema.safeParse({ type: 'seal', region: 'us-east' })
  expect(result.success).toBe(true)
})
```

**Integration Tests (Vitest + Real DB):**
```typescript
// apps/api/tests/integration/services.test.ts
import { appRouter } from '../../src/routes'
import { db } from '@suiftly/database'

beforeEach(async () => {
  await db.execute(sql`TRUNCATE customers, service_configs CASCADE`)
})

test('creates service config', async () => {
  const caller = appRouter.createCaller({ user: { id: 1 } })
  const config = await caller.services.updateConfig({ type: 'seal', region: 'us-east' })
  expect(config.type).toBe('seal')
})
```

**E2E Tests (Playwright - Minimal):**
```typescript
// apps/webapp/tests/e2e/auth.spec.ts
test('wallet connect → authenticate → dashboard', async ({ page }) => {
  await page.goto('/')
  await page.click('[data-testid="connect-wallet"]')
  // ... wallet interaction
  await expect(page).toHaveURL('/dashboard')
})
```

**CI Pipeline (GitHub Actions):**
```yaml
# .github/workflows/ci.yml
jobs:
  test:
    services:
      postgres:
        image: timescale/timescaledb:latest-pg17
        env:
          POSTGRES_DB: suiftly_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
    steps:
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npm run test:e2e  # Only on main branch
```

**Test Utilities:**
```typescript
// packages/database/src/testUtils.ts
export async function resetTestDB() {
  await db.execute(sql`TRUNCATE customers, service_configs, billing_transactions CASCADE`)
}

export async function seedCustomer(override?: Partial<Customer>) {
  return db.insert(customers).values({
    email: 'test@example.com',
    wallet_address: '0x123...',
    ...override
  }).returning()
}
```

**Testing Principles:**
1. Test behavior, not implementation
2. Favor integration tests over mocks (real DB)
3. E2E for critical user flows only
4. Fast feedback (<30s for unit + integration)
5. Idempotent tests (can run in any order)

---

## Next Steps

1. Scaffold monorepo structure (Turborepo + workspaces)
2. Create idempotent deployment scripts (provision-server.py, deploy.py)
3. Setup PostgreSQL + TimescaleDB (via provision script)
4. Create Drizzle schema + migrations + test infrastructure
5. Build API (Fastify + tRPC) with integration tests
6. Build webapp (Vite + React) with unit tests
7. Connect tRPC client → API → DB
8. Add E2E tests for critical flows
9. Test deployment scripts on staging server
10. Production deployment (using deploy.py)
