# Authentication Design
**Wallet-based authentication with JWT sessions for Suiftly**

## Overview

Suiftly uses a hybrid authentication model that combines Web3 wallet signatures with Web2 session management:

- **Wallet connection** via `@mysten/dapp-kit` (client-side, auto-reconnects)
- **Cryptographic proof** via challenge-response signature
- **Session management** via JWT in httpOnly cookies
- **No passwords** - wallet ownership is identity

This approach provides Web3 security (cryptographic proof of wallet ownership) with Web2 convenience (no repeated signatures for every API call).

---

## Architecture Decision

After analyzing leading Sui DeFi protocols (Scallop, Navi, Suilend), we determined:

**DeFi apps don't need backend authentication** because:
- All user data is on-chain (public)
- Smart contracts handle authorization
- Wallets auto-reconnect via localStorage
- No secrets to protect

**Suiftly CANNOT use this model** because:
- API keys are off-chain secrets in database
- Must verify wallet ownership before revealing keys
- Risk of address spoofing if we trust client-side

**Therefore: Wallet signature verification + JWT sessions is required.**

---

## Authentication Flow

### Initial Wallet Connection (One-Time per Session)

```
┌──────────┐                ┌──────────┐              ┌──────────┐
│  Browser │                │   API    │              │ Wallet   │
│   (SPA)  │                │ Backend  │              │          │
└────┬─────┘                └────┬─────┘              └────┬─────┘
     │                           │                         │
     │ 1. User clicks "Connect Wallet"                    │
     ├────────────────────────────────────────────────────>│
     │                           │                         │
     │ 2. Wallet prompts: "Connect to app.suiftly.io?"    │
     │<────────────────────────────────────────────────────┤
     │                           │                         │
     │ 3. User approves connection                         │
     │────────────────────────────────────────────────────>│
     │                           │                         │
     │ 4. dApp Kit stores "last wallet" in localStorage   │
     │    (enables auto-reconnect on future visits)        │
     │                           │                         │
     │ 5. Request auth challenge │                         │
     ├──────────────────────────>│                         │
     │                           │                         │
     │ 6. Return challenge nonce │                         │
     │<──────────────────────────┤                         │
     │                           │                         │
     │ 7. Sign challenge message │                         │
     ├────────────────────────────────────────────────────>│
     │    "Sign in to Suiftly                              │
     │     Nonce: {uuid}                                   │
     │     Timestamp: {iso8601}"                           │
     │                           │                         │
     │ 8. Return signature       │                         │
     │<────────────────────────────────────────────────────┤
     │                           │                         │
     │ 9. Submit {address, signature, nonce, timestamp}    │
     ├──────────────────────────>│                         │
     │                           │                         │
     │    [Backend verifies:]    │                         │
     │    • Signature valid      │                         │
     │    • Nonce not used       │                         │
     │    • Timestamp recent     │                         │
     │                           │                         │
     │ 10. Set httpOnly cookie with JWT (4-hour expiry)   │
     │<──────────────────────────┤                         │
     │                           │                         │
     │ [User is authenticated]   │                         │
```

### Subsequent API Calls (No Wallet Interaction)

```
┌──────────┐                ┌──────────┐
│  Browser │                │   API    │
│   (SPA)  │                │ Backend  │
└────┬─────┘                └────┬─────┘
     │                           │
     │ API call (cookie auto-sent)│
     ├──────────────────────────>│
     │                           │
     │    [Validate JWT]         │
     │    [Authorize access]     │
     │                           │
     │ Return protected data     │
     │<──────────────────────────┤
```

### Blockchain Transactions (Wallet Signature Required)

