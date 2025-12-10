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

# Kill by port (force) - includes gm (22600), admin webapp (22601), lm (22610)
lsof -ti:22600,22601,22610,22700,22710,3000,5173,5174,5175 2>/dev/null | xargs kill -9 2>/dev/null || true

# Wait for ports to be released
sleep 2

# Verify ports are free
for port in 22600 22601 22610 22700 22710; do
  if lsof -i:$port >/dev/null 2>&1; then
    echo "❌ ERROR: Port $port still in use"
    lsof -i:$port
    exit 1
  fi
done

echo "✅ All ports free, starting servers..."

# Start Global Manager (gm)
echo "🌍 Starting Global Manager (gm)..."
cd /home/olet/suiftly-co
npx tsx services/global-manager/src/server.ts > /tmp/suiftly-gm.log 2>&1 &
GM_PID=$!

# Wait for gm to be ready (up to 5 seconds)
for i in {1..5}; do
  sleep 1
  if curl -s http://localhost:22600/health >/dev/null 2>&1; then
    break
  fi
  echo "  Waiting for gm... ($i/5)"
done

# Verify gm started
if ! kill -0 $GM_PID 2>/dev/null; then
  echo "❌ ERROR: Global Manager failed to start"
  cat /tmp/suiftly-gm.log
  exit 1
fi

if ! curl -s http://localhost:22600/health >/dev/null 2>&1; then
  echo "❌ ERROR: Global Manager not responding on port 22600"
  exit 1
fi

echo "✅ Global Manager started (PID: $GM_PID)"

# Start Admin Webapp (gm dashboard)
echo "🖥️  Starting Admin Webapp..."
cd /home/olet/suiftly-co/services/global-manager/webapp
npm run dev > /tmp/suiftly-admin.log 2>&1 &
ADMIN_PID=$!

sleep 3

# Verify Admin webapp started
if ! kill -0 $ADMIN_PID 2>/dev/null; then
  echo "❌ ERROR: Admin webapp failed to start"
  cat /tmp/suiftly-admin.log
  exit 1
fi

echo "✅ Admin Webapp started (PID: $ADMIN_PID)"

# Start Local Manager (lm) from walrus repo
echo "📍 Starting Local Manager (lm) from walrus..."
cd /home/olet/walrus/services/local-manager
npx tsx src/server.ts > /tmp/suiftly-lm.log 2>&1 &
LM_PID=$!

# Wait for lm to be ready (up to 5 seconds)
for i in {1..5}; do
  sleep 1
  if curl -s http://localhost:22610/health >/dev/null 2>&1; then
    break
  fi
  echo "  Waiting for lm... ($i/5)"
done

# Verify lm started
if ! kill -0 $LM_PID 2>/dev/null; then
  echo "❌ ERROR: Local Manager failed to start"
  cat /tmp/suiftly-lm.log
  exit 1
fi

if ! curl -s http://localhost:22610/health >/dev/null 2>&1; then
  echo "❌ ERROR: Local Manager not responding on port 22610"
  exit 1
fi

echo "✅ Local Manager started (PID: $LM_PID)"

echo "🚀 Starting API server (MOCK_AUTH=true)..."
cd /home/olet/suiftly-co
MOCK_AUTH=true DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" \
  npx tsx apps/api/src/server.ts > /tmp/suiftly-api.log 2>&1 &
API_PID=$!

# Wait for API to be ready (up to 10 seconds)
for i in {1..10}; do
  sleep 1
  if curl -s http://localhost:22700/health >/dev/null 2>&1; then
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

if ! curl -s http://localhost:22700/health >/dev/null 2>&1; then
  echo "❌ ERROR: API server not responding on port 22700"
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
echo "🌍 GM:     http://localhost:22600"
echo "🖥️  Admin:  http://localhost:22601"
echo "📍 LM:     http://localhost:22610"
echo "📡 API:    http://localhost:22700 (MOCK_AUTH=true)"
echo "🌐 Webapp: http://localhost:22710"
echo ""
echo "Logs:"
echo "  GM:     /tmp/suiftly-gm.log"
echo "  Admin:  /tmp/suiftly-admin.log"
echo "  LM:     /tmp/suiftly-lm.log"
echo "  API:    /tmp/suiftly-api.log"
echo "  Webapp: /tmp/suiftly-webapp.log"
echo ""
echo "PIDs:"
echo "  GM:     $GM_PID"
echo "  Admin:  $ADMIN_PID"
echo "  LM:     $LM_PID"
echo "  API:    $API_PID"
echo "  Webapp: $WEBAPP_PID"
echo ""
echo "To stop: ./scripts/dev/stop-dev.sh"
echo "        or: pkill -9 -f 'tsx.*server|vite'"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Save PIDs for stop script
echo "$GM_PID" > /tmp/suiftly-gm.pid
echo "$ADMIN_PID" > /tmp/suiftly-admin.pid
echo "$LM_PID" > /tmp/suiftly-lm.pid
echo "$API_PID" > /tmp/suiftly-api.pid
echo "$WEBAPP_PID" > /tmp/suiftly-webapp.pid
