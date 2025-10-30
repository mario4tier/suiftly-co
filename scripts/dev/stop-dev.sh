#!/bin/bash
# Stop all dev servers cleanly

echo "🛑 Stopping dev servers..."

# Kill by saved PIDs first
if [ -f /tmp/suiftly-api.pid ]; then
  API_PID=$(cat /tmp/suiftly-api.pid)
  kill -9 $API_PID 2>/dev/null || true
  rm /tmp/suiftly-api.pid
fi

if [ -f /tmp/suiftly-webapp.pid ]; then
  WEBAPP_PID=$(cat /tmp/suiftly-webapp.pid)
  kill -9 $WEBAPP_PID 2>/dev/null || true
  rm /tmp/suiftly-webapp.pid
fi

# Fallback: kill by process name
pkill -9 -f "tsx.*server" 2>/dev/null || true
pkill -9 -f "vite" 2>/dev/null || true
pkill -9 -f "node.*vite" 2>/dev/null || true

# Fallback: kill by port
lsof -ti:3000,5173,5174,5175 2>/dev/null | xargs kill -9 2>/dev/null || true

sleep 1

echo "✅ All dev servers stopped"