```
┌──────────┐                ┌──────────┐              ┌──────────┐
│  Browser │                │   API    │              │ Wallet   │
└────┬─────┘                └────┬─────┘              └────┬─────┘
     │                           │                         │
     │ User: "Deposit $100"      │                         │
     ├──────────────────────────>│                         │
     │                           │                         │
     │ Return tx data            │                         │
     │<──────────────────────────┤                         │
     │                           │                         │
     │ Sign transaction          │                         │
     ├────────────────────────────────────────────────────>│
     │                           │                         │
     │ [Wallet popup: "Deposit 40.82 SUI?" → Approve]     │
     │                           │                         │
     │ Return signed tx          │                         │
     │<────────────────────────────────────────────────────┤
     │                           │                         │
     │ Submit signed tx          │                         │
     ├──────────────────────────>│                         │
     │                           │                         │
     │ [Verify + broadcast]      │                         │
     │ Return tx hash            │                         │
     │<──────────────────────────┤                         │
```

---

## Implementation Details

### Frontend (SPA with React)

**Wallet Connection Setup:**

```typescript
// app/layout.tsx - Root provider setup
import { WalletProvider } from '@mysten/dapp-kit'

export default function RootLayout({ children }) {
  return (
    <WalletProvider autoConnect={true}>
      {children}
    </WalletProvider>
  )
}
```

**Authentication Service:**

```typescript
// lib/auth.ts
export async function authenticateWallet(wallet: WalletAccount) {
  // 1. Request challenge from backend
  const { nonce, message } = await api.auth.getChallenge.query({
    address: wallet.address
  })

  // 2. Sign challenge with wallet
  const signature = await wallet.signMessage({ message })

  // 3. Submit to backend for JWT
  const { success } = await api.auth.verify.mutate({
    address: wallet.address,
    signature,
    nonce,
    timestamp: message.timestamp
  })

  if (!success) {
    throw new Error('Authentication failed')
  }

  // JWT now stored in httpOnly cookie by backend
  // No need to manually store in localStorage
}
```

**Protected API Calls:**

```typescript
// lib/trpc.ts
export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      credentials: 'include', // Send cookies automatically
    }),
  ],
})

// Usage (JWT sent automatically)
const apiKeys = await trpc.user.getAPIKeys.query()
```

### Backend (API with tRPC)

**Database Storage: PostgreSQL**

Two things must be stored in PostgreSQL to support multiple API servers:

1. **Nonces** (temporary) - Challenge-response nonces must be shared across servers. If User requests a challenge from Server A but submits the signature to Server B (load balanced), Server B needs to verify the nonce. In-memory storage would cause random auth failures.

2. **Refresh tokens** (long-lived) - Must be stored to enable revocation (logout, compromised token, etc.). JWTs are stateless and can't be revoked once issued, so we store refresh tokens in the database to control their validity.

Note: **Access tokens are NOT stored** - they're stateless JWTs verified using only the signing key. This is the standard JWT benefit you were thinking of!

**Database Schema:**

```sql
-- Migration: Create auth_nonces table
CREATE TABLE auth_nonces (
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (address, nonce)
);

-- Index for cleanup queries
CREATE INDEX idx_auth_nonces_created_at ON auth_nonces (created_at);

-- Migration: Create refresh_tokens table
CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(token)
);

-- Indexes for lookups
CREATE INDEX idx_refresh_tokens_address ON refresh_tokens (address);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens (expires_at);
```

**Background Cleanup:**

Expired nonces and refresh tokens must be periodically removed. Use a background job:

```typescript
// packages/api/src/workers/cleanup.ts
import { db } from '../db'

// Run every 5 minutes
setInterval(async () => {
  // Clean up expired nonces (> 5 minutes old)
  const deletedNonces = await db.authNonce.deleteMany({
    where: {
      createdAt: {
        lt: new Date(Date.now() - 5 * 60 * 1000)
      }
    }
  })

  // Clean up expired refresh tokens
  const deletedTokens = await db.refreshToken.deleteMany({
    where: {
      expiresAt: {
        lt: new Date()
      }
    }
  })

  console.log(`Cleaned up ${deletedNonces.count} nonces, ${deletedTokens.count} refresh tokens`)
}, 5 * 60 * 1000)
```

**Challenge Generation:**

