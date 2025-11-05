#!/bin/bash
# Test production safety mechanisms
# This script verifies that safeguards are working correctly

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESET_SCRIPT="$SCRIPT_DIR/dev/reset-database.sh"

echo "🧪 Testing Production Safety Mechanisms"
echo "========================================"
echo ""

# Test 1: Production environment block
echo "Test 1: Production Environment Detection"
echo "----------------------------------------"
echo "ENVIRONMENT=production" > "$SCRIPT_DIR/../system.conf"
if "$RESET_SCRIPT" 2>&1 | grep -q "Production environment detected"; then
  echo "✅ PASS: Production environment blocked"
else
  echo "❌ FAIL: Production environment NOT blocked"
  rm "$SCRIPT_DIR/../system.conf"
  exit 1
fi
rm "$SCRIPT_DIR/../system.conf"
echo ""

# Test 2: Production database name block
echo "Test 2: Production Database Name Blocking"
echo "------------------------------------------"
if DB_NAME=suiftly_prod "$RESET_SCRIPT" 2>&1 | grep -q "appears to be a production database"; then
  echo "✅ PASS: Production database name blocked"
else
  echo "❌ FAIL: Production database name NOT blocked"
  exit 1
fi
echo ""

# Test 3: Remote host block
echo "Test 3: Remote Database Host Blocking"
echo "--------------------------------------"
if DB_HOST=192.168.1.100 "$RESET_SCRIPT" 2>&1 | grep -q "Remote database host detected"; then
  echo "✅ PASS: Remote host blocked"
else
  echo "❌ FAIL: Remote host NOT blocked"
  exit 1
fi
echo ""

# Test 4: Non-standard database name warning
echo "Test 4: Non-Standard Database Name Confirmation"
echo "------------------------------------------------"
if echo "wrong_name" | DB_NAME=my_test_db "$RESET_SCRIPT" 2>&1 | grep -q "Database name mismatch"; then
  echo "✅ PASS: Non-standard database name requires confirmation"
else
  echo "❌ FAIL: Non-standard database name check failed"
  exit 1
fi
echo ""

echo "🎉 All safety tests passed!"
echo ""
echo "Production safeguards are working correctly:"
echo "✅ system.conf production environment detection"
echo "✅ Production database name blocking"
echo "✅ Remote host blocking"
echo "✅ Non-standard database name confirmation"
