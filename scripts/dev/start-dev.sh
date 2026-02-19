#!/bin/bash
# Clean dev server startup script
# Uses sudob for systemd services (GM, LM), direct npm for others

set -e

SUDOB_URL="http://localhost:22800"
SYSTEM_CONF="/etc/mhaxbe/system.conf"

# ============================================================================
# PREVENT RUNNING AS ROOT
# ============================================================================

if [ "$EUID" -eq 0 ]; then
  echo "ERROR: Do not run this script with sudo"
  echo "   Dev servers should run as your regular user, not root."
  echo "   Usage: ./scripts/dev/start-dev.sh"
  exit 1
fi

# ============================================================================
# Check system.conf exists (required for proper dev setup)
# ============================================================================
if [ ! -f "$SYSTEM_CONF" ]; then
  echo ""
  echo "ERROR: $SYSTEM_CONF not found!"
  echo ""
  echo "  This file is required to identify the deployment type."
  echo "  Create it with:"
  echo ""
  echo "    sudo ~/mhaxbe/scripts/configure-deployment.py"
  echo ""
  exit 1
fi

# ============================================================================
# Check workspace packages are built (required by sudob, GM, LM)
# ============================================================================
MHAXBE_DIR="$HOME/mhaxbe"
MISSING_BUILDS=""

# Check mhaxbe packages that export from dist/
if [ -d "$MHAXBE_DIR/packages" ]; then
  for pkg_dir in "$MHAXBE_DIR"/packages/*/; do
    [ -d "$pkg_dir" ] || continue
    if grep -q '"./dist/' "$pkg_dir/package.json" 2>/dev/null && [ ! -d "$pkg_dir/dist" ]; then
      MISSING_BUILDS="$MISSING_BUILDS $(basename "$pkg_dir")"
    fi
  done
fi

# Check suiftly-co services that export from dist/
for svc_dir in "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"/services/*/; do
  [ -d "$svc_dir" ] || continue
  if grep -q '"./dist/' "$svc_dir/package.json" 2>/dev/null && [ ! -d "$svc_dir/dist" ]; then
    MISSING_BUILDS="$MISSING_BUILDS $(basename "$svc_dir")"
  fi
done

if [ -n "$MISSING_BUILDS" ]; then
  echo ""
  echo "ERROR: Workspace packages/services not built (missing dist/:$MISSING_BUILDS)"
  echo ""
  echo "  Run the following to build everything:"
  echo "    sudo ~/mhaxbe/scripts/setup-user.py mwalrus"
  echo "    ~/suiftly-co/scripts/update-all.sh"
  echo ""
  exit 1
fi

# ============================================================================
# Ensure Playwright browsers are installed (required for E2E tests)
# Idempotent: fast no-op when browsers are already at the correct version
# ============================================================================
SUIFTLY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -d "$SUIFTLY_DIR/node_modules/@playwright" ]; then
  PW_OUTPUT=$(cd "$SUIFTLY_DIR" && npx playwright install 2>&1)
  PW_EXIT=$?
  if [ $PW_EXIT -ne 0 ]; then
    echo ""
    echo "WARNING: Failed to install Playwright browsers"
    echo "  E2E tests will not work. Install manually:"
    echo "    cd $SUIFTLY_DIR && npx playwright install"
    echo ""
  elif echo "$PW_OUTPUT" | grep -q "Downloading"; then
    echo "Playwright browsers installed"
  fi
fi

# ============================================================================
# Check Stripe CLI is installed (required for webhook forwarding in dev)
# ============================================================================
if ! command -v stripe &>/dev/null; then
  echo ""
  echo "ERROR: Stripe CLI is not installed!"
  echo ""
  echo "  Install it with:"
  echo ""
  echo "    curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor | sudo tee /usr/share/keyrings/stripe.gpg >/dev/null"
  echo "    echo 'deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main' | sudo tee /etc/apt/sources.list.d/stripe.list"
  echo "    sudo apt update && sudo apt install -y stripe"
  echo ""
  echo "  Then authenticate: stripe login"
  echo ""
  exit 1
fi

# ============================================================================
# Check sudob is running (required for managing systemd services)
# ============================================================================
if ! curl -sf "$SUDOB_URL/api/health" >/dev/null 2>&1; then
  echo ""
  echo "ERROR: sudob service is NOT running!"
  echo "  sudob is required to manage GM/LM systemd services."
  echo ""
  echo "  To start sudob:"
  echo "    sudo systemctl start sudob"
  echo ""
  exit 1
fi

# ============================================================================
# Check sync-files service (required for vault sync between GM and LM)
# ============================================================================
SYNC_TIMER_ACTIVE=$(systemctl is-active sync-files.timer 2>/dev/null || echo "inactive")
SYNC_SERVICE_ACTIVE=$(systemctl is-active sync-files.service 2>/dev/null || echo "inactive")