```typescript
// api/routers/auth.ts
export const authRouter = router({
  getChallenge: publicProcedure
    .input(z.object({ address: z.string() }))
    .query(async ({ input, ctx }) => {
      const nonce = crypto.randomUUID()
      const timestamp = new Date().toISOString()

      // Store nonce in PostgreSQL
      await ctx.db.authNonce.create({
        data: {
          address: input.address,
          nonce,
          createdAt: new Date(),
        },
      })

      const message = `Sign in to Suiftly\nNonce: ${nonce}\nTimestamp: ${timestamp}`

      return { nonce, message, timestamp }
    }),
})
```

**Signature Verification:**

```typescript
export const authRouter = router({
  verify: publicProcedure
    .input(z.object({
      address: z.string(),
      signature: z.string(),
      nonce: z.string(),
      timestamp: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      // 1. Verify nonce is valid and not expired
      const storedNonce = await ctx.db.authNonce.findUnique({
        where: {
          address_nonce: {
            address: input.address,
            nonce: input.nonce,
          },
        },
      })

      if (!storedNonce) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired nonce',
        })
      }

      // Check nonce age
      if (Date.now() - storedNonce.createdAt.getTime() > 5 * 60 * 1000) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Nonce expired',
        })
      }

      // 2. Verify timestamp is recent (within 5 minutes)
      const messageTime = new Date(input.timestamp).getTime()
      const now = Date.now()
      if (Math.abs(now - messageTime) > 5 * 60 * 1000) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Challenge expired',
        })
      }

      // 3. Verify signature
      const message = `Sign in to Suiftly\nNonce: ${input.nonce}\nTimestamp: ${input.timestamp}`
      const isValid = await verifySuiSignature(
        input.address,
        message,
        input.signature
      )

      if (!isValid) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid signature',
        })
      }

      // 4. Delete nonce (one-time use)
      await ctx.db.authNonce.delete({
        where: {
          address_nonce: {
            address: input.address,
            nonce: input.nonce,
          },
        },
      })

      // 5. Generate access token (short-lived)
      const accessToken = jsonwebtoken.sign(
        {
          address: input.address,
          type: 'access',
        },
        process.env.JWT_SECRET!,
        {
          expiresIn: '15m', // 15 minutes
        }
      )

      // 6. Generate refresh token (long-lived)
      const refreshToken = jsonwebtoken.sign(
        {
          address: input.address,
          type: 'refresh',
        },
        process.env.JWT_SECRET!,
        {
          expiresIn: '30d', // 30 days
        }
      )

      // 7. Store refresh token in database
      await ctx.db.refreshToken.create({
        data: {
          address: input.address,
          token: refreshToken,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      })

      // 8. Set httpOnly cookies
      ctx.res.cookie('suiftly_access', accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000, // 15 minutes
      })

      ctx.res.cookie('suiftly_refresh', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      })

      return { success: true }
    }),
})
```

**Refresh Token Endpoint:**

```typescript
export const authRouter = router({
  refresh: publicProcedure
    .mutation(async ({ ctx }) => {
      const refreshToken = ctx.req.cookies.suiftly_refresh

      if (!refreshToken) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'No refresh token',
        })
      }

      // 1. Verify refresh token
      let decoded: { address: string; type: string }
      try {
        decoded = jsonwebtoken.verify(refreshToken, process.env.JWT_SECRET!) as {
          address: string
          type: string
        }
      } catch (error) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Invalid refresh token',
        })
      }

      // 2. Check if refresh token exists in database (not revoked)
      const storedToken = await ctx.db.refreshToken.findFirst({
        where: {
          address: decoded.address,
          token: refreshToken,
          expiresAt: {
            gt: new Date(),
          },
        },
      })

      if (!storedToken) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Refresh token revoked or expired',
        })
      }

      // 3. Generate new access token
      const accessToken = jsonwebtoken.sign(
        {
          address: decoded.address,
          type: 'access',
        },
        process.env.JWT_SECRET!,
        {
          expiresIn: '15m',
        }
      )

      // 4. Set new access token cookie
      ctx.res.cookie('suiftly_access', accessToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000,
      })

      return { success: true }
    }),
})
```

**Protected Procedure Middleware:**

