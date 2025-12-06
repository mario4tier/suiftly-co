#!/bin/bash
# Stop all dev servers cleanly with robust port cleanup

echo "🛑 Stopping dev servers..."

# Function to check if port is free
is_port_free() {
  local port=$1
  ! lsof -ti:$port >/dev/null 2>&1
}

# Function to force kill processes on port
force_kill_port() {
  local port=$1
  echo "  🧹 Cleaning up port $port..."

  # Get PIDs of processes LISTENING on port (not just connected)
  # This prevents killing parent processes that might have connections
  local pids=$(lsof -ti:$port -sTCP:LISTEN 2>/dev/null || true)

  if [ -n "$pids" ]; then
    # Convert newlines to spaces for kill command
    local pids_spaced=$(echo "$pids" | tr '\n' ' ')
    echo "     Killing PIDs: $pids_spaced"
    # Suppress stderr to avoid npm error messages
    kill -9 $pids_spaced 2>/dev/null || true
    sleep 1
  fi
}

# Kill by saved PIDs first (fastest)
if [ -f /tmp/suiftly-gm.pid ]; then
  GM_PID=$(cat /tmp/suiftly-gm.pid)
  echo "  📍 Killing Global Manager (PID $GM_PID)..."
  kill -9 $GM_PID 2>/dev/null || true
  rm /tmp/suiftly-gm.pid
fi

if [ -f /tmp/suiftly-admin.pid ]; then
  ADMIN_PID=$(cat /tmp/suiftly-admin.pid)
  echo "  📍 Killing Admin webapp (PID $ADMIN_PID)..."
  kill -9 $ADMIN_PID 2>/dev/null || true
  rm /tmp/suiftly-admin.pid
fi

if [ -f /tmp/suiftly-lm.pid ]; then
  LM_PID=$(cat /tmp/suiftly-lm.pid)
  echo "  📍 Killing Local Manager (PID $LM_PID)..."
  kill -9 $LM_PID 2>/dev/null || true
  rm /tmp/suiftly-lm.pid
fi

if [ -f /tmp/suiftly-api.pid ]; then
  API_PID=$(cat /tmp/suiftly-api.pid)
  echo "  📍 Killing API server (PID $API_PID)..."
  kill -9 $API_PID 2>/dev/null || true
  rm /tmp/suiftly-api.pid
fi

if [ -f /tmp/suiftly-webapp.pid ]; then
  WEBAPP_PID=$(cat /tmp/suiftly-webapp.pid)
  echo "  📍 Killing webapp (PID $WEBAPP_PID)..."
  kill -9 $WEBAPP_PID 2>/dev/null || true
  rm /tmp/suiftly-webapp.pid
fi

# Fallback: kill by process name
echo "  🔍 Cleaning up any remaining server processes..."
pkill -9 -f "tsx.*server" 2>/dev/null || true
pkill -9 -f "vite" 2>/dev/null || true
pkill -9 -f "node.*vite" 2>/dev/null || true

# Final fallback: force kill by port (most robust)
force_kill_port 22600
force_kill_port 22601
force_kill_port 22610
force_kill_port 22700
force_kill_port 22710
force_kill_port 3000
force_kill_port 5173
force_kill_port 5174
force_kill_port 5175

# Verify ports are free
echo "  ✅ Verifying ports are free..."
for port in 22600 22601 22610 22700 22710; do
  if is_port_free $port; then
    echo "     Port $port is free"
  else
    echo "     ⚠️  Warning: Port $port still occupied (may need manual cleanup)"
  fi
done

echo "✅ All dev servers stopped"
