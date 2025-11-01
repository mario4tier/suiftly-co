# Token Refresh Tests - Usage Guide

## Overview

Tests for JWT token expiry and automatic refresh in two scenarios:
1. **Normal Expiry** (15m access, 30d refresh) - Verifies tokens work correctly over time
2. **Short Expiry** (2s access, 10s refresh) - Verifies auto-refresh mechanism works

## Test Files

- **token-refresh.spec.ts** - Main test suite with both scenarios

## Running Tests

### 1. Normal Expiry Tests (Always Run - GREEN Phase Verification)

These tests verify that with normal 15-minute access tokens:
- Tokens remain valid after 5 seconds
- Tokens remain valid through multiple API calls over 10 seconds
- No unnecessary re-authentication occurs

**Run:**
```bash
# Start servers (if not already running)
npm run dev  # In one terminal

# Run normal expiry tests
npx playwright test token-refresh --grep "Normal Config"
```

**Expected Result:** ✅ All tests PASS (GREEN)

---

### 2. Short Expiry Tests (Optional - Requires Test Environment)

These tests verify auto-refresh logic by using 2-second access tokens:
- Access token expires after 2s
- Auto-refresh kicks in automatically
- Request succeeds without user intervention

**Setup:**
```bash
# 1. Stop normal dev servers

# 2. Start API with test config
cd apps/api
ENABLE_SHORT_JWT_EXPIRY=true JWT_SECRET=TEST_DEV MOCK_AUTH=true npm run dev

# 3. Start webapp (normal)
cd apps/webapp
npm run dev
```

**Run:**
```bash
# Run short expiry tests
npx playwright test token-refresh --grep "Short Expiry"
```

**Expected Result:** ✅ All tests PASS (auto-refresh working)

---

## Safety Features

### Production Guards

The JWT config has multiple safety layers:

1. **Environment Check**: Short expiry only works if `NODE_ENV !== 'production'`
2. **Explicit Opt-In**: Requires `ENABLE_SHORT_JWT_EXPIRY=true`
3. **Test Secret**: JWT_SECRET must contain 'TEST' or 'DEV'
4. **Runtime Validation**: Throws error if production has tokens < 60s (access) or < 3600s (refresh)

### Files

- `apps/api/src/lib/jwt-config.ts` - Configuration with guards
- `apps/api/src/lib/jwt.ts` - Token generation using config
- `apps/api/.env.test` - Test environment template

---

## Current Test Status

### ✅ Implemented & Ready to Run
- Normal expiry tests (15m/30d)
- Production safety guards
- JWT config system

### 🔄 Partially Implemented (Short Expiry Tests Skipped)
- Short expiry tests written but skipped by default
- Need to manually start servers with test config to enable
- Auto-refresh logic exists in `apps/webapp/src/lib/trpc.ts` (lines 42-96)

---

## What the Tests Verify

### Normal Expiry Tests
✅ Token valid after 5s (proves it's not expiring too quickly)
✅ Token valid after 10s with multiple API calls
✅ No unnecessary re-authentication

### Short Expiry Tests (when enabled)
✅ Auto-refresh triggers when access token expires (2s)
✅ Request succeeds after auto-refresh
✅ Refresh token expiry redirects to login (10s)
✅ Multiple concurrent 401s result in single refresh call

---

## Debugging

If normal expiry tests fail:
- Check that servers are running
- Check browser console for auth errors
- Verify JWT_SECRET is set in backend
- Check that mock wallet auth is working

If short expiry tests fail:
- Verify `ENABLE_SHORT_JWT_EXPIRY=true` is set
- Verify `JWT_SECRET` contains 'TEST' or 'DEV'
- Check backend logs for JWT config confirmation
- Verify auto-refresh logic in `trpc.ts` is working

---

## Architecture

Based on:
- [docs/TDD_TOKEN_REFRESH.md](../../../docs/TDD_TOKEN_REFRESH.md) - Full TDD plan
- [docs/AUTHENTICATION_DESIGN.md](../../../docs/AUTHENTICATION_DESIGN.md) - Auth architecture
