# IMPLEMENTATION_PLAN.md
AI Agent Task Sequence - Keep Token Count Low

**Important:** Only Phase 0 is a scripted setup. Phases 1+ are development tasks done with AI assistance and committed to the repo.

## Phase 0: Server Environment Setup (One-Time Script)
**Prerequisite:** Repository cloned to local machine
**Goal:** Install ALL system dependencies so developers can work
**Use cases:**
- Setting up a new dev machine (repo already has code)
- Initial server setup for production
- Disaster recovery / rebuilding a server

**File:** scripts/rare/setup-netops-server.py
**Philosophy:** Only installs tools. Does NOT create application code. Idempotent.

**Script structure:**
```python
#!/usr/bin/env python3
"""
Idempotent NetOps server setup.
Installs ALL dependencies needed for development.
Run repeatedly until all checks pass.
"""

def check_ubuntu_version():
    # Must be 22.04 or 24.04
    # Exit if wrong: "Requires Ubuntu 22.04/24.04. Current: {version}"

def install_system_packages():
    # Check each, install if missing:
    # git, curl, build-essential, python3-pip, software-properties-common
    # Exit on apt failure: "Fix: sudo apt update && sudo apt --fix-broken install"

def install_nodejs():
    # Check: node --version (must be v22.x)
    # If missing/wrong: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    # Install npm if missing
    # Exit if old version exists: "Fix: sudo apt purge nodejs npm"

def install_npm_global_packages():
    # Check: pm2 --version
    # Install: npm install -g pm2
    # Verify PM2 startup scripts configured

def install_postgresql():
    # Check: psql --version (must be 17.x)
    # Add PostgreSQL APT repository if needed
    # Install: postgresql-17 postgresql-contrib-17
    # Exit on fail: "Fix: Check PostgreSQL APT repo configuration"

def install_timescaledb():
    # Check: SELECT * FROM pg_available_extensions WHERE name='timescaledb';
    # Add Timescale APT repository if needed
    # Install: timescaledb-2-postgresql-17 (version 2.17+)
    # Run: timescaledb-tune --quiet --yes
    # Restart PostgreSQL

def setup_postgresql_databases():
    # Create databases if not exist: suiftly_dev, suiftly_prod, suiftly_test
    # Enable TimescaleDB extension on each:
    #   CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
    # Create deploy user if not exists with appropriate permissions
    # Exit on permission error: "Fix: Check postgres user sudo access"

def install_python_packages():
    # System-wide or venv: psycopg2-binary, python-dotenv, click
    # For database migration scripts

def install_nginx():
    # Check: nginx -v
    # Install if missing: nginx
    # Do NOT configure yet (Phase 19 handles config)

def install_certbot():
    # Production only (check hostname or env var)
    # Install: certbot python3-certbot-nginx
    # Do NOT run yet (Phase 19 handles SSL setup)

def create_deploy_user():
    # Check: id deploy
    # Create if missing: useradd -m -s /bin/bash deploy
    # Add to appropriate groups

def create_directory_structure():
    # mkdir -p /var/www/{api,webapp,global-manager}
    # mkdir -p /var/log/suiftly
    # chown -R deploy:deploy /var/www
    # chown -R deploy:deploy /var/log/suiftly

def main():
    steps = [
        check_ubuntu_version,
        install_system_packages,
        install_nodejs,
        install_npm_global_packages,
        install_postgresql,
        install_timescaledb,
        setup_postgresql_databases,
        install_python_packages,
        install_nginx,
        install_certbot,
        create_deploy_user,
        create_directory_structure
    ]

    for step in steps:
        try:
            step()
            print(f"✓ {step.__name__}")
        except Exception as e:
            print(f"✗ {step.__name__}: {e}")
            sys.exit(1)

    print("\n✅ Server setup complete!")
    print("Next: Run Phase 1 from project root")
```