if [ "$SYNC_TIMER_ACTIVE" != "active" ] && [ "$SYNC_SERVICE_ACTIVE" != "active" ]; then
  echo ""
  echo "WARNING: sync-files service is NOT running!"
  echo "  Vault sync (GM -> LM) will not work without this service."
  echo ""
  echo "  To start (timer mode - recommended for dev):"
  echo "    sudo systemctl start sync-files.timer"
  echo ""
fi

# ============================================================================
# Check optional services (warnings only - not required for basic dev)
# ============================================================================

# Track warnings to display summary at the end
WARNINGS=""

# Check HAProxy (required for Seal service E2E tests)
HAPROXY_ACTIVE=$(systemctl is-active haproxy 2>/dev/null || echo "inactive")
if [ "$HAPROXY_ACTIVE" != "active" ]; then
  WARNINGS="${WARNINGS}  - haproxy: sudo systemctl start haproxy\n"
fi

# Check mseal1 backend (required for Seal service E2E tests)
MSEAL_ACTIVE=$(systemctl is-active mseal1-node 2>/dev/null || echo "inactive")
if [ "$MSEAL_ACTIVE" != "active" ]; then
  WARNINGS="${WARNINGS}  - mseal1-node: sudo systemctl start mseal1-node\n"
fi

if [ -n "$WARNINGS" ]; then
  echo ""
  echo "WARNING: Some optional services are not running."
  echo "  These are needed for E2E tests but not for basic development."
  echo ""
  echo "  To start missing services:"
  echo -e "$WARNINGS"
fi

# ============================================================================
# Helper functions
# ============================================================================

# Call sudob to manage a service
sudob_service() {
  local action=$1
  local service=$2
  local result
  result=$(curl -sf -X POST "$SUDOB_URL/api/service/$action" \
    -H 'Content-Type: application/json' \
    -d "{\"service\":\"$service\"}" 2>&1)
  echo "$result"
}

# Check if service is running via sudob
is_service_running() {
  local service=$1
  local result
  result=$(curl -sf "$SUDOB_URL/api/service/status?service=$service" 2>&1)
  # sudob returns "active":true for running services
  echo "$result" | grep -q '"active":true'
}

# ============================================================================
# Cleanup non-systemd processes (API, Webapp)
# ============================================================================

# Kill by process name (only non-systemd services)
pkill -9 -f "tsx.*apps/api" 2>/dev/null || true
pkill -9 -f "vite" 2>/dev/null || true
pkill -9 -f "node.*vite" 2>/dev/null || true
sleep 1

# Kill by port (API and Webapp ports only - not GM/LM which are systemd)
# IMPORTANT: Must use -sTCP:LISTEN to only kill servers, not client connections
lsof -ti:22700 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:22710 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:3000 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:5173 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:5174 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:5175 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ============================================================================
# Start Global Manager (systemd via sudob)
# ============================================================================
echo "Starting Global Manager (suiftly-gm)..."

if is_service_running "suiftly-gm"; then
  echo "  GM already running, restarting..."
  sudob_service restart suiftly-gm >/dev/null
else
  sudob_service start suiftly-gm >/dev/null
fi

# Wait for GM to be ready
for i in {1..10}; do
  sleep 1
  if curl -sf http://localhost:22600/health >/dev/null 2>&1; then
    break
  fi
  echo "  Waiting for GM... ($i/10)"
done

if ! curl -sf http://localhost:22600/health >/dev/null 2>&1; then
  echo "ERROR: Global Manager not responding on port 22600"
  echo "Check logs: sudo journalctl -u suiftly-gm -n 50"
  exit 1
fi
echo "  Global Manager started"

# ============================================================================
# Start Admin Webapp (direct npm - not systemd)
# ============================================================================
echo "Starting Admin Webapp..."
cd /home/olet/suiftly-co/services/global-manager/webapp
npm run dev > /tmp/suiftly-admin.log 2>&1 &
ADMIN_PID=$!
echo "$ADMIN_PID" > /tmp/suiftly-admin.pid
sleep 3

if ! kill -0 $ADMIN_PID 2>/dev/null; then
  echo "ERROR: Admin webapp failed to start"
  cat /tmp/suiftly-admin.log
  exit 1
fi
echo "  Admin Webapp started (PID: $ADMIN_PID)"

# ============================================================================
# Start Local Manager (systemd via sudob)
# ============================================================================
echo "Starting Local Manager (suiftly-lm)..."

if is_service_running "suiftly-lm"; then
  echo "  LM already running, restarting..."
  sudob_service restart suiftly-lm >/dev/null
else
  sudob_service start suiftly-lm >/dev/null
fi

