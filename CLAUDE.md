# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

**suiftly-co** - Customer-facing platform for Suiftly services (Sui blockchain infrastructure).

Repository: https://github.com/mario4tier/suiftly-co

## What This Project Does

Self-service dashboard where customers configure and manage Suiftly infrastructure services:
- Web dashboard (SPA) for service configuration
- Wallet-based authentication (sign-in with Sui)
- Usage-based billing with Web3 wallet integration
- API backend with tRPC (type-safe)

Infrastructure (HAProxy, Seal servers) lives in separate **walrus** project.

## Architecture

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for complete details.**

**System diagram:** [docs/Suiftly - Seal Ops.png](docs/Suiftly - Seal Ops.png) shows the complete infrastructure (this repo builds the red NetOps components: SPA, API servers, PostgreSQL, Global Manager).

Key points:
- **Monorepo:** Turborepo + npm workspaces
- **Stack:** TypeScript everywhere (Vite + React, Fastify, PostgreSQL)
- **Auth:** Wallet signature verification (no passwords)
- **Self-hosted:** No cloud dependencies

## Current Status

Initial setup phase - no code scaffolded yet.

## Development Guidelines

- Follow architecture decisions in docs/ARCHITECTURE.md
- Keep it simple (rapid development principle)
- TypeScript strict mode
- Update this file only when adding commands or major patterns

## Configuration Management

**Two types of configuration files:**

1. **`~/.suiftly.env`** (Home directory) - **SENSITIVE SECRETS**
   - Contains: `JWT_SECRET`, `DB_APP_FIELDS_ENCRYPTION_KEY`, `COOKIE_SECRET`, `X_API_KEY_SECRET`, `DATABASE_URL`, `SEAL_MASTER_SEED_*`
   - Permissions: `chmod 600 ~/.suiftly.env`
   - **Development:** Optional (config.ts provides safe defaults)
   - **Production:** Required with unique secrets per server

2. **Project `.env` files** (In repo directories) - **DEVELOPMENT DEFAULTS ONLY**
   - Examples: `packages/database/.env`
   - **Safe to commit** (well-known dev defaults)
   - **IMPORTANT:** Do NOT put `MOCK_AUTH` in `.env` files

**See [docs/APP_SECURITY_DESIGN.md](docs/APP_SECURITY_DESIGN.md) for:**
- Complete secret reference and generation commands
- Production setup instructions
- Shared secrets (X_API_KEY_SECRET, SEAL_MASTER_SEED_*)
- Disaster recovery procedures

## Environment Detection

**IMPORTANT: Never use NODE_ENV for environment detection in runtime code.** Use `system.conf` and `@walrus/system-config` instead.

See [~/walrus/CLAUDE.md](~/walrus/CLAUDE.md) "Environment Detection (system.conf)" section for full documentation.

Quick reference:
```typescript
import { isDevelopment, isProduction, isTestFeaturesEnabled } from '@walrus/system-config';

// Enable test features only in non-production
if (isTestFeaturesEnabled()) {
  // Register test endpoints, debug routes, etc.
}
```

The `system.conf` file in `~/walrus/` or `~/suiftly-co/` determines the environment. Copy from `system.conf.example` and set `ENVIRONMENT=development` (dev) or `ENVIRONMENT=production` (prod).

## Database Management

### Quick Reset (Destroys all data)
```bash
./scripts/dev/reset-database.sh
```

### Migration Squash (Early development only)
Consolidate migrations into single initial schema:
```bash
./scripts/dev/squash-migrations.sh
git add packages/database/migrations/
git commit -m "chore: squash migrations to single initial schema"
```