**What this installs:**
- **System:** git, curl, build-essential, python3-pip, software-properties-common
- **Node.js:** v22.x LTS from NodeSource repo
- **NPM Global:** PM2 process manager
- **Database:** PostgreSQL 17 + TimescaleDB 2.17+
- **Web Server:** Nginx (unconfigured)
- **SSL:** Certbot (production only, unconfigured)
- **Python:** psycopg2-binary, python-dotenv, click
- **User:** deploy user with home directory
- **Directories:** /var/www/{api,webapp,global-manager}, /var/log/suiftly
- **Databases:** suiftly_dev, suiftly_prod, suiftly_test (with TimescaleDB enabled)

**Test:**
```bash
# First run - installs everything
sudo python3 scripts/rare/setup-netops-server.py

# Second run - all checks pass (idempotent)
sudo python3 scripts/rare/setup-netops-server.py
# Output: ✓ check_ubuntu_version
#         ✓ install_system_packages
#         ✓ install_nodejs
#         ✓ install_npm_global_packages
#         ✓ install_postgresql
#         ✓ install_timescaledb
#         ✓ setup_postgresql_databases
#         ✓ install_python_packages
#         ✓ install_nginx
#         ✓ install_certbot
#         ✓ create_deploy_user
#         ✓ create_directory_structure
#         ✅ Server setup complete!
```

## Phase 1: Project Scaffolding & Monorepo Setup
**Prerequisite:** Phase 0 complete (all dependencies installed)
**Goal:** Initialize project structure, create all package.json files, install all npm packages
**Location:** Run from project root directory
**Note:** This is a development task done with AI assistance and committed to the repo (not a script)

**Tasks:**
1. Create directory structure:
```bash
mkdir -p apps/{webapp,api} packages/{database,shared} services/global-manager
mkdir -p scripts/{rare,dev}
```

2. Create all package.json files with proper dependencies:
   - Root package.json (with workspaces field and Turborepo)
   - packages/database/package.json (drizzle-orm, pg, drizzle-kit)
   - packages/shared/package.json (zod)
   - apps/api/package.json (fastify, @fastify/cookie, @trpc/server, jose)
   - apps/webapp/package.json (react, react-dom, @tanstack/router, @trpc/client, @mysten/dapp-kit, vite)
   - services/global-manager/package.json (pg, @types/node, tsx)

3. Create Turborepo config files:
   - turbo.json (pipeline configuration)
   - Root tsconfig.json (base TypeScript config)
   - Each workspace tsconfig.json (extends root config)

4. Install all dependencies with ONE command:
```bash
# From project root - installs all workspaces at once
npm install
```

**Key Dependencies by Workspace:**

**Root:**
- turbo, typescript, @types/node, tsx, vitest

**packages/database:**
- drizzle-orm, pg (runtime)
- drizzle-kit, @types/pg (dev)

**packages/shared:**
- zod

**apps/api:**
- fastify, @fastify/cookie, @trpc/server, jose (runtime)
- @types/node, tsx (dev)

**apps/webapp:**
- react, react-dom, @tanstack/router, @trpc/client, @mysten/dapp-kit (runtime)
- vite, @vitejs/plugin-react, typescript (dev)

**services/global-manager:**
- pg (runtime)
- @types/node, tsx (dev)

**Test:**
```bash
npm run build  # Turborepo builds all workspaces
npm test       # Runs vitest across workspaces
node --version # Verify v22.x
psql --version # Verify PostgreSQL 17
```

**Files created:**
- package.json (root with workspaces array)
- turbo.json
- tsconfig.json (root)
- apps/webapp/{package.json,tsconfig.json,vite.config.ts}
- apps/api/{package.json,tsconfig.json}
- packages/database/{package.json,tsconfig.json,drizzle.config.ts}
- packages/shared/{package.json,tsconfig.json}
- services/global-manager/{package.json,tsconfig.json}

## Phase 2: Database Schema & ORM Setup
**Prerequisite:** Phase 0 (databases exist) + Phase 1 (packages/database scaffolded)
**Goal:** Define complete database schema with Drizzle ORM, setup migrations, configure TimescaleDB
**Ref:** docs/CUSTOMER_SERVICE_SCHEMA.md#database-schema-summary
**Location:** packages/database/

**Tasks:**
1. Configure Drizzle:
```typescript
// drizzle.config.ts
export default {
  schema: './src/schema/**/*.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL
  }
}
```

