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
     │ 1. User visits /login and clicks wallet option      │
     ├────────────────────────────────────────────────────>│
     │                           │                         │
     │ 2. Wallet prompts: "Connect to app.suiftly.io?"     │
     │<────────────────────────────────────────────────────┤
     │                           │                         │
     │ 3. User approves connection                         │
     │────────────────────────────────────────────────────>│
     │                           │                         │
     │ 4. dApp Kit stores "last wallet" in localStorage    │
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
     │ 10. Set httpOnly cookie with JWT (4-hour expiry)    │
     │<──────────────────────────┤                         │
     │                           │                         │
     │ [User is authenticated]   │                         │
```

### Subsequent API Calls (No Wallet Interaction)

```
┌──────────┐                 ┌──────────┐
│  Browser │                 │   API    │
│   (SPA)  │                 │ Backend  │
└────┬─────┘                 └────┬─────┘
     │                            │
     │ API call (cookie auto-sent)│
     ├───────────────────────────>│
     │                            │
     │     [Validate JWT]         │
     │     [Authorize access]     │
     │                            │
     │  Return protected data     │
     │<───────────────────────────┤
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
     │  [Wallet popup: "Deposit 40.82 SUI?" → Approve]     │
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

### Frontend Components

**Implementation files:**
- **Login Page:** [apps/webapp/src/routes/login.tsx](../apps/webapp/src/routes/login.tsx)
- **Auth Service:** [apps/webapp/src/lib/auth.ts](../apps/webapp/src/lib/auth.ts)
- **Auth Store:** [apps/webapp/src/stores/auth.ts](../apps/webapp/src/stores/auth.ts)
- **Wallet Provider:** [apps/webapp/src/components/wallet/WalletProvider.tsx](../apps/webapp/src/components/wallet/WalletProvider.tsx)
- **Wallet Widget:** [apps/webapp/src/components/wallet/WalletWidget.tsx](../apps/webapp/src/components/wallet/WalletWidget.tsx)
- **Mock Wallet:** [apps/webapp/src/lib/mockWallet.ts](../apps/webapp/src/lib/mockWallet.ts)

**Login Page Features:**
- Displays wallet connection options directly (no modal)
- Mock wallet only visible in development mode
- Automatic authentication flow after wallet connection
- Redirects to `/dashboard` after successful auth

**Auth Service Features:**
- Idempotent login/logout operations
- Operation locking (prevents concurrent auth operations)
- Challenge-response signature flow
- Supports both real and mock wallets
- **TODO:** Automatic token refresh (backend ready, frontend not yet implemented)

**Wallet Widget Features:**
- Rendered in header on authenticated pages
- Shows truncated wallet address with MOCK badge (if applicable)
- Dropdown menu: Billing, Copy Address, Disconnect
- Disconnect clears session and redirects to `/login`

### Frontend Authentication Flow

**See [apps/webapp/src/lib/auth.ts](../apps/webapp/src/lib/auth.ts) for complete implementation.**

**Challenge-Response Flow:**
1. Request nonce from backend (`auth.connectWallet`)
2. Sign challenge message with wallet
3. Submit signature to backend (`auth.verifySignature`)
4. Backend issues access token (returned in response) + refresh token (httpOnly cookie)
5. Frontend stores access token in auth store (localStorage)
6. **TODO:** Automatic token refresh on 401 errors (not yet implemented)

**Key Implementation Details:**
- WalletProvider wraps entire app (auto-reconnect on reload)
- `useAuth()` hook provides `login()` and `logout()` functions
- tRPC client configured with `credentials: 'include'` (sends refresh token cookie automatically)
- Mock wallet support for development (no real signatures needed)
- **Current limitation:** Access token expires after 15 min, no automatic refresh yet (user must re-login)

### Backend (API with tRPC)

**Implementation:** ✅ **COMPLETE** - See [apps/api/src/routes/auth.ts](../apps/api/src/routes/auth.ts)

**Database schema:** ✅ **IMPLEMENTED** - See [packages/database/src/schema/auth.ts](../packages/database/src/schema/auth.ts)

**Database Storage: PostgreSQL**

Two things must be stored in PostgreSQL to support multiple API servers:

1. **Nonces** (temporary) - Challenge-response nonces must be shared across servers. If User requests a challenge from Server A but submits the signature to Server B (load balanced), Server B needs to verify the nonce. In-memory storage would cause random auth failures.

2. **Refresh tokens** (long-lived) - Must be stored to enable revocation (logout, compromised token, etc.). JWTs are stateless and can't be revoked once issued, so we store refresh tokens in the database to control their validity.

Note: **Access tokens are NOT stored** - they're stateless JWTs verified using only the signing key. This is the standard JWT benefit!

**Database Schema:**