```typescript
// api/middleware/auth.ts
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const accessToken = ctx.req.cookies.suiftly_access

  if (!accessToken) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Not authenticated',
    })
  }

  try {
    const decoded = jsonwebtoken.verify(accessToken, process.env.JWT_SECRET!) as {
      address: string
      type: string
    }

    // Verify it's an access token (not refresh)
    if (decoded.type !== 'access') {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Invalid token type',
      })
    }

    // Add user to context
    return next({
      ctx: {
        ...ctx,
        user: {
          address: decoded.address,
        },
      },
    })
  } catch (error) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired session',
    })
  }
})
```

**Protected Endpoint Example:**

```typescript
export const userRouter = router({
  getAPIKeys: protectedProcedure
    .query(async ({ ctx }) => {
      // ctx.user.address is available from middleware
      const keys = await ctx.db.apiKey.findMany({
        where: {
          ownerAddress: ctx.user.address,
        },
      })

      return keys
    }),
})
```

---

## Session Management

### Token Storage: httpOnly Cookies

**Why httpOnly cookie over localStorage:**
- ✅ XSS-resistant (JavaScript cannot access)
- ✅ Automatically sent with requests
- ✅ Secure flag (HTTPS only)
- ✅ SameSite protection (CSRF mitigation)

**Cookie Configuration:**
```typescript
// Access Token Cookie
{
  name: 'suiftly_access',
  httpOnly: true,       // No JavaScript access
  secure: true,         // HTTPS only
  sameSite: 'strict',   // Prevent CSRF
  maxAge: 15 * 60 * 1000, // 15 minutes
  path: '/',
  domain: 'app.suiftly.io'
}

// Refresh Token Cookie
{
  name: 'suiftly_refresh',
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: '/',
  domain: 'app.suiftly.io'
}
```

**Development Fallback (sessionStorage):**
If cookies are unavailable in dev (e.g., localhost with CORS), use sessionStorage:
```typescript
if (!ctx.res.cookie) {
  // Dev only: return tokens in response
  // Frontend stores in sessionStorage (NOT localStorage)
  return {
    success: true,
    accessToken,
    refreshToken
  }
}
```

### Token Lifecycle & User Experience

**Two-Token System:**

| Token Type | Duration | Purpose | Storage | Performance |
|------------|----------|---------|---------|-------------|
| **Access Token** | 15 minutes | All API requests | httpOnly cookie | ✅ Zero DB queries (stateless JWT) |
| **Refresh Token** | 30 days | Get new access tokens | httpOnly cookie + DB | ⚠️ One DB query per refresh (every 15 min max) |

**Why This Design:**
- **Security**: Short access token (15 min) limits damage if stolen
- **UX**: Long refresh token (30 days) means user signs once per month
- **Performance**: 99% of API calls have zero DB overhead (stateless JWT verification)
- **Control**: Refresh tokens stored in DB for revocation capability (logout, security)

**Automatic Refresh (Transparent to User):**

```typescript
// lib/trpc.ts - tRPC client configuration
import { httpBatchLink } from '@trpc/client'

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      credentials: 'include', // Send cookies

      // Intercept 401 errors and auto-refresh
      async fetch(url, options) {
        let response = await fetch(url, options)

        // If access token expired, refresh it
        if (response.status === 401) {
          const refreshed = await fetch('/api/trpc/auth.refresh', {
            method: 'POST',
            credentials: 'include',
          })

          if (refreshed.ok) {
            // Retry original request with new access token
            response = await fetch(url, options)
          } else {
            // Refresh token also expired - redirect to sign in
            window.location.href = '/signin?expired=true'
          }
        }

        return response
      },
    }),
  ],
})
```

**User Journey Examples:**

*First Visit (New User):*
```
1. Visit app.suiftly.io → Browse freely (no auth wall)
2. Click "My API Keys" → "Connect Wallet Required" modal
3. Connect + Sign → Tokens issued (access: 15 min, refresh: 30 days)
4. Browse dashboard → All API calls work (using access token)
```

