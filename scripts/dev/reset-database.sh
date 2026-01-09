#!/bin/bash
# Reset development database from scratch
# WARNING: This destroys all data in suiftly_dev database!
# SAFETY: Only runs on development environments

set -e  # Exit on error

# ============================================================================
# REQUIRE SUDO
# ============================================================================

if [ "$EUID" -ne 0 ]; then
  echo "❌ ERROR: This script must be run with sudo"
  echo "   Usage: sudo ./scripts/dev/reset-database.sh"
  exit 1
fi

# ============================================================================
# PRODUCTION SAFEGUARDS
# ============================================================================

# 1. Check for system.conf production flag
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_CONF="$SCRIPT_DIR/../../system.conf"

if [ -f "$SYSTEM_CONF" ]; then
  # Source the config file
  source "$SYSTEM_CONF"

  # Check if ENVIRONMENT is set to production
  if [ "${ENVIRONMENT:-}" = "production" ]; then
    echo "❌ ERROR: Production environment detected in system.conf"
    echo "   This script is ONLY for development databases."
    echo "   ENVIRONMENT=$ENVIRONMENT"
    exit 1
  fi
fi

# 2. Block common production database names
DB_NAME="${DB_NAME:-suiftly_dev}"
BLOCKED_NAMES=("suiftly_prod" "suiftly_production" "production" "prod" "main")
for blocked in "${BLOCKED_NAMES[@]}"; do
  if [ "$DB_NAME" = "$blocked" ]; then
    echo "❌ ERROR: Database name '$DB_NAME' appears to be a production database"
    echo "   This script is ONLY for development databases."
    echo "   Blocked names: ${BLOCKED_NAMES[*]}"
    exit 1
  fi
done

# 3. Require explicit confirmation for non-default database names
if [ "$DB_NAME" != "suiftly_dev" ]; then
  echo "⚠️  WARNING: Non-standard database name detected: $DB_NAME"
  echo "   Expected: suiftly_dev"
  echo ""
  echo "   Type the database name exactly to confirm: "
  read -r confirmation
  if [ "$confirmation" != "$DB_NAME" ]; then
    echo "❌ Database name mismatch. Aborting for safety."
    exit 1
  fi
fi

# 4. Block non-localhost hosts (production databases are not on localhost)
DB_HOST="${DB_HOST:-localhost}"
if [ "$DB_HOST" != "localhost" ] && [ "$DB_HOST" != "127.0.0.1" ]; then
  echo "❌ ERROR: Remote database host detected: $DB_HOST"
  echo "   This script is ONLY for local development databases."
  echo "   Production databases should never be reset from dev scripts."
  exit 1
fi

# ============================================================================
# POSTGRESQL AUTHENTICATION CHECK
# ============================================================================

# Check if pg_hba.conf has trust authentication for localhost
# This is required for migrations to run without password prompts
PG_HBA="/etc/postgresql/17/main/pg_hba.conf"

if [ -f "$PG_HBA" ]; then
  # Check if trust rules exist for localhost postgres/deploy users
  if ! sudo grep -q "127.0.0.1/32.*trust" "$PG_HBA" 2>/dev/null; then
    echo "⚠️  PostgreSQL authentication needs configuration for local development"
    echo ""
    echo "📋 Required: Trust authentication for localhost connections"
    echo "   This allows migrations to run without password prompts."
    echo ""
    echo "   Why this is safe:"
    echo "   • Only localhost (127.0.0.1) can connect without password"
    echo "   • Remote hosts still require authentication"
    echo "   • Standard practice for local development"
    echo ""
    echo "🔧 Automatically fix pg_hba.conf? (recommended)"
    echo "   Press Enter to auto-fix, or Ctrl+C to cancel and fix manually..."
    read -r

    # Backup current config
    echo "📋 Creating backup..."
    sudo cp "$PG_HBA" "$PG_HBA.backup.$(date +%Y%m%d_%H%M%S)"
    echo "   ✅ Backup created"

    # Add trust rules for localhost at the beginning (before other rules)
    echo "📝 Adding trust rules for localhost..."
    sudo sed -i '0,/^# TYPE/s/^# TYPE/# Local development: Trust localhost connections\nhost    all             postgres        127.0.0.1\/32            trust\nhost    all             deploy          127.0.0.1\/32            trust\n\n# TYPE/' "$PG_HBA"
    echo "   ✅ Rules added"

    # Reload PostgreSQL to apply changes
    echo "🔄 Reloading PostgreSQL..."
    sudo systemctl reload postgresql
    echo "   ✅ PostgreSQL reloaded"
    echo ""
  fi
