# System Constants - Single Source of Truth

**Purpose:** Define all system-wide hard-coded constants in ONE place to prevent documentation drift.

**Implementation:** All constants are defined in `packages/shared/src/constants/index.ts`

**All documentation and code MUST reference these values.**

**Note:** These are hard-coded system constraints and enums. For runtime-configurable business values (pricing, capacities, rates), see ConfigGlobal system in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 28-Day Spending Limits

**Model:** Rolling 28-day period from account creation (not calendar month)

| Constant | Value | Description |
|----------|-------|-------------|
| `SPENDING_LIMIT_DEFAULT_USD` | **$250** | Default 28-day spending authorization |
| `SPENDING_LIMIT_MINIMUM_USD` | **$10** | Minimum allowed spending limit |
| `SPENDING_LIMIT_MAXIMUM_USD` | **unlimited** | No maximum cap (customer can set any value ≥ $10) |
| `SPENDING_PERIOD_DAYS` | **28** | Period duration (28 days = 4 weeks) |

**Reset Behavior:**
- Resets automatically every 28 days from account creation
- Rolling period: Each user has independent cycle starting from their account creation timestamp
- Smart contract uses exact timestamp arithmetic (no drift): `28 × 86,400,000 milliseconds`
- Guarantees at most one monthly bill per period (Suiftly bills on 1st of each month)
- Off-chain database field `current_period_start_ms` tracks period start
- Field `current_period_charged_usd_cents` resets to 0 every 28 days

**Why 28 Days:**
- Ensures at most one monthly bill per limit period (months are 28-31 days)
- Simple arithmetic (no calendar math, no leap years, no drift)
- Similar to EU consumer protection periods (14-28 days)
- 28 days = exactly 4 weeks

**Implementation:**
```typescript
// packages/shared/src/constants/index.ts
export const SPENDING_LIMIT = {
  DEFAULT_USD: 250,
  MINIMUM_USD: 10,
  MAXIMUM_USD: null, // unlimited
  PERIOD_DAYS: 28,
  PERIOD_MS: 28 * 24 * 60 * 60 * 1000, // 2419200000 milliseconds
} as const;
```

---

## Customer Status Values

**Model:** Enum with 3 states (account-level status)

**Important:** Customer Status is distinct from Service States:
- **Customer Status** (this section): Account-level status across all services (active/suspended/closed)
- **Service States**: Per-service status (NotProvisioned/Provisioning/Disabled/Enabled/Suspended-*) - see [UI_DESIGN.md](./UI_DESIGN.md) Service State Machine

| Status | Description | Can Use Services? | Can Modify Config? |
|--------|-------------|-------------------|-------------------|
| `active` | Normal operation | ✅ Yes | ✅ Yes |
| `suspended` | Temporarily blocked (e.g., abuse, payment issues) | ❌ No | ⚠️ View only |
| `closed` | Permanently closed | ❌ No | ❌ No |

**Schema:**
```sql
-- PostgreSQL ENUM type provides type safety (see ENUM_IMPLEMENTATION.md)
CREATE TYPE customer_status AS ENUM('active', 'suspended', 'closed');
ALTER TABLE customers ADD COLUMN status customer_status NOT NULL DEFAULT 'active';
```

**Implementation:**
```typescript
// Types derived from database ENUM (single source of truth)
// packages/shared/src/constants/index.ts
export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const satisfies Record<string, CustomerStatus>;

export type CustomerStatus = typeof CUSTOMER_STATUS[keyof typeof CUSTOMER_STATUS];
```

**Example:** An `active` customer can have multiple services in different states (one service `Enabled`, another `Disabled`, etc.). A `suspended` customer cannot use any services regardless of individual service states.

**Future Refinement:**
- May add onboarding states: `pending_kyc`, `kyc_approved`, etc.
- Will remain backward compatible (new states, not replacements)

---

## API Key Fingerprinting

**Model:** Store both full key and fingerprint for fast lookups

API keys use 32-bit fingerprints derived from the first 7 Base32 characters of the key.

**Documentation:**
- **Implementation Details**: See `~/walrus/docs/HAPROXY_CONTROLS.md` (API-Keys-Filter section)
- **Database Schema**: See [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md) (api_keys table)
- **Database Design**: See [GLOBAL_MANAGER_DESIGN.md](./GLOBAL_MANAGER_DESIGN.md) (MA_VAULT generation)

**Key Points:**
- Fingerprint: First 7 Base32 characters → 32-bit value
- Used for fast lookups without exposing full keys
- Stored in `api_keys.api_key_fp` (INTEGER) field
- Indexed for performance: `INDEX idx_api_key_fp (api_key_fp) WHERE is_user_enabled = true`

---

## API Secret Key (Encryption & Authentication)

**Model:** 32-byte (256-bit) secret key for AES-128-CTR encryption and HMAC-SHA256 authentication

**Test/Development Key (hardcoded):**
```
8776c4c0e84428c6e86fca4647abe16459649aa78fe4c72e7643dc3a14343337
```

