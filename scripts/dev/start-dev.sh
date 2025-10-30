#!/bin/bash
# Clean dev server startup script
# Aggressively kills ALL existing servers and starts fresh

set -e

echo "🧹 Cleaning up ALL existing dev servers..."

# Kill by process name (multiple passes to catch stragglers)
for i in {1..3}; do
  pkill -9 -f "tsx.*server" 2>/dev/null || true
  pkill -9 -f "vite" 2>/dev/null || true
  pkill -9 -f "node.*vite" 2>/dev/null || true
  sleep 1
done

# Kill by port (force)
lsof -ti:3000,5173,5174,5175 2>/dev/null | xargs kill -9 2>/dev/null || true

# Wait for ports to be released
sleep 2

# Verify ports are free
if lsof -i:3000 >/dev/null 2>&1; then
  echo "❌ ERROR: Port 3000 still in use"
  lsof -i:3000
  exit 1
fi

if lsof -i:5173 >/dev/null 2>&1; then
  echo "❌ ERROR: Port 5173 still in use"
  lsof -i:5173
  exit 1
fi

echo "✅ All ports free, starting servers..."

echo "🚀 Starting API server (MOCK_AUTH=true)..."
cd /home/olet/suiftly-co
MOCK_AUTH=true DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" \
  npx tsx apps/api/src/server.ts > /tmp/suiftly-api.log 2>&1 &
API_PID=$!

# Wait for API to be ready (up to 10 seconds)
for i in {1..10}; do
  sleep 1
  if curl -s http://localhost:3000/health >/dev/null 2>&1; then
    break
  fi
  echo "  Waiting for API... ($i/10)"
done

# Verify API started
if ! kill -0 $API_PID 2>/dev/null; then
  echo "❌ ERROR: API server failed to start"
  cat /tmp/suiftly-api.log
  exit 1
fi

if ! curl -s http://localhost:3000/health >/dev/null 2>&1; then
  echo "❌ ERROR: API server not responding on port 3000"
  exit 1
fi

echo "✅ API server started (PID: $API_PID)"

echo "🌐 Starting Webapp..."
cd /home/olet/suiftly-co/apps/webapp
npm run dev > /tmp/suiftly-webapp.log 2>&1 &
WEBAPP_PID=$!

sleep 4

# Verify Webapp started
if ! kill -0 $WEBAPP_PID 2>/dev/null; then
  echo "❌ ERROR: Webapp failed to start"
  cat /tmp/suiftly-webapp.log
  exit 1
fi

echo "✅ Webapp started (PID: $WEBAPP_PID)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Dev servers running!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📡 API: http://localhost:3000 (MOCK_AUTH=true)"
echo "🌐 Webapp: http://localhost:5173"
echo ""
echo "Logs:"
echo "  API: /tmp/suiftly-api.log"
echo "  Webapp: /tmp/suiftly-webapp.log"
echo ""
echo "PIDs:"
echo "  API: $API_PID"
echo "  Webapp: $WEBAPP_PID"
echo ""
echo "To stop: ./scripts/dev/stop-dev.sh"
echo "        or: pkill -9 -f 'tsx.*server|vite'"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Save PIDs for stop script
echo "$API_PID" > /tmp/suiftly-api.pid
echo "$WEBAPP_PID" > /tmp/suiftly-webapp.pid