*Returning User (Within 30 Days):*
```
1. Visit app.suiftly.io → Wallet auto-connects (dApp Kit)
2. Click "My API Keys" → Access token expired → Auto-refresh (transparent) → Page loads
3. Browse dashboard → User never noticed the refresh
```

*Returning User (After 30 Days):*
```
1. Visit app.suiftly.io → Wallet auto-connects
2. Click "My API Keys" → "Session expired. Please sign to continue."
3. Sign wallet → New 30-day tokens issued
4. Browse dashboard → Works for next 30 days
```

**Pattern: Sign once per month** (or less if visiting infrequently)

### Session Invalidation

**Manual Disconnect:**
```typescript
// Frontend
async function disconnectWallet() {
  // 1. Call logout endpoint (revokes refresh token)
  await api.auth.logout.mutate()

  // 2. Wallet kit handles disconnection
  wallet.disconnect()

  // 3. Redirect to home
  router.push('/')
}

// Backend
export const authRouter = router({
  logout: protectedProcedure
    .mutation(async ({ ctx }) => {
      const refreshToken = ctx.req.cookies.suiftly_refresh

      // 1. Revoke refresh token in database
      if (refreshToken) {
        await ctx.db.refreshToken.deleteMany({
          where: {
            address: ctx.user.address,
            token: refreshToken,
          },
        })
      }

      // 2. Clear cookies
      ctx.res.clearCookie('suiftly_access')
      ctx.res.clearCookie('suiftly_refresh')

      return { success: true }
    }),
})
```

**Token Expiry:**
- Access token expires (15 min) → Automatic refresh (transparent to user)
- Refresh token expires (30 days) → API returns 401 → Frontend shows: "Session expired. Please sign in again."
- User signs wallet → New 30-day session begins

---

## Authorization Model

**Single-User per Wallet:**
- All resources (API keys, services, billing) tied to wallet address
- One wallet = one account
- Wallet address is the primary key for user data

---

## Security Considerations

### Threats and Mitigations

| Threat | Mitigation |
|--------|-----------|
| **XSS attacks steal tokens** | httpOnly cookie (JS cannot access) |
| **Token replay attacks** | Nonce (one-time use), short access token (15 min) |
| **Refresh token theft** | Stored in DB (can revoke), httpOnly cookie, HTTPS only |
| **Token theft** | HTTPS only, Secure flag, SameSite=Strict |
| **Man-in-the-middle** | HTTPS everywhere, HSTS headers |
| **Address spoofing** | Signature verification on every auth |
| **Nonce reuse** | One-time use, auto-expiry (5 min) |
| **Refresh token abuse** | Rate limiting, audit logging, DB revocation |

### Best Practices

1. **Never trust the client:** Always validate JWT server-side
2. **Principle of least privilege:** JWT grants read access; transactions need signatures
3. **Audit everything:** Log all API key access with timestamp, IP, user agent
4. **Rate limiting:** Prevent brute force and scraping
5. **Encryption at rest:** API keys encrypted in database

---

## Comparison: Suiftly vs. DeFi

| Aspect | DeFi (Scallop, Navi) | Suiftly |
|--------|---------------------|---------|
| **Data location** | On-chain (public) | Off-chain database (private) |
| **Data sensitivity** | Public positions | Secret API keys |
| **Authorization** | Smart contracts | Backend server |
| **Backend auth** | None (just wallet connection) | JWT verification required |
| **Spoofing risk** | Low (data is public) | HIGH (must protect secrets) |
| **Session** | localStorage (last wallet) | JWT in httpOnly cookie |
| **Re-signing** | Never (for reads) | On first protected access |

**Why the difference?**
- DeFi data is already public on blockchain
- Suiftly secrets are off-chain and MUST stay private
- Therefore: Cryptographic proof of wallet ownership is mandatory

---

## Development Mock

```typescript
// For development only (no real wallet needed)
if (import.meta.env.DEV) {
  // Mock wallet provider
  const mockWallet = {
    address: '0xMOCK123...',
    signMessage: async (msg: string) => {
      return 'mock_signature_' + msg.slice(0, 10)
    }
  }

  // Backend skips signature verification
  if (input.address.startsWith('0xMOCK')) {
    // Issue JWT without verifying signature
    const jwt = generateMockJWT(input.address)
    ctx.res.cookie('suiftly_session', jwt, { ... })
    return { success: true }
  }
}
```

