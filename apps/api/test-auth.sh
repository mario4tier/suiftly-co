#!/bin/bash
# Test authentication flow end-to-end
# Run with: cd apps/api && bash test-auth.sh

echo "🧪 Testing Authentication Flow..."
echo ""

WALLET="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

# Step 1: Connect wallet (get nonce)
echo "Step 1: Connecting wallet..."
RESPONSE=$(curl -s -X POST http://localhost:3000/trpc/auth.connectWallet \
  -H "Content-Type: application/json" \
  -d "{\"walletAddress\":\"$WALLET\"}")

echo "Response: $RESPONSE"
NONCE=$(echo $RESPONSE | grep -oP '"nonce":"[^"]+' | cut -d'"' -f4)

if [ -z "$NONCE" ]; then
  echo "❌ Failed to get nonce"
  exit 1
fi

echo "✓ Got nonce: ${NONCE:0:16}..."
echo ""

# Step 2: Verify signature (mock mode accepts any signature)
echo "Step 2: Verifying signature (mock mode)..."
RESPONSE=$(curl -s -X POST http://localhost:3000/trpc/auth.verifySignature \
  -H "Content-Type: application/json" \
  -d "{
    \"walletAddress\":\"$WALLET\",
    \"signature\":\"mock_signature_any_value_works\",
    \"nonce\":\"$NONCE\"
  }")

echo "Response: $RESPONSE"
echo ""

# Check if we got a customerId
CUSTOMER_ID=$(echo $RESPONSE | grep -oP '"customerId":\d+' | grep -oP '\d+')

if [ -z "$CUSTOMER_ID" ]; then
  echo "❌ Failed to verify signature"
  echo "Full response: $RESPONSE"
  exit 1
fi

echo "✓ Authentication successful!"
echo "  Customer ID: $CUSTOMER_ID"
echo ""
echo "✅ All auth tests passed!"
