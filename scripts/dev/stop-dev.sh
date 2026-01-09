#!/bin/bash
# Stop all dev servers cleanly
# Uses sudob for systemd services (GM, LM, fluentd), direct kill for others

SUDOB_URL="http://localhost:22800"
SYSTEM_CONF="/etc/walrus/system.conf"

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
  echo "  sudob is required to manage systemd services (GM, LM, fluentd)."
  echo ""
  echo "  To start sudob:"
  echo "    sudo systemctl start sudob"
  echo ""
  echo "  Continuing with non-systemd cleanup only..."
  echo ""
  SUDOB_AVAILABLE=false
else
  SUDOB_AVAILABLE=true
fi

echo "Stopping dev servers..."

# ============================================================================
# Helper functions
# ============================================================================

is_port_free() {
  local port=$1
  ! lsof -ti:$port >/dev/null 2>&1
}

force_kill_port() {
  local port=$1
  local pids=$(lsof -ti:$port -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    local pids_spaced=$(echo "$pids" | tr '\n' ' ')
    kill -9 $pids_spaced 2>/dev/null || true
    sleep 1
  fi
}

# Call sudob to manage a service
sudob_service() {
  local action=$1
  local service=$2
  curl -sf -X POST "$SUDOB_URL/api/service/$action" \
    -H 'Content-Type: application/json' \
    -d "{\"service\":\"$service\"}" 2>/dev/null
}

# ============================================================================
# Stop systemd services via sudob (if sudob is running)
# ============================================================================
if [ "$SUDOB_AVAILABLE" = true ]; then
  echo "  Stopping fluentd services via sudob..."
  sudob_service stop lm-fluentd >/dev/null 2>&1 || true
  sudob_service stop gm-fluentd >/dev/null 2>&1 || true

  echo "  Stopping GM via sudob..."
  sudob_service stop suiftly-gm >/dev/null || true

  echo "  Stopping LM via sudob..."
  sudob_service stop suiftly-lm >/dev/null || true
else
  echo "  sudob not running - systemd services must be stopped manually:"
  echo "    sudo systemctl stop lm-fluentd gm-fluentd suiftly-gm suiftly-lm"
fi

# ============================================================================
# Stop non-systemd processes by PID
# ============================================================================
if [ -f /tmp/suiftly-admin.pid ]; then
  ADMIN_PID=$(cat /tmp/suiftly-admin.pid)
  echo "  Stopping Admin webapp (PID $ADMIN_PID)..."
  kill -9 $ADMIN_PID 2>/dev/null || true
  rm /tmp/suiftly-admin.pid
fi

if [ -f /tmp/suiftly-api.pid ]; then
  API_PID=$(cat /tmp/suiftly-api.pid)
  echo "  Stopping API server (PID $API_PID)..."
  kill -9 $API_PID 2>/dev/null || true
  rm /tmp/suiftly-api.pid
fi

if [ -f /tmp/suiftly-webapp.pid ]; then
  WEBAPP_PID=$(cat /tmp/suiftly-webapp.pid)
  echo "  Stopping Webapp (PID $WEBAPP_PID)..."
  kill -9 $WEBAPP_PID 2>/dev/null || true
  rm /tmp/suiftly-webapp.pid
fi

# Clean up old PID files from previous script version
rm -f /tmp/suiftly-gm.pid /tmp/suiftly-lm.pid 2>/dev/null

# ============================================================================
# Fallback: kill by process name (non-systemd only)
# ============================================================================
echo "  Cleaning up remaining processes..."
pkill -9 -f "tsx.*apps/api" 2>/dev/null || true
pkill -9 -f "vite" 2>/dev/null || true
pkill -9 -f "node.*vite" 2>/dev/null || true

# ============================================================================
# Force kill by port (API and Webapp ports only - not GM/LM)
# ============================================================================
force_kill_port 22700
force_kill_port 22710
force_kill_port 22601
force_kill_port 3000
force_kill_port 5173
force_kill_port 5174
force_kill_port 5175

# ============================================================================
# Verify ports are free
# ============================================================================
echo "  Verifying ports..."
ALL_FREE=true
for port in 22700 22710; do
  if is_port_free $port; then
    echo "    Port $port is free"
  else
    echo "    WARNING: Port $port still occupied"
    ALL_FREE=false
  fi
done

# Check systemd service ports
for port in 22600 22610; do
  if is_port_free $port; then
    echo "    Port $port is free"
  else
    echo "    Port $port in use (systemd service may still be running)"
  fi
done

if [ "$ALL_FREE" = true ]; then
  echo "All dev servers stopped"
else
  echo "Some processes may still be running"
fi