---

## Implementation Checklist

### Frontend
- [ ] Install `@mysten/dapp-kit` and configure WalletProvider
- [ ] Build wallet connection UI (header widget)
- [ ] Implement challenge-response flow
- [ ] Implement automatic token refresh on 401 errors
- [ ] Handle refresh token expiry (redirect + toast: "Session expired")
- [ ] Remove session expiration warning (no longer needed with auto-refresh)
- [ ] Build disconnect wallet flow
- [ ] Mock wallet for development

### Backend
- [ ] Install `jsonwebtoken` and Sui signature verification library
- [ ] Create database migrations:
  - [ ] `auth_nonces` table
  - [ ] `refresh_tokens` table
- [ ] Create `authRouter` with endpoints:
  - [ ] `getChallenge` - Generate nonce
  - [ ] `verify` - Verify signature, issue tokens
  - [ ] `refresh` - Exchange refresh token for new access token
  - [ ] `logout` - Revoke refresh token
- [ ] Implement background cleanup job for expired nonces and tokens
- [ ] Implement `protectedProcedure` middleware (validates access token)
- [ ] Configure cookie settings (httpOnly, Secure, SameSite) for both tokens
- [ ] Rate limit auth attempts (prevent brute force and refresh abuse)
- [ ] Mock auth bypass for development

### Security
- [ ] Environment variable for JWT_SECRET (see Secret Management below)
- [ ] HTTPS enforced in production
- [ ] HSTS headers configured
- [ ] Rate limiting on auth endpoints (including refresh endpoint)
- [ ] Audit logging for all auth events
- [ ] Monitor for suspicious patterns (rapid nonce requests, refresh abuse)

### Testing
- [ ] Test wallet connection flow
- [ ] Test challenge-response with real Sui wallet
- [ ] Test access token expiry and automatic refresh
- [ ] Test refresh token expiry (30 days)
- [ ] Test 401 handling when refresh token also expired
- [ ] Test nonce reuse prevention
- [ ] Test signature verification failure
- [ ] Test disconnect flow (revoke refresh token)
- [ ] Test concurrent refresh requests (race conditions)
- [ ] Load test auth and refresh endpoints

---

## Secret Management

### JWT Signing Key

The JWT signing secret is stored in a `.env` file in the home directory of the user running the API server process.

**File Location:**
```bash
# Production (API servers run as 'apiservers' user)
/home/apiservers/.env

# Development (runs as developer user, e.g., 'olet')
/home/olet/.env
```

**File Permissions:**
```bash
# Must be readable only by the owner
chmod 600 ~/.env
chown apiservers:apiservers ~/.env  # Production only
```

**File Contents:**
```bash
# ~/.env
JWT_SECRET=<generated-secret-here>
DB_ENCRYPTION_KEY=<generated-secret-here>
```

