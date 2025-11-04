# System Constants - Single Source of Truth

**Purpose:** Define all system-wide hard-coded constants in ONE place to prevent documentation drift.

**Implementation:** All constants are defined in `packages/shared/src/constants/index.ts`

**All documentation and code MUST reference these values.**

**Note:** These are hard-coded system constraints and enums. For runtime-configurable business values (pricing, capacities, rates), see ConfigGlobal system in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Monthly Spending Limits

**Model:** Calendar month (resets on 1st of each month)

| Constant | Value | Description |
|----------|-------|-------------|
| `MONTHLY_LIMIT_DEFAULT_USD` | **$500** | Default monthly spending authorization |
| `MONTHLY_LIMIT_MINIMUM_USD` | **$20** | Minimum allowed monthly limit |
| `MONTHLY_LIMIT_MAXIMUM_USD` | **unlimited** | No maximum cap (customer can set any value ≥ $20) |

**Reset Behavior:**
- Resets automatically on the 1st day of each calendar month (UTC)
- Smart contract emits `MonthlyReset` event
- Off-chain database field `current_month_start` tracks reset date
- Field `current_month_charged_usd_cents` resets to 0

**Implementation:**
```typescript
// packages/shared/src/constants.ts
export const MONTHLY_LIMIT = {
  DEFAULT_USD: 500,
  MINIMUM_USD: 20,
  MAXIMUM_USD: null, // unlimited
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
ALTER TABLE customers ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE customers ADD CONSTRAINT check_status CHECK (status IN ('active', 'suspended', 'closed'));
```

**Implementation:**
```typescript
// packages/shared/src/constants/index.ts
export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const;

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
- Indexed for performance: `INDEX idx_api_key_fp (api_key_fp) WHERE is_active = true`

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

## Usage

**In Documentation:**
```markdown
Default monthly limit: $500 (see CONSTANTS.md)
```

**In Code:**
```typescript
import { MONTHLY_LIMIT } from '@suiftly/shared/constants';

const defaultLimit = MONTHLY_LIMIT.DEFAULT_USD; // 500
```

**When Updating:**
1. Change value in CONSTANTS.md
2. Update the constant in `packages/shared/src/constants/index.ts`
3. All code and docs automatically reflect new value

---

**Last Updated:** 2025-01-04
**Version:** 1.1
