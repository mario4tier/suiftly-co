# System Constants - Single Source of Truth

**Purpose:** Define all system-wide constants in ONE place to prevent documentation drift.

**All documentation and code MUST reference these values.**

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

**Model:** Enum with 3 states

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
// packages/shared/src/constants.ts
export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const;

export type CustomerStatus = typeof CUSTOMER_STATUS[keyof typeof CUSTOMER_STATUS];
```

**Future Refinement:**
- May add onboarding states: `pending_kyc`, `kyc_approved`, etc.
- Will remain backward compatible (new states, not replacements)

---

## API Key Fingerprinting

**Model:** Store both full key and fingerprint

| Field | Type | Purpose |
|-------|------|---------|
| `api_key_id` | VARCHAR(100) PRIMARY KEY | Full encrypted API key string |
| `api_key_fp` | VARCHAR(64) NOT NULL | Fingerprint for fast lookups (calculation TBD) |

**Note:** Fingerprint calculation method will be defined separately. Do NOT assume hash algorithm until specified.

**Schema:**
```sql
ALTER TABLE api_keys ADD COLUMN api_key_fp VARCHAR(64) NOT NULL;
CREATE INDEX idx_api_key_fp ON api_keys(api_key_fp) WHERE is_active = true;
```

**Implementation:**
```typescript
// Calculation method TBD - placeholder
export function calculateApiKeyFingerprint(apiKey: string): string {
  // Implementation to be provided by user
  throw new Error('Fingerprint calculation not yet defined');
}
```

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
2. Update the constant in packages/shared/src/constants.ts
3. All code and docs automatically reflect new value

---

**Last Updated:** 2025-10-28
**Version:** 1.0
