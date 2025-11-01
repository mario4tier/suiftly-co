#!/bin/bash
# Start both API and webapp with test config for Playwright
set -e

cd "$(dirname "$0")/../.."

echo "🧪 Starting test servers..."

# Start API with short JWT expiry
ENABLE_SHORT_JWT_EXPIRY=true \
JWT_SECRET=TEST_DEV_SECRET_1234567890abcdef \
MOCK_AUTH=true \
DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" \
npx tsx apps/api/src/server.ts &

API_PID=$!

# Wait for API
for i in {1..10}; do
  sleep 1
  if curl -s http://localhost:3000/health >/dev/null 2>&1; then
    echo "✅ API server ready (PID: $API_PID)"
    break
  fi
done

# Start webapp
cd apps/webapp
npm run dev &
WEBAPP_PID=$!

# Wait for webapp
for i in {1..10}; do
  sleep 1
  if curl -s http://localhost:5173 >/dev/null 2>&1; then
    echo "✅ Webapp ready (PID: $WEBAPP_PID)"
    break
  fi
done

echo "✅ Both servers running"
# Keep script alive
wait