fi

# ============================================================================
# DEVELOPMENT RESET
# ============================================================================

echo "🗑️  Resetting DEVELOPMENT database..."
echo ""
echo "⚠️  WARNING: This will destroy all data in $DB_NAME!"
echo "Press Ctrl+C to cancel, or Enter to continue..."
read -r

# Database connection settings (after safety checks)
# Use postgres superuser for setup/migrations

# Step 1: Stop GM and clean vault directories
echo "1️⃣  Stopping Global Manager and cleaning vault directories..."

# SAFETY: Check Walrus deployment type from /etc/walrus/system.conf
# Vault cleanup ONLY safe for test deployments (DEPLOYMENT_TYPE=test)
# NEVER run in production (DEPLOYMENT_TYPE=production)
WALRUS_CONF="/etc/walrus/system.conf"
if [ -f "$WALRUS_CONF" ]; then
  # Source walrus system config to get DEPLOYMENT_TYPE
  source "$WALRUS_CONF"

  # Block vault cleanup if production deployment
  if [ "${DEPLOYMENT_TYPE:-}" = "production" ]; then
    echo "❌ ERROR: Production walrus deployment detected"
    echo "   DEPLOYMENT_TYPE=$DEPLOYMENT_TYPE (from $WALRUS_CONF)"
    echo "   Vault cleanup is ONLY for test deployments."
    echo "   Production vaults contain live customer data and must NEVER be deleted."
    exit 1
  fi

  echo "   ✅ Walrus DEPLOYMENT_TYPE=${DEPLOYMENT_TYPE:-not set} (safe to clean vaults)"
else
  echo "   ℹ️  No walrus system.conf found (OK for development)"
fi

# Stop GM if running (so vault files aren't being written during cleanup)
if systemctl is-active --quiet suiftly-gm; then
  echo "   🛑 Stopping Global Manager..."
  systemctl stop suiftly-gm
  echo "   ✅ Global Manager stopped"
else
  echo "   ℹ️  Global Manager not running (OK)"
fi

# Clean vault directories (GM first, then LM)
# Prevents stale vault files from causing seq mismatches after DB reset
GM_VAULT_DIRS=("/opt/syncf/data_tx" "/opt/syncf/data_rx" "/opt/syncf/data")
LM_VAULT_DIRS=("/opt/syncf/data_tx" "/opt/syncf/data_rx" "/opt/syncf/data")

echo "   🗑️  Cleaning GM vault directories..."
for dir in "${GM_VAULT_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    # Delete vault files (.enc and .rsa) recursively
    # Preserves directory structure - only deletes files
    find "$dir" -type f -name "sma-*.enc" -delete 2>/dev/null || true
    find "$dir" -type f -name "sta-*.enc" -delete 2>/dev/null || true
    find "$dir" -type f -name "*.rsa" -delete 2>/dev/null || true
    echo "      ✅ Cleaned $dir"
  fi
done

echo "   🗑️  Cleaning LM vault directories..."
for dir in "${LM_VAULT_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    # Delete vault files (.enc and .rsa) recursively
    # Preserves directory structure - only deletes files
    find "$dir" -type f -name "sma-*.enc" -delete 2>/dev/null || true
    find "$dir" -type f -name "sta-*.enc" -delete 2>/dev/null || true
    find "$dir" -type f -name "*.rsa" -delete 2>/dev/null || true
    echo "      ✅ Cleaned $dir"
  fi
done

echo "   ✅ Vault directories cleaned"

