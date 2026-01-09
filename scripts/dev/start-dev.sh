#!/bin/bash
# Clean dev server startup script
# Uses sudob for systemd services (GM, LM), direct npm for others

set -e

SUDOB_URL="http://localhost:22800"
SYSTEM_CONF="/etc/walrus/system.conf"

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
  echo "    sudo ~/walrus/scripts/configure-deployment.py"
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

# Start gm-fluentd (aggregates logs from LM and writes to DB)
if is_service_running "gm-fluentd"; then
  echo "  gm-fluentd already running"
else
  sudob_service start gm-fluentd >/dev/null 2>&1 || true
  sleep 1
  if is_service_running "gm-fluentd"; then
    echo "  gm-fluentd started"
  else
    echo "  WARNING: gm-fluentd failed to start (may not be configured)"
  fi
fi

# Start lm-fluentd (forwards HAProxy logs to GM)
if is_service_running "lm-fluentd"; then
  echo "  lm-fluentd already running"
else
  sudob_service start lm-fluentd >/dev/null 2>&1 || true
  sleep 1
  if is_service_running "lm-fluentd"; then
    echo "  lm-fluentd started"
  else
    echo "  WARNING: lm-fluentd failed to start (may not be configured)"
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
GM_FLUENTD_STATUS="stopped"
LM_FLUENTD_STATUS="stopped"
is_service_running "gm-fluentd" && GM_FLUENTD_STATUS="running"
is_service_running "lm-fluentd" && LM_FLUENTD_STATUS="running"

echo ""
echo "========================================"
echo "Dev servers running!"
echo "========================================"
echo "GM:         http://localhost:22600 (systemd)"
echo "Admin:      http://localhost:22601 (PID: $ADMIN_PID)"
echo "LM:         http://localhost:22610 (systemd)"
echo "gm-fluentd: $GM_FLUENTD_STATUS (systemd)"
echo "lm-fluentd: $LM_FLUENTD_STATUS (systemd)"
echo "API:        http://localhost:22700 (PID: $API_PID)"
echo "Webapp:     http://localhost:22710 (PID: $WEBAPP_PID)"
echo ""
echo "Logs:"
echo "  GM:         sudo journalctl -u suiftly-gm -f"
echo "  LM:         sudo journalctl -u suiftly-lm -f"
echo "  gm-fluentd: sudo journalctl -u gm-fluentd -f"
echo "  lm-fluentd: sudo journalctl -u lm-fluentd -f"
echo "  Admin:      /tmp/suiftly-admin.log"
echo "  API:        /tmp/suiftly-api.log"
echo "  Webapp:     /tmp/suiftly-webapp.log"
echo ""
echo "To stop: ./scripts/dev/stop-dev.sh"
echo "========================================"
