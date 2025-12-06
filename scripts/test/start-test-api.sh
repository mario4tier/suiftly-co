#!/bin/bash
# Start API server with short JWT expiry for testing

set -e

cd "$(dirname "$0")/../.."

echo "🧪 Starting API server with TEST config (2s/10s JWT expiry)..."

NODE_ENV=development \
ENABLE_SHORT_JWT_EXPIRY=true \
JWT_SECRET=TEST_DEV_SECRET_1234567890abcdef \
MOCK_AUTH=true \
DATABASE_URL="postgresql://deploy:deploy_password_change_me@localhost/suiftly_dev" \
npx tsx apps/api/src/server.ts > /tmp/suiftly-api-test.log 2>&1 &

API_PID=$!

# Wait for API to be ready
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
  cat /tmp/suiftly-api-test.log
  exit 1
fi

if ! curl -s http://localhost:22700/health >/dev/null 2>&1; then
  echo "❌ ERROR: API server not responding"
  exit 1
fi

echo "✅ API server started with test config (PID: $API_PID)"
echo "$API_PID" > /tmp/suiftly-api-test.pid