2. Define complete schema tables (per CUSTOMER_SERVICE_SCHEMA.md):
```typescript
// src/schema/customers.ts
- customers (customer_id, wallet_address, escrow_contract_id, max_monthly_usd_cents,
  current_balance_usd_cents, current_month_charged_usd_cents, last_month_charged_usd_cents,
  current_month_start, created_at, updated_at)
  + INDEX idx_wallet (wallet_address)
  + CHECK (customer_id > 0)

// src/schema/services.ts
- service_instances (instance_id, customer_id, service_type, tier, is_enabled, config,
  enabled_at, disabled_at)
  + UNIQUE (customer_id, service_type)

// src/schema/api_keys.ts
- api_keys (api_key_id, customer_id, service_type, key_version, seal_network, seal_access,
  seal_source, proc_group, is_active, created_at, revoked_at)
  + INDEX idx_customer_service (customer_id, service_type, is_active)

// src/schema/seal.ts
- seal_keys (seal_key_id, customer_id, public_key, encrypted_private_key,
  purchase_tx_digest, is_active, created_at)
  + INDEX idx_customer (customer_id)

// src/schema/usage.ts
- usage_records (record_id, customer_id, service_type, request_count, bytes_transferred,
  window_start, window_end, charged_amount)
  + INDEX idx_customer_time (customer_id, window_start)
  + INDEX idx_billing (customer_id, service_type, window_start)

// src/schema/logs.ts
- haproxy_logs (id, timestamp, customer_id, service_type, method, status_code, bytes_out)
  ** IMPORTANT: Will be converted to TimescaleDB hypertable in next step **

// src/schema/escrow.ts
- escrow_transactions (tx_id, customer_id, tx_digest, tx_type, amount, asset_type, timestamp)
  + INDEX idx_customer (customer_id)
  + INDEX idx_tx_digest (tx_digest)
  + UNIQUE (tx_digest)
```

3. Configure TimescaleDB hypertable:
```typescript
// src/timescale-setup.ts
import { db } from './db'

export async function setupTimescaleDB() {
  // Convert haproxy_logs to hypertable (run AFTER schema creation)
  await db.execute(sql`
    SELECT create_hypertable('haproxy_logs', 'timestamp',
      chunk_time_interval => INTERVAL '7 days',
      if_not_exists => TRUE
    );
  `)

  // Add retention policy (auto-delete data older than 90 days)
  await db.execute(sql`
    SELECT add_retention_policy('haproxy_logs', INTERVAL '90 days', if_not_exists => TRUE);
  `)

  // Add compression policy (compress chunks older than 7 days)
  await db.execute(sql`
    SELECT add_compression_policy('haproxy_logs', INTERVAL '7 days', if_not_exists => TRUE);
  `)
}
```

4. Setup migration scripts:
```json
// package.json scripts
"db:generate": "drizzle-kit generate",
"db:push": "drizzle-kit push && tsx src/timescale-setup.ts",
"db:studio": "drizzle-kit studio",
"db:migrate": "tsx src/migrate.ts && tsx src/timescale-setup.ts"
```

5. Create connection helper:
```typescript
// src/db.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
export const db = drizzle(pool)
```

**Test:**
```bash
cd packages/database

# Generate migration files
npm run db:generate

# Apply schema to dev database (includes TimescaleDB setup)
DATABASE_URL=postgresql://localhost/suiftly_dev npm run db:push

# Visual confirmation
npm run db:studio  # Opens Drizzle Studio on localhost:4983

# Verify all tables exist
psql suiftly_dev -c "\dt"
# Should show: customers, service_instances, api_keys, seal_keys, usage_records,
#              haproxy_logs, escrow_transactions

# Verify TimescaleDB hypertable
psql suiftly_dev -c "SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'haproxy_logs';"
# Should return 1 row (haproxy_logs is configured as hypertable)
```

