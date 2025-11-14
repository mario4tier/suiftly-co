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

1. **`~/.suiftly.env`** (Home directory) - **SENSITIVE SECRETS AND CREDENTIALS**
   - Location: `~/.suiftly.env` (NOT in project directory)
   - Contains: `JWT_SECRET`, `DB_APP_FIELDS_ENCRYPTION_KEY`, `COOKIE_SECRET`, `DATABASE_URL` (production)
   - Permissions: `chmod 600 ~/.suiftly.env`
   - **Why `~/.suiftly.env` not `~/.env`?** Avoids conflicts with Python venvs
   - **Production:** Each server has its own `~/.suiftly.env` with unique secrets
   - **Development:** Optional (config.ts provides safe defaults)

2. **Project `.env` files** (In repo directories) - **DEVELOPMENT DEFAULTS ONLY**
   - Examples: `packages/database/.env`, `.env` (root)
   - Contains: `DATABASE_URL` (dev default password), `NODE_ENV=test`
   - **Safe to commit** because they use well-known development defaults
   - **Production:** NEVER use project `.env` files - all config comes from `~/.suiftly.env`
   - **IMPORTANT:** Do NOT put `MOCK_AUTH` in `.env` files (`.env` can be a Python directory)

**First-time setup (Development):**
```bash
# 1. Generate secrets (run 3 times to get 3 different values)
openssl rand -base64 32

# 2. Edit ~/.suiftly.env and replace GENERATE_ME_* placeholders
vim ~/.suiftly.env

# The file contains clear instructions on what to do
# Replace each GENERATE_ME_* line with a generated secret
```

**Development (optional - config has safe defaults):**
```bash
# ~/.suiftly.env (chmod 600)
# Base64-encoded 32-byte secrets with "dev" markers (decode to plaintext)
JWT_SECRET=ZGV2LXNlY3JldC1mb3ItdGVzdGluZy1vbmx5ISEhISE=
DB_APP_FIELDS_ENCRYPTION_KEY=ZGV2LWVuY3J5cHRpb24ta2V5LXRlc3Qtb25seSEhISE=
COOKIE_SECRET=ZGV2LWNvb2tpZS1zZWNyZXQtdGVzdGluZy1vbmx5ISE=
DATABASE_URL=postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev
```

**Production setup:**
```bash
# Generate secure production secrets (base64-encoded random bytes)
cd ~
echo "JWT_SECRET=$(openssl rand -base64 32)" > ~/.suiftly.env
echo "DB_APP_FIELDS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> ~/.suiftly.env
echo "COOKIE_SECRET=$(openssl rand -base64 32)" >> ~/.suiftly.env
echo "DATABASE_URL=postgresql://deploy:PROD_PASSWORD@localhost/suiftly_prod" >> ~/.suiftly.env
chmod 600 ~/.suiftly.env

# IMPORTANT: Back up these secrets to a password manager!
cat ~/.suiftly.env  # Copy to 1Password/Bitwarden
```

**Note about `MOCK_AUTH`:**
- **NEVER** put `MOCK_AUTH` in `.env` files (`.env` can be a Python directory on some systems)
- `MOCK_AUTH` defaults to `true` in development/test based on `NODE_ENV` (see [config.ts](apps/api/src/lib/config.ts))
- Production systems automatically get `MOCK_AUTH=false` based on `NODE_ENV=production`

**How it works:**
- [apps/api/src/lib/config.ts](apps/api/src/lib/config.ts) loads `~/.suiftly.env` at startup
- Validates secrets (production must NOT use dev defaults)
- Project `.env` files loaded by package-specific tools (Drizzle, test runners)
- See [docs/APP_SECURITY_DESIGN.md](docs/APP_SECURITY_DESIGN.md) for complete details

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
- Test data reset - Use `curl -X POST http://localhost:3000/test/data/truncate-all` (no sudo)

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

### Starting Servers
```bash
./scripts/dev/start-dev.sh
```

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