Tables to be created via Drizzle migrations:

- **`auth_nonces`** - Temporary challenge nonces
  - `address` (TEXT, part of composite primary key)
  - `nonce` (TEXT, part of composite primary key)
  - `created_at` (TIMESTAMP, indexed for cleanup)
  - TTL: 5 minutes

- **`refresh_tokens`** - Long-lived revocable tokens
  - `id` (SERIAL PRIMARY KEY)
  - `address` (TEXT, indexed)
  - `token` (TEXT, unique, encrypted)
  - `expires_at` (TIMESTAMP, indexed)
  - `created_at` (TIMESTAMP)
  - TTL: 30 days

**Required Backend Endpoints:**

**Background Cleanup Job:**
- Runs every 5 minutes
- Deletes nonces older than 5 minutes
- Deletes refresh tokens past expiry date

**Auth Router (`auth.getChallenge`):**
- Input: `{ address: string }`
- Generate random nonce (UUID)
- Generate timestamp (ISO 8601)
- Store nonce in database with address
- Return: `{ nonce, message, timestamp }`
- Message format: `"Sign in to Suiftly\nNonce: {nonce}\nTimestamp: {timestamp}"`

**Auth Router (`auth.verify`):**
- Input: `{ address, signature, nonce, timestamp }`
- Verify nonce exists and not expired (< 5 min)
- Verify timestamp is recent (< 5 min)
- Verify Sui signature using `@mysten/sui.js`
- Delete nonce (one-time use)
- Generate access token JWT (15 min expiry)
- Generate refresh token JWT (30 day expiry)
- Store encrypted refresh token in database
- Set httpOnly cookies for both tokens
- Return: `{ success: true }`

**Auth Router (`auth.refresh`):**
- Extract refresh token from cookie
- Verify JWT signature
- Check token exists in database (not revoked)
- Check token not expired
- Generate new access token JWT (15 min expiry)
- Set new access token cookie
- Return: `{ success: true }`

**Auth Router (`auth.logout`):**
- Extract refresh token from cookie
- Delete refresh token from database
- Clear both cookies
- Return: `{ success: true }`

**Protected Procedure Middleware:**
- Extract access token from cookie
- Verify JWT signature
- Verify token type is "access" (not "refresh")
- Add `user: { address }` to context
- Throw 401 if invalid or expired