## Phase 3: Shared Types & Validation
**Goal:** Zod schemas shared between frontend/backend
**Files:** packages/shared/src/{types,schemas}/*.ts
**Core schemas:**
- AuthSchemas (wallet connect, verify, JWT payload)
- ServiceSchemas (config, tiers)
- CustomerSchemas (profile, usage)
**Test:** Vitest unit tests for schema validation

## Phase 4: Authentication Backend (Mock-First)
**Goal:** JWT auth with mockable wallet verification
**Ref:** docs/AUTHENTICATION_DESIGN.md#implementation-details
**Files:** apps/api/src/routes/auth.ts
**Features:**
- tRPC router with connectWallet, verifySignature endpoints
- Mock mode: `MOCK_AUTH=true` accepts any signature
- Real mode: Ed25519 signature verification
- JWT generation with jose
- httpOnly cookie setting
**Test:** 
```typescript
// apps/api/tests/auth.test.ts
test('mock auth accepts any signature')
test('real auth verifies Ed25519')
test('JWT cookie is httpOnly')
```

## Phase 5: API Server Foundation
**Goal:** Fastify + tRPC setup
**Ref:** docs/ARCHITECTURE.md#backend-api
**Files:** apps/api/src/server.ts
**Setup:**
- Fastify 5 with cookie plugin
- tRPC v11 with SSE (Server-Sent Events) subscriptions
- Zod validation middleware
- Rate limiting
- Health endpoint
**Test:** `curl localhost:3000/health` returns 200

**Note:** tRPC v11 uses SSE for real-time subscriptions, not WebSockets

## Phase 6: Frontend Foundation
**Goal:** Vite + React + TanStack Router
**Ref:** docs/ARCHITECTURE.md#frontend-spa
**Files:** apps/webapp/src/main.tsx
**Setup:**
- Vite 7 + React 19
- TanStack Router with type-safe routes
- Tailwind + shadcn/ui
- tRPC client setup
**Test:** `npm run dev` shows landing page

## Phase 7: Wallet Integration Frontend
**Goal:** @mysten/dapp-kit integration with mock support
**Ref:** docs/AUTHENTICATION_DESIGN.md#frontend-spa-with-react
**Files:** apps/webapp/src/components/wallet/
**Features:**
- WalletProvider setup
- Mock wallet for testing (localStorage)
- Real wallet connection
- Auto-reconnect from localStorage
**Test:** Can connect wallet in mock & real modes

## Phase 8: Authentication Flow Complete
**Goal:** End-to-end auth with session management
**Files:** 
- apps/webapp/src/stores/auth.ts (Zustand)
- apps/webapp/src/lib/trpc.ts (auth headers)
**Features:**
- Challenge-response flow
- JWT storage in httpOnly cookie
- Auto-refresh before expiry
- Protected route guards
**Test:** E2E test login → protected page → logout

## Phase 9: Dashboard Layout
**Goal:** Main dashboard structure
**Ref:** docs/UI_DESIGN.md#dashboard-layout
**Files:** apps/webapp/src/components/layout/
**Components:**
- DashboardLayout
- Header with WalletWidget
- Sidebar navigation
- Content area
**Test:** Visual regression test with Playwright

## Phase 10: Service Configuration UI (Seal Only)
**Goal:** Seal service config form
**Ref:** docs/UI_DESIGN.md#service-configuration-form
**Files:** apps/webapp/src/pages/services/seal/
**Features:**
- React Hook Form + Zod
- Tier selection (Starter/Pro/Enterprise)
- Origin configuration
- Live price calculation
**Test:** Form validation, price updates correctly

## Phase 11: Service Backend CRUD
**Goal:** Service instance management with balance/limit validation
**Ref:** docs/CUSTOMER_SERVICE_SCHEMA.md#balance--spending-limit-validation
**Files:** apps/api/src/routes/services.ts
**Endpoints:**
- services.list
- services.getConfig
- services.updateConfig (with validation)
- services.enable (with validation)
- services.disable

**Critical: Balance/Limit Validation**

Before allowing operations that incur charges, validate:
```typescript
// Before enabling service or upgrading tier
async function validateOperation(customerId: number, estimatedCost: number) {
  const customer = await getCustomer(customerId);

  // Check 1: Sufficient balance
  if (customer.current_balance_usd_cents < estimatedCost * 100) {
    return {
      allowed: false,
      error: "insufficient_balance",
      details: {
        current_balance_usd: customer.current_balance_usd_cents / 100,
        estimated_cost_usd: estimatedCost,
        required_deposit_usd: estimatedCost - (customer.current_balance_usd_cents / 100)
      }
    };
  }

  // Check 2: Within monthly limit
  const projectedMonthly = customer.current_month_charged_usd_cents + (estimatedCost * 100);
  if (projectedMonthly > customer.max_monthly_usd_cents) {
    return {
      allowed: false,
      error: "monthly_limit_exceeded",
      details: {
        max_monthly_usd: customer.max_monthly_usd_cents / 100,
        current_month_charged_usd: customer.current_month_charged_usd_cents / 100,
        estimated_cost_usd: estimatedCost,
        remaining_authorization_usd: (customer.max_monthly_usd_cents - customer.current_month_charged_usd_cents) / 100
      }
    };
  }

  return { allowed: true };
}
```

**Operations requiring validation:**
- Enabling a new service
- Upgrading service tier
- Purchasing additional Seal keys
- Any configuration change that increases costs

**Test:** Integration tests with test database, including validation error cases

## Phase 12: Coming Soon Pages
**Goal:** Placeholder for gRPC/GraphQL
**Ref:** docs/COMING_SOON_PAGE.md
**Files:** apps/webapp/src/pages/services/{grpc,graphql}/
**Test:** Routes render correct content

## Phase 13: Global Manager Core
**Goal:** Daemon process structure
**Ref:** docs/GLOBAL_MANAGER_DESIGN.md
**Files:** services/global-manager/src/index.ts
**Features:**
- setInterval scheduler
- PostgreSQL advisory locks
- Graceful shutdown
- Admin server on :3001
**Test:** Process starts, acquires lock, shuts down cleanly

## Phase 14: Usage Metering
**Goal:** HAProxy log aggregation
**Files:** services/global-manager/src/tasks/aggregate.ts
**Logic:**
- Read haproxy_logs since last_processed
- Group by customer_id, service_type
- Insert usage_records
- Mark logs as processed
**Test:** Mock logs → correct aggregation

## Phase 15: Billing Calculation & Escrow Charging
**Goal:** Usage-based billing with on-chain escrow charging
**Files:** services/global-manager/src/tasks/bill.ts
**Ref:**
- docs/SEAL_SERVICE_CONFIG.md#pricing
- docs/CUSTOMER_SERVICE_SCHEMA.md#billing-flow

**Logic:**
1. Read unbilled usage_records (filter: charged_amount IS NULL)
2. Apply tier pricing (calculate charges per customer/service)
3. Validate against monthly limit and balance (off-chain check)
4. Execute on-chain charge via escrow contract:
   ```typescript
   const txDigest = await chargeEscrowAccount(customer.wallet_address, chargeAmountUSD);
   ```
5. Update database records:
   - Set charged_amount in usage_records
   - Update customers.current_month_charged_usd_cents
   - Insert escrow_transactions record (mirror on-chain event)
6. Handle failures:
   - Insufficient balance → suspend service, notify customer
   - Monthly limit exceeded → suspend service, auto-resume next month

**Critical: Escrow Integration**
- Charges MUST be executed on-chain (not just database records)
- Use idempotent operations (nonce-based to prevent double-charging)
- Store tx_digest for audit trail
- Sync escrow_transactions table with on-chain events

**Test:**
- Unit tests for pricing tiers
- Integration tests with mock escrow contract
- Idempotency tests (same billing cycle runs twice = same result)

## Phase 16: MA_VAULT Generation
**Goal:** API key vault for walrus project
**Ref:** docs/API_KEY_DESIGN.md
**Files:** services/global-manager/src/tasks/vault.ts
**Output format:**
```csv
customer_id,encrypted_key,rate_limit,tier,service_type
12345678,base64data,1000,pro,seal
87654321,base64data,500,starter,seal
```

**Format:** CSV (not JSON)
- Each row represents an active API key
- walrus HAProxy reads this file to authenticate/rate-limit requests
- Regenerated every Global Manager cycle (5 minutes)
- File atomically replaced (write to temp, then rename)

**Test:**
- Generated vault is valid CSV
- Contains all active API keys
- Rate limits match tier configurations
- File is atomically replaced (no partial reads)

## Phase 17: Wallet Widget & Escrow
**Goal:** Balance display & fund management
**Ref:** docs/UI_DESIGN.md#wallet-widget-header-component
**Files:** apps/webapp/src/components/wallet/WalletWidget.tsx
**Features:**
- Collapsible balance display
- Deposit/Withdraw modals
- Escrow panel (optional)
**Test:** Mock escrow contract interactions

## Phase 18: API Key Management UI
**Goal:** View/regenerate API keys
**Files:** apps/webapp/src/pages/api-keys/
**Features:**
- List keys by service
- Show/hide key values
- Regenerate with confirmation
- Copy to clipboard
**Test:** Keys display correctly, regenerate works

## Phase 19: Deployment Scripts
**Goal:** Idempotent Python deployment
**Ref:** docs/ARCHITECTURE.md#deployment-zero-downtime
**Files:** scripts/{provision-server,deploy,backup}.py
**Test:** Scripts are idempotent (run twice = no errors)

## Phase 20: End-to-End Testing
**Goal:** Complete E2E test suite for critical user flows
**Ref:** docs/ARCHITECTURE.md#testing-strategy
**Files:** apps/webapp/tests/e2e/*.spec.ts
**Tool:** Playwright

**Critical flows to test:**
1. **Authentication Flow:**
   - Connect wallet (mock mode)
   - Sign challenge
   - JWT issued and stored
   - Access protected routes
   - Logout

2. **Service Configuration Flow:**
   - Enable Seal service
   - Configure tier (Starter → Pro upgrade)
   - Update configuration
   - Disable service

3. **API Key Management Flow:**
   - Generate new API key
   - Copy to clipboard
   - Regenerate key (with confirmation)
   - Revoke key

4. **Billing & Balance Flow:**
   - View current balance
   - View pending charges
   - View monthly spending
   - Deposit funds (mock escrow)
   - Check balance validation errors

5. **Dashboard Navigation:**
   - Navigate between pages
   - View service status
   - View usage metrics
   - View billing history

**Test setup:**
- Use test database (suiftly_test)
- Mock wallet connections
- Mock escrow contract
- Seed test data before each suite
- Reset database after tests

**Test:** All E2E tests pass, <2 minute total runtime

## Phase 21: Production Readiness
**Goal:** Final checks before launch
**Tasks:**
- Environment variables documented
- Rate limiting configured
- CORS settings for production
- Database indexes optimized
- Health checks on all services
- Monitoring endpoints
**Test:** Full E2E suite passes

## Testing Strategy

Each phase must maintain:
1. **Unit tests:** Logic & utilities (Vitest)
2. **Integration tests:** API endpoints with test DB
3. **E2E tests:** Critical user flows (Playwright)
4. **Type safety:** `tsc --noEmit` passes

Test database reset:
```bash
npm run db:test:reset  # Drop + recreate + migrate
```

## Mock Modes

Enable fast development without external dependencies:
- `MOCK_AUTH=true` - Accept any wallet signature
- `MOCK_ESCROW=true` - Fake escrow contract
- `MOCK_HAPROXY=true` - Generate fake logs
- `MOCK_SUI_RPC=true` - Mock blockchain calls

## Server Setup

**Order of operations:**
```bash
# 1. Clone the repository first
git clone https://github.com/mario4tier/suiftly-co.git
cd suiftly-co

# 2. Run Phase 0 setup script (installs all dependencies)
sudo python3 scripts/rare/setup-netops-server.py

# 3. Verify all dependencies installed (script is idempotent)
sudo python3 scripts/rare/setup-netops-server.py
# Should see all green checkmarks ✓

# 4. Now ready for Phase 1 (npm setup)
```

Use the same script for all 3 servers:
- Dev server 1: Initial development
- Dev server 2: Testing deployments
- Production: Live environment

## Session Handoff

End each session with:
1. Current phase completed
2. Tests passing
3. Next phase number
4. Any blockers noted

Start each session with:
1. Read this file
2. Check current phase
3. Run tests to verify state
4. Continue from next phase