**Note:** `DB_ENCRYPTION_KEY` is used for application-level encryption of secrets in the database (API keys, Seal keys, refresh tokens). See [ARCHITECTURE.md - Database Security](./ARCHITECTURE.md#database-security) for details.

**Generating Secure Secrets:**
```bash
# Generate 256-bit random secrets (base64-encoded)
# For JWT signing
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# For database encryption
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Or using openssl
openssl rand -base64 32  # JWT_SECRET
openssl rand -base64 32  # DB_ENCRYPTION_KEY
```

**Important Security Notes:**
- ✅ Never commit `.env` files to git (add to `.gitignore`)
- ✅ Use different secrets for production and development
- ✅ Both API server instances (for HA) read the same `/home/apiservers/.env` file
- ✅ Both secrets should be at least 32 bytes (256 bits)
- ⚠️ If JWT_SECRET compromised, all existing JWTs become invalid when rotated
- ⚠️ If DB_ENCRYPTION_KEY compromised, all encrypted secrets must be re-encrypted
- ⚠️ Rotating JWT_SECRET will log out all users (they'll need to re-authenticate)

**Loading in Application:**
```typescript
// packages/api/src/config.ts
import * as dotenv from 'dotenv'
import * as os from 'os'
import * as path from 'path'

// Load from home directory
dotenv.config({ path: path.join(os.homedir(), '.env') })

if (!process.env.JWT_SECRET || !process.env.DB_ENCRYPTION_KEY) {
  throw new Error('Required secrets not found in ~/.env')
}

export const config = {
  jwtSecret: process.env.JWT_SECRET,
  dbEncryptionKey: process.env.DB_ENCRYPTION_KEY,
  // ... other config
}
```

**Setup Instructions:**

*Production:*
```bash
# As root or sudo user
sudo -u apiservers bash
cd ~
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env
echo "DB_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
chmod 600 .env
cat .env  # Verify both secrets were created
exit
```

*Development:*
```bash
# As your developer user
cd ~
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env
echo "DB_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
chmod 600 .env
```

---

## Future Enhancements

**Not in MVP, consider later:**

1. **Refresh Tokens:**
   - Long-lived refresh token (30 days)
   - Short-lived access token (1 hour)
   - Auto-refresh without user interaction

2. **Session Keys (Wallet-Level):**
   - User delegates signing authority to ephemeral key
   - No popups for period (e.g., 24 hours)
   - Requires wallet support (emerging standard)

3. **zkLogin (OAuth Integration):**
   - Sign in with Google/Twitter
   - Zero-knowledge proof links OAuth to wallet
   - Better UX for non-crypto users
   - More complex implementation

4. **Multi-Device Sessions:**
   - View active sessions from all devices
   - Revoke specific sessions remotely
   - Push notifications for new sessions

5. **Hardware Wallet Support:**
   - Ledger/Trezor integration
   - Enhanced security for high-value accounts

6. **Team/Organization Management:**
   - Multiple wallets per organization
   - Role-based access control (admin, member, billing)
   - Wallet linking with signatures

---

## Summary

**Authentication Architecture:**
- Wallet connection via `@mysten/dapp-kit` (auto-reconnects)
- Challenge-response signature for proof of ownership
- Two-token system:
  - **Access token** (15 min, httpOnly cookie) - Used for API requests, stateless JWT
  - **Refresh token** (30 days, httpOnly cookie) - Used to get new access tokens, stored in DB
- No backend auth in DeFi (data is public), but required for Suiftly (secrets)

**User Experience:**
- First access: One signature to authenticate → tokens valid for 30 days
- Subsequent requests: No signatures (access token automatically refreshes)
- Transactions: Wallet signature required (blockchain)
- Session expires: Sign again after 30 days (or sooner if manually logged out)

**Security:**
- httpOnly cookies (XSS-resistant)
- Signature verification (prevents spoofing)
- Short access token (15 min limits damage if stolen)
- Long refresh token (30 days, but revocable via database)
- Rate limiting (prevents brute force and refresh abuse)
- Audit logging (accountability)

**Implementation:**
- Frontend: dApp Kit + tRPC client with automatic token refresh
- Backend: Challenge generation + token issuance + refresh endpoint + protected middleware
- Database: Nonces (temporary) + refresh tokens (revocable)
- Development: Mock wallet + auth bypass

**What's stored:**
- ✅ Nonces (temporary, 5 min) - For challenge-response across multiple servers
- ✅ Refresh tokens (30 days, encrypted) - For revocation capability
- ❌ Access tokens - NOT stored, stateless JWT verification

**Database encryption:**
- ✅ Refresh tokens encrypted with AES-256-GCM before storage
- ✅ Master key in `~/.env` (separate from database)
- ✅ DB backups contain only ciphertext (safe from compromise)
- See [ARCHITECTURE.md - Database Security](./ARCHITECTURE.md#database-security) for complete details

This gives us the best of both worlds: Web3 security (cryptographic proof) + Web2 convenience (minimal signatures, auto-refresh) + defense-in-depth (encrypted secrets).