# Step 2: Drop database (terminate existing connections first)
echo "2️⃣  Dropping database $DB_NAME..."
# Terminate all connections to the database (required for DROP)
sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" > /dev/null 2>&1 || true
sudo -u postgres psql -c "DROP DATABASE IF EXISTS $DB_NAME;"
echo "   ✅ Database dropped"

# Step 3: Create database
echo "3️⃣  Creating fresh database $DB_NAME..."
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME;"
echo "   ✅ Database created"

# Step 4: Install TimescaleDB extension
echo "4️⃣  Installing TimescaleDB extension..."
sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
echo "   ✅ TimescaleDB extension installed"

# Step 5: Apply migrations
echo "5️⃣  Applying migrations..."
# Run as current user, but connect to database as postgres user
# Use localhost TCP connection (pg_hba.conf should have 'trust' for local postgres user)
# This avoids needing the postgres Unix user to access home directories
cd "$SCRIPT_DIR/../../packages/database"
DATABASE_URL="postgresql://postgres@localhost:5432/$DB_NAME" node --import tsx src/migrate.ts
echo "   ✅ Migrations applied"

# Step 6: Setup TimescaleDB hypertables
echo "6️⃣  Setting up TimescaleDB hypertables..."
DATABASE_URL="postgresql://postgres@localhost:5432/$DB_NAME" node --import tsx src/timescale-setup.ts
echo "   ✅ TimescaleDB configured"

# Step 7: Grant permissions to deploy user (DML + TRUNCATE for test resets)
echo "7️⃣  Granting permissions to deploy user..."
sudo -u postgres psql -d "$DB_NAME" <<EOF
-- Grant CONNECT privilege
GRANT CONNECT ON DATABASE $DB_NAME TO deploy;

-- Grant USAGE on schema
GRANT USAGE ON SCHEMA public TO deploy;

-- Grant DML operations on all tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO deploy;

-- Grant TRUNCATE for test data resets (dev only, production uses different setup)
GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO deploy;

-- Grant USAGE on all sequences (for auto-increment IDs)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO deploy;

-- Grant default privileges for future tables/sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO deploy;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO deploy;

-- Verify permissions
SELECT grantee, privilege_type, table_name
FROM information_schema.table_privileges
WHERE grantee = 'deploy'
ORDER BY table_name, privilege_type;
EOF
echo "   ✅ Permissions granted to deploy user (DML + TRUNCATE)"

# Step 8: Initialize system_control singleton row
echo "8️⃣  Initializing system_control..."
sudo -u postgres psql -d "$DB_NAME" <<EOF
-- Insert singleton row for system_control (vault seq tracking, etc.)
INSERT INTO system_control (id, updated_at) VALUES (1, NOW())
ON CONFLICT (id) DO NOTHING;
EOF
echo "   ✅ System control initialized"

# Step 9: Setup fluentd user for HAProxy log ingestion
echo "9️⃣  Setting up fluentd database user..."

# Check if fluentd user exists (avoid unnecessary SQL)
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='fluentd'" | grep -q 1; then
  echo "   ℹ️  fluentd user already exists"
else
  sudo -u postgres psql -c "CREATE USER fluentd WITH PASSWORD 'fluentd_dev_password';"
  echo "   ✅ Created fluentd user (password: fluentd_dev_password)"
fi

# Grants must run every time since database was just recreated
sudo -u postgres psql -d "$DB_NAME" <<EOF
GRANT CONNECT ON DATABASE $DB_NAME TO fluentd;
GRANT USAGE ON SCHEMA public TO fluentd;
-- Request logs table (aggregated HAProxy request logs)
GRANT INSERT ON haproxy_raw_logs TO fluentd;
GRANT SELECT ON haproxy_raw_logs TO fluentd;
-- System logs table (HAProxy ALERT, WARNING, etc.)
GRANT INSERT ON haproxy_system_logs TO fluentd;
GRANT SELECT ON haproxy_system_logs TO fluentd;
EOF
echo "   ✅ fluentd permissions granted"

echo ""
echo "🎉 Database reset complete!"
echo ""
echo "⚠️  IMPORTANT: Click 'Disconnect' in the wallet widget, then log in again."
echo ""
echo "📊 To view database:"
echo "   cd packages/database"
echo "   npm run db:studio"
