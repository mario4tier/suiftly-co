#!/bin/bash
# Reset test data by truncating tables (no sudo required)
# Safe for automated testing - preserves schema, only clears data
# Can be used by Playwright tests or manual testing

set -e  # Exit on error

# Database connection settings
# Use postgres superuser for test setup (deploy user doesn't have TRUNCATE permission)
DB_NAME="${DB_NAME:-suiftly_dev}"
DB_ADMIN_USER="${DB_ADMIN_USER:-postgres}"

echo "🧹 Resetting test data in $DB_NAME..."
echo ""

# Truncate all tables (preserves schema, clears data)
# Uses sudo -u postgres to avoid password prompt
sudo -u postgres psql -d "$DB_NAME" <<EOF
-- Disable triggers to avoid foreign key issues during truncate
SET session_replication_role = 'replica';

-- Truncate all tables (cascade to handle foreign keys)
TRUNCATE TABLE
  customers,
  api_keys,
  escrow_accounts,
  ledger_entries,
  activity_logs,
  services,
  service_endpoints
CASCADE;

-- Re-enable triggers
SET session_replication_role = 'default';

-- Verify tables are empty
SELECT
  'customers' as table_name, COUNT(*) as rows FROM customers
UNION ALL
SELECT 'api_keys', COUNT(*) FROM api_keys
UNION ALL
SELECT 'escrow_accounts', COUNT(*) FROM escrow_accounts
UNION ALL
SELECT 'ledger_entries', COUNT(*) FROM ledger_entries
UNION ALL
SELECT 'activity_logs', COUNT(*) FROM activity_logs
UNION ALL
SELECT 'services', COUNT(*) FROM services
UNION ALL
SELECT 'service_endpoints', COUNT(*) FROM service_endpoints;
EOF

echo ""
echo "✅ Test data reset complete!"
echo "   All tables truncated, schema preserved"
echo ""
