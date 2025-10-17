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

**Nonce Storage: PostgreSQL**

Nonces are stored in PostgreSQL to support multiple API servers (required for pm2 rolling deploys and load balancing). Storing nonces in-memory would cause authentication to randomly fail when requests are load-balanced across different servers.

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
```

**Nonce Cleanup:**

Expired nonces (> 5 minutes old) must be periodically removed. Use a background job:

```typescript
// packages/api/src/workers/cleanup.ts
import { db } from '../db'

// Run every 5 minutes
setInterval(async () => {
  const deleted = await db.authNonce.deleteMany({
    where: {
      createdAt: {
        lt: new Date(Date.now() - 5 * 60 * 1000)
      }
    }
  })
  console.log(`Cleaned up ${deleted.count} expired nonces`)
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

      // 5. Generate JWT
      const jwt = jsonwebtoken.sign(
        {
          address: input.address,
          type: 'wallet-auth',
        },
        process.env.JWT_SECRET!,
        {
          expiresIn: '4h',
        }
      )

      // 6. Set httpOnly cookie
      ctx.res.cookie('suiftly_session', jwt, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 4 * 60 * 60 * 1000, // 4 hours
      })

      return { success: true }
    }),
})
```

**Protected Procedure Middleware:**

```typescript
// api/middleware/auth.ts
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const token = ctx.req.cookies.suiftly_session

  if (!token) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Not authenticated',
    })
  }

  try {
    const decoded = jsonwebtoken.verify(token, process.env.JWT_SECRET!) as {
      address: string
      type: string
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

### JWT Storage: httpOnly Cookie (Recommended)

**Why httpOnly cookie over localStorage:**
- ✅ XSS-resistant (JavaScript cannot access)
- ✅ Automatically sent with requests
- ✅ Secure flag (HTTPS only)
- ✅ SameSite protection (CSRF mitigation)

**Cookie Configuration:**
```typescript
{
  httpOnly: true,       // No JavaScript access
  secure: true,         // HTTPS only
  sameSite: 'strict',   // Prevent CSRF
  maxAge: 4 * 60 * 60 * 1000, // 4 hours
  path: '/',
  domain: 'app.suiftly.io'
}
```

**Development Fallback (sessionStorage):**
If cookies are unavailable in dev (e.g., localhost with CORS), use sessionStorage:
```typescript
if (!ctx.res.cookie) {
  // Dev only: return JWT in response
  // Frontend stores in sessionStorage (NOT localStorage)
  return { success: true, token: jwt }
}
```

### Session Duration: 4 Hours

**Rationale:**
- Long enough for typical work session
- Short enough to limit damage if JWT stolen
- User trades ~daily (will re-authenticate naturally)

**Refresh Strategy:**
- When JWT has < 30 min remaining, show subtle toast: "Session expiring soon. Please sign to continue."
- User signs new challenge → new JWT issued
- If user ignores → session expires → requires reconnection

**No Automatic Refresh Tokens:**
- Simplicity over complexity for MVP
- User must sign new challenge to extend session
- Future: Consider refresh tokens if users complain

### Session Invalidation

**Manual Disconnect:**
```typescript
// Frontend
async function disconnectWallet() {
  // 1. Call logout endpoint
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
      // Clear cookie
      ctx.res.clearCookie('suiftly_session')
      return { success: true }
    }),
})
```

**JWT Expiry:**
- API returns 401 Unauthorized
- Frontend clears local state
- Shows toast: "Session expired. Please reconnect your wallet."
- Redirects to home

---

## Authorization Model (MVP)

**Single-User per Wallet:**
- All resources (API keys, services, billing) tied to wallet address
- No teams/organizations in v1
- One wallet = one account

**Future: Organizations:**
- Wallet signs to create/join org
- Roles managed separately (admin, member, billing)
- Wallet still used for proof of identity

---

## Security Considerations

### Threats and Mitigations

| Threat | Mitigation |
|--------|-----------|
| **XSS attacks steal JWT** | httpOnly cookie (JS cannot access) |
| **JWT replay attacks** | Nonce (one-time use), short expiry (4h) |
| **Token theft** | HTTPS only, Secure flag, SameSite=Strict |
| **Man-in-the-middle** | HTTPS everywhere, HSTS headers |
| **Address spoofing** | Signature verification on every auth |
| **Nonce reuse** | One-time use, auto-expiry (5 min) |

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

## User Experience

### First Visit (New User)

```
1. Visit app.suiftly.io
   → Dashboard loads (no auth wall)
   → Can explore all pages freely

2. Click "My API Keys"
   → "Connect Wallet Required" modal appears
   → [Connect Wallet] or [Cancel]

3. Connect Wallet
   → Wallet popup: "Connect to app.suiftly.io?" → Approve
   → Immediately: "Sign in to Suiftly" message → Sign
   → Connected! Header shows address + balance
   → API Keys page loads

4. Browse dashboard
   → No more signatures needed for 4 hours
```

### Returning User

```
1. Visit app.suiftly.io
   → dApp Kit auto-connects wallet (localStorage)
   → But: JWT expired (> 4 hours)
   → Dashboard loads in "demo mode"

2. Click "My API Keys"
   → "Session expired. Please sign to continue."
   → Sign challenge → New JWT issued
   → API Keys page loads

3. Browse dashboard
   → All features work for 4 hours
```

### Active Trader (Daily Usage)

```
Day 1: Sign once → JWT valid 4 hours
Day 2: Return → JWT expired → Sign again → Valid 4 hours
Day 3: Make deposit → Sign transaction → Continue browsing
       (JWT still valid from earlier sign-in)

Pattern: Sign ~once per day (if browsing < 4 hours per session)
```

**Key insight:** This is **one more signature than pure DeFi** (which has no backend auth), but necessary to protect secrets.

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
- [ ] Handle JWT expiry (401 → redirect + toast)
- [ ] Add session expiration warning (< 30 min)
- [ ] Build disconnect wallet flow
- [ ] Mock wallet for development

### Backend
- [ ] Install `jsonwebtoken` and Sui signature verification library
- [ ] Create database migration for `auth_nonces` table
- [ ] Create `authRouter` with getChallenge + verify endpoints
- [ ] Implement background cleanup job for expired nonces
- [ ] Implement `protectedProcedure` middleware
- [ ] Configure cookie settings (httpOnly, Secure, SameSite)
- [ ] Add logout endpoint (clear cookie)
- [ ] Rate limit auth attempts (prevent brute force)
- [ ] Mock auth bypass for development

### Security
- [ ] Environment variable for JWT_SECRET (rotate regularly)
- [ ] HTTPS enforced in production
- [ ] HSTS headers configured
- [ ] Rate limiting on auth endpoints
- [ ] Audit logging for all auth events
- [ ] Monitor for suspicious patterns (rapid nonce requests)

### Testing
- [ ] Test wallet connection flow
- [ ] Test challenge-response with real Sui wallet
- [ ] Test JWT expiry and refresh
- [ ] Test 401 handling (expired/invalid JWT)
- [ ] Test nonce reuse prevention
- [ ] Test signature verification failure
- [ ] Test disconnect flow
- [ ] Load test auth endpoints

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
- JWT in httpOnly cookie for session management (4 hours)
- No backend auth in DeFi (data is public), but required for Suiftly (secrets)

**User Experience:**
- First access: One signature to authenticate
- Subsequent requests: No signatures (JWT handles it)
- Transactions: Wallet signature required (blockchain)
- Session expires: Sign again after 4 hours

**Security:**
- httpOnly cookies (XSS-resistant)
- Signature verification (prevents spoofing)
- Short expiry (4 hours limits damage)
- Rate limiting (prevents brute force)
- Audit logging (accountability)

**Implementation:**
- Frontend: dApp Kit + tRPC client
- Backend: Challenge generation + JWT issuance + protected middleware
- Development: Mock wallet + auth bypass

This gives us the best of both worlds: Web3 security (cryptographic proof) + Web2 convenience (no constant signatures).
