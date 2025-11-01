# TDD Plan: Token Refresh Implementation

## Goal
Test-driven development for automatic token refresh with **fail-safe** mechanisms to prevent test expiry times in production.

---

## Safety Strategy: Multi-Layer Guards

### Layer 1: Environment Detection
```typescript
// Only allow short expiry if ALL conditions met:
// 1. NODE_ENV === 'test' OR 'development'
// 2. ENABLE_SHORT_JWT_EXPIRY === 'true' (explicit opt-in)
// 3. JWT_SECRET contains 'TEST' or 'DEV' substring
```

### Layer 2: Production Guards
```typescript
// In production JWT config, throw error if expiry < minimum safe values:
function validateJWTConfig(config) {
  const MIN_ACCESS_TOKEN_SECONDS = 60;  // Never less than 1 minute
  const MIN_REFRESH_TOKEN_SECONDS = 3600; // Never less than 1 hour

  if (process.env.NODE_ENV === 'production') {
    if (config.accessTokenExpiry < MIN_ACCESS_TOKEN_SECONDS) {
      throw new Error('FATAL: Access token expiry too short for production!');
    }
    if (config.refreshTokenExpiry < MIN_REFRESH_TOKEN_SECONDS) {
      throw new Error('FATAL: Refresh token expiry too short for production!');
    }
  }
}
```

### Layer 3: Test-Only Configuration
```typescript
// Test configuration file that CANNOT be imported in production code
// apps/api/src/lib/jwt.test-config.ts

if (process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: Cannot import test JWT config in production!');
}

export const TEST_JWT_CONFIG = {
  accessTokenExpiry: '2s',   // 2 seconds for quick testing
  refreshTokenExpiry: '10s', // 10 seconds for refresh testing
  secret: 'TEST_SECRET_NEVER_USE_IN_PRODUCTION',
};
```

---

## Test Suite Design

### Test 1: Access Token Expiry & Auto-Refresh (2-second expiry)
```typescript
describe('Token Refresh - Access Token Expiry', () => {
  it('should automatically refresh expired access token and retry request', async () => {
    // Setup: Login and get tokens (2s access, 10s refresh)
    const { accessToken } = await login();

    // Wait for access token to expire (2 seconds + buffer)
    await sleep(2500);

    // Make API call - should fail with 401, then auto-refresh, then succeed
    const result = await trpc.user.getProfile.query();

    // Assertion: Request succeeded (auto-refresh happened)
    expect(result).toBeDefined();
    expect(result.walletAddress).toBe('0xtest...');
  });

  it('should update access token in store after refresh', async () => {
    const { accessToken: initialToken } = await login();

    await sleep(2500); // Wait for expiry

    await trpc.user.getProfile.query();

    // Check that access token in store was updated
    const newToken = getAccessToken();
    expect(newToken).not.toBe(initialToken);
    expect(newToken).toBeTruthy();
  });
});
```

### Test 2: Refresh Token Expiry (10-second expiry)
```typescript
describe('Token Refresh - Refresh Token Expiry', () => {
  it('should redirect to login when refresh token expires', async () => {
    await login();

    // Wait for both tokens to expire (10 seconds + buffer)
    await sleep(11000);

    // Make API call - should fail to refresh, clear auth, return 401
    try {
      await trpc.user.getProfile.query();
      fail('Should have thrown 401');
    } catch (error) {
      expect(error.code).toBe('UNAUTHORIZED');
    }

    // Check auth state cleared
    const authState = useAuthStore.getState();
    expect(authState.isAuthenticated).toBe(false);
  });
});
```

### Test 3: Multiple Concurrent Requests During Refresh
```typescript
describe('Token Refresh - Race Conditions', () => {
  it('should handle multiple concurrent 401s without duplicate refresh calls', async () => {
    await login();
    await sleep(2500); // Expire access token

    // Make 5 concurrent API calls
    const requests = Promise.all([
      trpc.user.getProfile.query(),
      trpc.user.getSettings.query(),
      trpc.services.list.query(),
      trpc.billing.getBalance.query(),
      trpc.apiKeys.list.query(),
    ]);

    // All should succeed with only ONE refresh call
    const results = await requests;
    expect(results).toHaveLength(5);
    expect(mockRefreshEndpoint).toHaveBeenCalledTimes(1); // Not 5!
  });
});
```

---

## Implementation Plan

### Step 1: Create JWT Config with Guards
**File:** `apps/api/src/lib/jwt-config.ts`