**When to squash:**
- During early development (what you're doing now)
- Before major milestones
- Last time before production launch

**Never squash after production launch!**

See [docs/MIGRATION_SQUASH_GUIDE.md](docs/MIGRATION_SQUASH_GUIDE.md) for detailed guide.

### Production Safety 🛡️

All destructive dev scripts include **four layers of protection**:

1. **system.conf check** - Blocks if `ENVIRONMENT=production`
2. **Database name blocking** - Rejects production DB names
3. **Non-standard name confirmation** - Requires manual typing of DB name
4. **Remote host blocking** - Only allows localhost

**Test safeguards:**
```bash
./scripts/test-safety.sh  # Verify all protections work
```

**Setup production:**
```bash
cp system.conf.example system.conf
sed -i 's/ENVIRONMENT=development/ENVIRONMENT=production/' system.conf
```

See [docs/PRODUCTION_SAFETY.md](docs/PRODUCTION_SAFETY.md) for complete details.

### Database Permissions (Two-User Model)

**We test production permissions in development** to catch issues early.

**Two users:**
1. **`postgres` (superuser)** - Database setup, migrations, test data reset
2. **`deploy` (minimal runtime)** - API operations only (SELECT, INSERT, UPDATE, DELETE)

**Why:**
- `deploy` user has NO DDL permissions (no CREATE/ALTER/DROP tables)
- Permission issues caught in dev, not production
- Migrations run as `postgres`, API runs as `deploy`

**Scripts use appropriate user automatically:**
- `./scripts/dev/reset-database.sh` - Uses `postgres`, grants permissions to `deploy`
- API runtime (apps/api) - Uses `deploy` from DATABASE_URL in .env
- Test data reset - Use `curl -X POST http://localhost:22700/test/data/truncate-all` (no sudo)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#development) PostgreSQL Setup section for complete details.

## CRITICAL: Route Security 🔒

**All routes require authentication by default** (fail-secure design).

- Global auth guard in `apps/webapp/src/routes/__root.tsx`
- Only routes in `PUBLIC_ROUTES` allowlist are accessible without auth
- Currently public: `/` (redirects based on auth), `/login`
- **DO NOT add routes to PUBLIC_ROUTES without security review**

When adding new routes:
- Protected routes (default): Just create the route file - automatically protected
- Public routes (rare): Add to `PUBLIC_ROUTES` in `__root.tsx` + document why

See [docs/ROUTE_SECURITY.md](docs/ROUTE_SECURITY.md) for complete details.

## Development Server Management

**ALWAYS use the provided scripts to start/stop servers** - they are more robust than manual commands.

**CRITICAL: ALWAYS use these scripts for GM and LM!**
- GM (Global Manager) and LM (Local Manager) run as systemd services
- The scripts use sudob to manage them properly
- **NEVER** try to start/stop GM or LM manually with `systemctl`, `pkill`, or direct node commands
- **NEVER** try to restart services by killing processes directly

**Sudob Service:**
- Sudob runs as a privileged systemd service (port 22800)
- **You cannot start sudob yourself** - ask the user to start it if needed
- Sudob is required for start-dev.sh and stop-dev.sh to work properly

### Starting Servers
```bash
./scripts/dev/start-dev.sh
```

**What it starts:**
- GM (suiftly-gm) - via systemd/sudob on port 22600
- LM (suiftly-lm) - via systemd/sudob on port 22610
- Admin webapp on port 22601
- API server on port 22700
- Webapp on port 22710

**Port Reference:** See `~/walrus/PORT_MAP.md` for the single source of truth on all port allocations.

**Benefits:**
- Aggressive cleanup of stale processes (multiple passes)
- Port verification before starting
- Health checks for API readiness
- PID tracking for clean shutdown
- Logging to `/tmp/suiftly-api.log` and `/tmp/suiftly-webapp.log`
- Sets correct environment (MOCK_AUTH=true, DATABASE_URL, etc.)

### Stopping Servers
```bash
./scripts/dev/stop-dev.sh
```

**What it does:**
- Kills by saved PIDs first (cleanest)
- Fallback: kills by process name
- Fallback: kills by port
- Removes PID files

### Quick Restart
```bash
./scripts/dev/stop-dev.sh && ./scripts/dev/start-dev.sh
```

**When NOT to use these scripts:**
- Running E2E tests (Playwright manages its own servers)
- Using `npm run dev` for Turborepo hot-reload during development

**Logs location:**
- API: `/tmp/suiftly-api.log`
- Webapp: `/tmp/suiftly-webapp.log`

## CRITICAL: Process Management

**NEVER use `killall -9 node` or similar commands!** This kills the AI agent process itself.

When you need to stop development servers:
- Use `lsof -ti:PORT | xargs kill` to kill specific port processes
- Use project scripts in `scripts/dev/` if available
- Use `pkill -f "specific-server-name"` to target specific processes
- In Playwright tests, set `reuseExistingServer: false` to force fresh server starts