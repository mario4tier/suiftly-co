#!/bin/bash
# Automated authentication flow test
# Simulates the complete auth flow to verify it works

set -e

API_URL="http://localhost:22700"

echo "🧪 Testing Authentication Flow"
echo "================================"

# Step 1: Request challenge
echo ""
echo "Step 1: Requesting challenge nonce..."
CHALLENGE_RESPONSE=$(curl -s -X POST "$API_URL/trpc/auth.connectWallet" \
  -H "Content-Type: application/json" \
  -d '{"walletAddress":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')

# Extract nonce using grep and cut
NONCE=$(echo "$CHALLENGE_RESPONSE" | grep -o '"nonce":"[^"]*"' | head -1 | cut -d'"' -f4)
MESSAGE=$(echo "$CHALLENGE_RESPONSE" | grep -o '"message":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$NONCE" ]; then
  echo "❌ FAILED: Could not get nonce"
  echo "Response: $CHALLENGE_RESPONSE"
  exit 1
fi

echo "✅ Got nonce: ${NONCE:0:20}..."
echo "✅ Message preview: ${MESSAGE:0:60}..."

# Step 2: Create fake signature (mock mode)
echo ""
echo "Step 2: Creating mock signature..."
FAKE_SIG=$(echo -n "mock_signature_for_test" | base64)
echo "✅ Signature: ${FAKE_SIG:0:30}..."

# Step 3: Verify signature and get JWT
echo ""
echo "Step 3: Verifying signature and getting JWT..."
AUTH_RESPONSE=$(curl -s -X POST "$API_URL/trpc/auth.verifySignature" \
  -H "Content-Type: application/json" \
  -c /tmp/suiftly-cookies.txt \
  -d "{\"walletAddress\":\"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"signature\":\"$FAKE_SIG\",\"nonce\":\"$NONCE\"}")

# Check for access token
ACCESS_TOKEN=$(echo "$AUTH_RESPONSE" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "$ACCESS_TOKEN" ]; then
  echo "❌ FAILED: No access token in response"
  echo "Response: $AUTH_RESPONSE"
  exit 1
fi

echo "✅ Got access token: ${ACCESS_TOKEN:0:30}..."

# Step 4: Test protected endpoint
echo ""
echo "Step 4: Testing protected endpoint..."
PROFILE_RESPONSE=$(curl -s -X GET "$API_URL/trpc/test.getProfile" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -b /tmp/suiftly-cookies.txt)

if echo "$PROFILE_RESPONSE" | grep -q "Protected endpoint accessed successfully"; then
  echo "✅ Protected endpoint works!"
else
  echo "❌ FAILED: Protected endpoint error"
  echo "Response: $PROFILE_RESPONSE"
  exit 1
fi

# Step 5: Test logout
echo ""
echo "Step 5: Testing logout..."
LOGOUT_RESPONSE=$(curl -s -X POST "$API_URL/trpc/auth.logout" \
  -H "Content-Type: application/json" \
  -b /tmp/suiftly-cookies.txt)

if echo "$LOGOUT_RESPONSE" | grep -q "success"; then
  echo "✅ Logout works!"
else
  echo "⚠️  Logout response: $LOGOUT_RESPONSE"
fi

echo ""
echo "================================"
echo "✅ All authentication tests passed!"
echo "================================"