# Wait for LM to be ready
for i in {1..10}; do
  sleep 1
  if curl -sf http://localhost:22610/health >/dev/null 2>&1; then
    break
  fi
  echo "  Waiting for LM... ($i/10)"
done

if ! curl -sf http://localhost:22610/health >/dev/null 2>&1; then
  echo "WARNING: Local Manager not responding on port 22610"
  echo "  (LM may not be fully implemented yet)"
  echo "  Check logs: sudo journalctl -u suiftly-lm -n 50"
fi
echo "  Local Manager started"

# ============================================================================
# Start Fluentd services (systemd via sudob) - for HAProxy log ingestion
# ============================================================================
echo "Starting Fluentd services..."

# Start fluentd-gm (aggregates logs from LM and writes to DB)
if is_service_running "fluentd-gm"; then
  echo "  fluentd-gm already running"
else
  sudob_service start fluentd-gm >/dev/null 2>&1 || true
  sleep 1
  if is_service_running "fluentd-gm"; then
    echo "  fluentd-gm started"
  else
    echo "  WARNING: fluentd-gm failed to start (may not be configured)"
  fi
fi

# Start fluentd-lm (forwards HAProxy logs to GM)
if is_service_running "fluentd-lm"; then
  echo "  fluentd-lm already running"
else
  sudob_service start fluentd-lm >/dev/null 2>&1 || true
  sleep 1
  if is_service_running "fluentd-lm"; then
    echo "  fluentd-lm started"
  else
    echo "  WARNING: fluentd-lm failed to start (may not be configured)"
  fi
fi

# ============================================================================
# Start API server (direct npm - not systemd)
# ============================================================================
echo "Starting API server (MOCK_AUTH=true)..."
cd /home/olet/suiftly-co
MOCK_AUTH=true DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" \
  npx tsx apps/api/src/server.ts > /tmp/suiftly-api.log 2>&1 &
API_PID=$!
echo "$API_PID" > /tmp/suiftly-api.pid

for i in {1..10}; do
  sleep 1
  if curl -sf http://localhost:22700/health >/dev/null 2>&1; then
    break
  fi
  echo "  Waiting for API... ($i/10)"
done

if ! kill -0 $API_PID 2>/dev/null; then
  echo "ERROR: API server failed to start"
  cat /tmp/suiftly-api.log
  exit 1
fi

if ! curl -sf http://localhost:22700/health >/dev/null 2>&1; then
  echo "ERROR: API server not responding on port 22700"
  exit 1
fi
echo "  API server started (PID: $API_PID)"

# ============================================================================
# Start Webapp (direct npm - not systemd)
# ============================================================================
echo "Starting Webapp..."
cd /home/olet/suiftly-co/apps/webapp
npm run dev > /tmp/suiftly-webapp.log 2>&1 &
WEBAPP_PID=$!
echo "$WEBAPP_PID" > /tmp/suiftly-webapp.pid
sleep 4

if ! kill -0 $WEBAPP_PID 2>/dev/null; then
  echo "ERROR: Webapp failed to start"
  cat /tmp/suiftly-webapp.log
  exit 1
fi
echo "  Webapp started (PID: $WEBAPP_PID)"

# ============================================================================
# Summary
# ============================================================================
# Check fluentd status for summary
FLUENTD_GM_STATUS="stopped"
FLUENTD_LM_STATUS="stopped"
is_service_running "fluentd-gm" && FLUENTD_GM_STATUS="running"
is_service_running "fluentd-lm" && FLUENTD_LM_STATUS="running"

echo ""
echo "========================================"
echo "Dev servers running!"
echo "========================================"
echo "GM:         http://localhost:22600 (systemd)"
echo "Admin:      http://localhost:22601 (PID: $ADMIN_PID)"
echo "LM:         http://localhost:22610 (systemd)"
echo "fluentd-gm: $FLUENTD_GM_STATUS (systemd)"
echo "fluentd-lm: $FLUENTD_LM_STATUS (systemd)"
echo "API:        http://localhost:22700 (PID: $API_PID)"
echo "Webapp:     http://localhost:22710 (PID: $WEBAPP_PID)"
echo ""
echo "Logs:"
echo "  GM:         sudo journalctl -u suiftly-gm -f"
echo "  LM:         sudo journalctl -u suiftly-lm -f"
echo "  fluentd-gm: sudo journalctl -u fluentd-gm -f"
echo "  fluentd-lm: sudo journalctl -u fluentd-lm -f"
echo "  Admin:      /tmp/suiftly-admin.log"
echo "  API:        /tmp/suiftly-api.log"
echo "  Webapp:     /tmp/suiftly-webapp.log"
echo ""
echo "To stop: ./scripts/dev/stop-dev.sh"
echo "========================================"