**Usage:**
- **Test/Dev Servers:** Hardcoded in code (shared with walrus/system.conf)
- **Production:** Loaded from KVCrypt (to be implemented)
- Can override with `API_SECRET_KEY` environment variable if needed

**Key Properties:**
- **Length:** 32 bytes (64 hex characters)
- **AES-128:** First 16 bytes used for encryption key
- **HMAC-SHA256:** Full 32 bytes used for authentication
- **CRITICAL:** Never rotate in production (invalidates all customer API keys)

**Implementation:**
```typescript
// apps/api/src/lib/api-keys.ts
const TEST_SECRET_KEY = '8776c4c0e84428c6e86fca4647abe16459649aa78fe4c72e7643dc3a14343337';
const SECRET_KEY_HEX = process.env.API_SECRET_KEY || TEST_SECRET_KEY;
const SECRET_KEY = Buffer.from(SECRET_KEY_HEX, 'hex');
```

**Security Notes:**
- Test key is public knowledge and only used in non-production environments
- Safe to commit to version control (test environments only)
- Production key must be kept secret and loaded from secure storage (KVCrypt)
- See [API_KEY_DESIGN.md](./API_KEY_DESIGN.md) for full encryption specification

---

## Minimum Balance Requirements

| Constant | Value | Description |
|----------|-------|-------------|
| `MINIMUM_BALANCE_ACTIVE_SERVICES_USD` | **$50** | Cannot withdraw below this if any service enabled |

**Implementation:**
```typescript
// packages/shared/src/constants.ts
export const BALANCE_LIMITS = {
  MINIMUM_ACTIVE_SERVICES_USD: 50,
} as const;
```

---

## Database Field Length Limits

**Model:** TypeScript constants defining VARCHAR length constraints for database fields

All database VARCHAR field lengths are defined as constants to ensure consistency between:
- Database schema definitions (Drizzle ORM)
- Validation schemas (Zod)
- Tests and mock data
- Documentation

**Implementation:**
```typescript
// packages/shared/src/constants/index.ts
export const FIELD_LIMITS = {
  // Sui blockchain identifiers
  SUI_ADDRESS: 66,          // Wallet addresses, package addresses, contract IDs
  SUI_TX_DIGEST: 64,        // Transaction digests/hashes
  SUI_PUBLIC_KEY: 66,       // Public keys

  // API Keys (encrypted storage)
  API_KEY_ID: 150,          // Encrypted: IV:authTag:ciphertext (~102 chars actual)

  // Authentication & Security
  AUTH_NONCE: 64,           // Challenge nonces
  TOKEN_HASH: 64,           // Session token hashes

  // Service identifiers
  SERVICE_TYPE: 20,         // 'seal', 'grpc', 'graphql'
  SERVICE_STATE: 30,        // 'not_provisioned', 'enabled', 'suspended_*', etc.
  SERVICE_TIER: 20,         // 'starter', 'pro', 'enterprise'

  // Status fields
  CUSTOMER_STATUS: 20,      // 'active', 'suspended', 'closed'
  TRANSACTION_TYPE: 20,     // 'deposit', 'withdraw', 'charge', 'credit'
  BILLING_STATUS: 20,       // 'draft', 'pending', 'paid', 'failed', 'voided'

  // User-provided names
  PACKAGE_NAME: 100,        // Seal package names

  // Business identifiers
  INVOICE_ID: 50,           // Invoice references

  // System versioning
  VAULT_VERSION: 64,        // MA/MM vault version hashes
} as const;
```

**Usage in Database Schema:**
```typescript
// packages/database/src/schema/api_keys.ts
import { FIELD_LIMITS } from '@suiftly/shared/constants';

export const apiKeys = pgTable('api_keys', {
  apiKeyId: varchar('api_key_id', { length: FIELD_LIMITS.API_KEY_ID }).notNull(),
  // ... other fields
});
```

**Usage in Validation Schema:**
```typescript
// packages/shared/src/schemas/api-key.ts
import { FIELD_LIMITS } from '../constants';

export const apiKeySchema = z.object({
  apiKeyId: z.string().max(FIELD_LIMITS.API_KEY_ID),
  // ... other fields
});
```

**Benefits:**
- Single source of truth for all VARCHAR lengths
- Compiler errors if limits change and code isn't updated
- No magic numbers scattered across codebase
- Consistent validation across database, API, and frontend
- Self-documenting field constraints

**Note:** TEXT fields (like `description`, `encrypted_private_key`) don't need constants as they have no practical length limit.

---

## Usage

**In Documentation:**
```markdown
Default spending limit: $250/28 days (see CONSTANTS.md)
```

**In Code:**
```typescript
import { SPENDING_LIMIT } from '@suiftly/shared/constants';

const defaultLimit = SPENDING_LIMIT.DEFAULT_USD; // 250
const periodMs = SPENDING_LIMIT.PERIOD_MS; // 2419200000
```

**When Updating:**
1. Change value in CONSTANTS.md
2. Update the constant in `packages/shared/src/constants/index.ts`
3. All code and docs automatically reflect new value

---

**Last Updated:** 2025-01-04
**Version:** 1.1