```typescript
interface JWTConfig {
  accessTokenExpiry: string;
  refreshTokenExpiry: string;
  secret: string;
}

/**
 * PRODUCTION CONFIG (fail-safe defaults)
 */
export function getProductionJWTConfig(): JWTConfig {
  const config = {
    accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
    secret: process.env.JWT_SECRET!,
  };

  // GUARD: Validate minimum expiry times in production
  if (process.env.NODE_ENV === 'production') {
    validateProductionSafety(config);
  }

  return config;
}

/**
 * TEST CONFIG (explicit opt-in with guards)
 */
export function getTestJWTConfig(): JWTConfig {
  // GUARD 1: Only allow in test/dev environments
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: Cannot use test JWT config in production!');
  }

  // GUARD 2: Require explicit opt-in
  if (process.env.ENABLE_SHORT_JWT_EXPIRY !== 'true') {
    throw new Error('Must set ENABLE_SHORT_JWT_EXPIRY=true to use test config');
  }

  // GUARD 3: Require test secret
  const secret = process.env.JWT_SECRET || '';
  if (!secret.includes('TEST') && !secret.includes('DEV')) {
    throw new Error('JWT_SECRET must contain TEST or DEV for short expiry');
  }

  return {
    accessTokenExpiry: '2s',
    refreshTokenExpiry: '10s',
    secret,
  };
}

/**
 * AUTO-SELECT CONFIG (safe fallback to production)
 */
export function getJWTConfig(): JWTConfig {
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.ENABLE_SHORT_JWT_EXPIRY === 'true'
  ) {
    console.log('[JWT] Using TEST config (short expiry)');
    return getTestJWTConfig();
  }

  console.log('[JWT] Using PRODUCTION config');
  return getProductionJWTConfig();
}

function validateProductionSafety(config: JWTConfig) {
  // Parse expiry strings to seconds
  const accessSeconds = parseExpiry(config.accessTokenExpiry);
  const refreshSeconds = parseExpiry(config.refreshTokenExpiry);

  if (accessSeconds < 60) {
    throw new Error(
      `FATAL: Access token expiry (${accessSeconds}s) too short for production! Minimum: 60s`
    );
  }

  if (refreshSeconds < 3600) {
    throw new Error(
      `FATAL: Refresh token expiry (${refreshSeconds}s) too short for production! Minimum: 3600s`
    );
  }
}

function parseExpiry(expiry: string): number {
  // Parse '15m', '30d', '2s' etc to seconds
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error(`Invalid expiry format: ${expiry}`);

  const value = parseInt(match[1]);
  const unit = match[2];

  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * multipliers[unit];
}
```

### Step 2: Update JWT Generation
**File:** `apps/api/src/lib/jwt.ts`

```typescript
import { getJWTConfig } from './jwt-config';

export async function generateAccessToken(payload: JWTPayload) {
  const config = getJWTConfig();

  return jsonwebtoken.sign(payload, config.secret, {
    expiresIn: config.accessTokenExpiry,
  });
}

export async function generateRefreshToken(payload: JWTPayload) {
  const config = getJWTConfig();

  return jsonwebtoken.sign(payload, config.secret, {
    expiresIn: config.refreshTokenExpiry,
  });
}
```

### Step 3: Test Environment Setup
**File:** `apps/webapp/.env.test`

```bash
NODE_ENV=test
ENABLE_SHORT_JWT_EXPIRY=true
JWT_SECRET=TEST_SECRET_FOR_UNIT_TESTS
```

### Step 4: CI/CD Guard
**File:** `.github/workflows/deploy.yml` (or deployment script)

```yaml
# Production deployment check
- name: Verify Production JWT Config
  if: env.DEPLOYMENT_ENV == 'production'
  run: |
    if grep -q "ENABLE_SHORT_JWT_EXPIRY=true" .env.production; then
      echo "❌ FATAL: Test JWT config detected in production!"
      exit 1
    fi

    if grep -q "JWT_SECRET.*TEST" .env.production; then
      echo "❌ FATAL: Test JWT secret detected in production!"
      exit 1
    fi

    echo "✅ Production JWT config validated"
```

---

## Running Tests

**Quick tests (2-second access token):**
```bash
ENABLE_SHORT_JWT_EXPIRY=true JWT_SECRET=TEST_DEV npm test
```

**Long test (10-second refresh token):**
```bash
ENABLE_SHORT_JWT_EXPIRY=true JWT_SECRET=TEST_DEV npm test -- --testTimeout=15000
```

**Production guard verification:**
```bash
NODE_ENV=production npm test
# Should throw error if trying to use short expiry
```

---

## Safety Checklist

- [ ] Test config CANNOT be imported if `NODE_ENV === 'production'`
- [ ] Production JWT generation validates minimum expiry times
- [ ] Test expiry requires THREE conditions: test env + explicit flag + test secret
- [ ] CI/CD checks for test config in production deployments
- [ ] Default behavior is ALWAYS production-safe (long expiry)

---

## Benefits

✅ **Fast tests:** 2-second access token expiry (instead of 15 minutes)
✅ **Full coverage:** Can test 30-day refresh expiry in 10 seconds
✅ **Production safe:** Multiple layers prevent accidents
✅ **Explicit opt-in:** Test config requires conscious decision
✅ **CI/CD protection:** Deployment fails if test config detected

This approach allows rapid TDD iteration while making it **virtually impossible** to accidentally use test expiry in production!