**Protected Endpoints:**
- Use `protectedProcedure` instead of `publicProcedure`
- Access `ctx.user.address` for authenticated user
- Example: `userRouter.getAPIKeys` queries by `ctx.user.address`

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
1. Visit app.suiftly.io → Redirect to /login
2. Click wallet option (e.g., "Sui Wallet" or "Connect Mock Wallet")
3. Wallet prompts connection → User approves → Sign challenge
4. Tokens issued (access: 15 min, refresh: 30 days) → Redirect to /dashboard
5. Browse dashboard → All API calls work (using access token)
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
// Frontend - WalletWidget component
async function handleDisconnect() {
  // 1. Call logout endpoint (revokes refresh token)
  await logout()

  // 2. Wallet kit handles disconnection
  if (isMock) {
    disconnectMockWallet()
  } else {
    disconnect()
  }

  // 3. Redirect to login page
  navigate({ to: '/login' })
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

## Frontend Route Guards

### Overview

All routes in this application require authentication by default. This is a **fail-secure** design that prevents accidental exposure of protected content.

### Global Auth Guard

The root route ([apps/webapp/src/routes/__root.tsx](../apps/webapp/src/routes/__root.tsx)) implements a global `beforeLoad` guard that:

1. Checks if the requested route is in the `PUBLIC_ROUTES` allowlist
2. If public, allows access
3. If not public, checks authentication status
4. Redirects to `/login` if not authenticated

```typescript
const PUBLIC_ROUTES = new Set([
  '/',       // Index route - handles its own auth check and redirects
  '/login',  // Login page
]);
```

### Why This is Secure

**Fail-Secure by Default:**
- New routes are automatically protected
- Developers must explicitly add routes to `PUBLIC_ROUTES` to make them public
- This prevents the "forgot to add auth guard" error

**Single Source of Truth:**
- All auth logic is centralized in `__root.tsx`
- No need to remember to add `beforeLoad` to each route
- Easy to audit (just check `PUBLIC_ROUTES`)

### Adding New Routes

**Protected Routes (Default)**

Simply create your route file - it's automatically protected:

```typescript
// apps/webapp/src/routes/my-new-page.tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/my-new-page')({
  component: MyNewPage,
});
```

**No auth guard needed!** The global guard handles it.

**Public Routes (Rare)**

If you need a route accessible without authentication:

1. **Add to PUBLIC_ROUTES** in `__root.tsx`:
   ```typescript
   const PUBLIC_ROUTES = new Set([
     '/',
     '/login',
     '/my-public-page',  // Your new public route
   ]);
   ```

2. **Document why it's public** with a comment
3. **Get security review** before merging

### Common Patterns

**Index Route (/)**

The `/` route is special - it's in `PUBLIC_ROUTES` but handles its own auth logic:
- If authenticated → redirects to `/dashboard`
- If not authenticated → redirects to `/login`

This allows `/` to be the entry point while still enforcing auth.

**Lazy Routes**

Lazy-loaded routes (`.lazy.tsx`) are also protected:

```typescript
// routes/my-page.tsx (route definition)
export const Route = createFileRoute('/my-page')({
  component: () => null,
});

// routes/my-page.lazy.tsx (component implementation)
export const Route = createLazyFileRoute('/my-page')({
  component: MyPageComponent,
});
```

The auth guard runs before lazy loading, so unauthorized users never download the component code.

### Testing Route Security

**Manual Testing:**
1. Open browser in incognito mode
2. Clear localStorage: `localStorage.clear()`
3. Try to access protected routes - should redirect to `/login`
4. Try to access public routes - should load

**Automated Testing:**

We have E2E tests that verify route security:

```bash
npx playwright test auth.spec.ts --project=chromium
```

### Security Checklist

When adding/modifying routes:

- [ ] Is this route supposed to be public? (99% should say NO)
- [ ] If public, is it in `PUBLIC_ROUTES`?
- [ ] If public, is there a security-reviewed reason?
- [ ] Does the route handle sensitive data? (Add additional checks if needed)
- [ ] Have you tested unauthorized access?

### Troubleshooting

**"Stuck in redirect loop"**

If you see infinite redirects:
- Check if `/login` is in `PUBLIC_ROUTES`
- Check if `/` index route is in `PUBLIC_ROUTES`
- Look for routes that redirect to themselves

**"Route not protected"**

If a route loads without auth:
- Check if it's accidentally in `PUBLIC_ROUTES`
- Verify `__root.tsx` global guard is active
- Check browser console for auth errors

**"401 Unauthorized" on page load**

This is expected behavior - the page should redirect to `/login`. If it doesn't:
- Check that `__root.tsx` guard is properly configured
- Verify `useAuthStore` is working correctly
- Check browser console for errors

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

**Implementation:** See [apps/webapp/src/lib/mockWallet.ts](../apps/webapp/src/lib/mockWallet.ts)

**Frontend:**
- Mock wallet provider with fake address and signature
- Enabled only when `import.meta.env.DEV === true`
- Shown on login page alongside real wallet options
- Auto-connects as test user (no browser extension needed)

**Backend (when implemented):**
- Skip signature verification for addresses starting with `0xMOCK` or when `MOCK_AUTH=true` env variable set
- Issue JWT without cryptographic verification
- Enables rapid development and testing without real wallets

---

## Implementation Checklist

### Frontend ⚠️ (Mostly Complete - Refresh Logic Missing)
- [x] Install `@mysten/dapp-kit` and configure WalletProvider → [WalletProvider.tsx](../apps/webapp/src/components/wallet/WalletProvider.tsx)
- [x] Build login page with wallet options (no modal) → [login.tsx](../apps/webapp/src/routes/login.tsx)
- [x] Build WalletWidget component for authenticated pages (header) → [WalletWidget.tsx](../apps/webapp/src/components/wallet/WalletWidget.tsx)
- [x] Implement challenge-response flow → [auth.ts](../apps/webapp/src/lib/auth.ts)
- [x] Build disconnect wallet flow (redirects to /login) → [auth.ts](../apps/webapp/src/lib/auth.ts)
- [x] Mock wallet for development (shown on login page in DEV mode) → [mockWallet.ts](../apps/webapp/src/lib/mockWallet.ts)
- [ ] **TODO:** Implement automatic token refresh on 401 errors (backend `auth.refresh` endpoint exists but frontend doesn't call it yet)
- [ ] **TODO:** Intercept 401 responses, call `auth.refresh`, retry original request
- [ ] **TODO:** Access token stored in localStorage (should migrate to memory-only or sessionStorage for better security)

### Backend ✅ (Complete)
- [x] Install `jsonwebtoken` and Sui signature verification library → [package.json](../apps/api/package.json)
- [x] Create database migrations → [schema/auth.ts](../packages/database/src/schema/auth.ts):
  - [x] `auth_nonces` table
  - [x] `refresh_tokens` table
- [x] Create `authRouter` with endpoints → [routes/auth.ts](../apps/api/src/routes/auth.ts):
  - [x] `connectWallet` - Generate nonce (lines 23-88)
  - [x] `verifySignature` - Verify signature, issue tokens (lines 93-225)
  - [x] `refresh` - Exchange refresh token for new access token (lines 230-281)
  - [x] `logout` - Revoke refresh token (lines 286-301)
- [x] Refresh token stored as SHA-256 hash in database (line 203)
- [x] Refresh token sent as httpOnly cookie (lines 211-217)
- [x] Mock auth bypass for development (MOCK_AUTH env variable, line 119)
- [ ] Implement background cleanup job for expired nonces and tokens (TODO)
- [ ] Implement `protectedProcedure` middleware (validates access token) (TODO)
- [ ] Rate limit auth attempts (prevent brute force and refresh abuse) (TODO)

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

**This section describes JWT_SECRET management for authentication.**

**For comprehensive secret management (all secrets including JWT_SECRET and DB_APP_FIELDS_ENCRYPTION_KEY), see [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md).**

### JWT Signing Key

The JWT signing secret is stored in a `~/.suiftly.env` file in the home directory of the user running the API server process.

**File Location:**
```bash
# All environments (production, development, test)
~/.suiftly.env

# Environment is determined by /etc/mhaxbe/system.conf (not by user account)
# Same user runs both production and development systems
# Each system has its own ~/.suiftly.env with appropriate secrets
```

**File Permissions:**
```bash
# Must be readable only by the owner (same for all environments)
chmod 600 ~/.suiftly.env
```

**File Contents:**
```bash
# ~/.suiftly.env
JWT_SECRET=<generated-secret-here>
DB_APP_FIELDS_ENCRYPTION_KEY=<generated-secret-here>
```

**Note:** `DB_APP_FIELDS_ENCRYPTION_KEY` is used for application-level encryption of secrets in the database (API keys, Seal keys, refresh tokens). See [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md) for complete details on secret management and database encryption.

**Generating Secure Secrets:**
```bash
# Generate 256-bit random secrets (base64-encoded)
# For JWT signing
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# For database encryption
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Or using openssl
openssl rand -base64 32  # JWT_SECRET
openssl rand -base64 32  # DB_APP_FIELDS_ENCRYPTION_KEY
```

**Important Security Notes:**
- ✅ Never commit `.env` files to git (add to `.gitignore`)
- ✅ Use different secrets for production and development systems
- ✅ Environment determined by `/etc/mhaxbe/system.conf` (not user account)
- ✅ Both secrets should be at least 32 bytes (256 bits)
- ⚠️ If JWT_SECRET compromised, all existing JWTs become invalid when rotated
- ⚠️ If DB_APP_FIELDS_ENCRYPTION_KEY compromised, all encrypted secrets must be re-encrypted
- ⚠️ Rotating JWT_SECRET will log out all users (they'll need to re-authenticate)

**See [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md) for:**
- Complete secret management procedures
- Environment isolation safeguards
- Key rotation procedures
- Backup security details

**Loading in Application:**
```typescript
// apps/api/src/lib/config.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Load from ~/.suiftly.env (not project .env to avoid Python venv conflicts)
const homeEnvPath = join(homedir(), '.suiftly.env');
if (existsSync(homeEnvPath)) {
  const envFile = readFileSync(homeEnvPath, 'utf-8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

if (!process.env.JWT_SECRET || !process.env.DB_APP_FIELDS_ENCRYPTION_KEY) {
  throw new Error('Required secrets not found in ~/.suiftly.env')
}

export const config = {
  jwtSecret: process.env.JWT_SECRET,
  dbAppFieldsEncryptionKey: process.env.DB_APP_FIELDS_ENCRYPTION_KEY,
  // ... other config
}
```

**Setup Instructions:**

```bash
# Same procedure for both production and development systems
cd ~
echo "JWT_SECRET=$(openssl rand -base64 32)" > ~/.suiftly.env
echo "DB_APP_FIELDS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> ~/.suiftly.env
chmod 600 ~/.suiftly.env
cat ~/.suiftly.env  # Verify both secrets were created
```

**Note:** Environment (production vs development) is determined by `/etc/mhaxbe/system.conf`, not by user account or secret values.

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
- Login page: Wallet options displayed directly (no modal)
- First access: Select wallet → One signature to authenticate → tokens valid for 30 days
- Subsequent requests: No signatures (access token automatically refreshes)
- Transactions: Wallet signature required (blockchain)
- Disconnect: Redirects to `/login`, clears session and tokens
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
- ✅ Master key in `~/.suiftly.env` (separate from database)
- ✅ DB backups contain only ciphertext (safe from compromise)
- See [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md) for complete details on database field encryption

This gives us the best of both worlds: Web3 security (cryptographic proof) + Web2 convenience (minimal signatures, auto-refresh) + defense-in-depth (encrypted secrets).
