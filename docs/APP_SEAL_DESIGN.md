# APP_SEAL_DESIGN: Seal Key Registration Control Plane

## Overview

This document designs the control plane for Seal key registration on the Sui blockchain. The system handles:
1. **Registration** - Creating on-chain KeyServer objects to get object IDs
2. **Re-registration** - Updating on-chain objects when packages are added/removed
3. **State Management** - Tracking async operations in the database
4. **UI Synchronization** - Keeping the frontend in sync with backend state

## Document Status

> ⚠️ **This is a DESIGN DOCUMENT for NEW functionality, not documentation of existing code.**
>
> The infrastructure described here (process groups, Sui registration pipeline, registration state machine)
> **does not exist yet**. This document specifies what WILL be built across the implementation phases.
>
> **What exists today:**
> - Mock key generation (`seal-key-generation.ts`) that uses `customerId` in derivation
> - Basic `seal_keys` table without registration status fields
> - Vault sync infrastructure for HAProxy config (`markConfigChanged` pattern)
>
> **What this document designs:**
> - Production key derivation from master seeds (replacing mock)
> - Sui blockchain registration with KeyServer objects
> - Registration state machine with auto-retry
> - Process group isolation between dev/prod environments
> - GM registration processor task
> - LM seal-server config generation

## Design Decisions (Confirmed)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Registration Trigger | **Automatic** | Queued immediately on key creation |
| Re-registration | **Automatic** | Package changes auto-queue updates |
| Failure Handling | **Unlimited auto-retry** | Exponential backoff until success |

---

## Process Group Support (Priority Prerequisite)

### Overview

Process groups (PG) enable environment isolation with separate master keys. Each process group has:
- Its own BLS12-381 master seed key
- Independent key derivation namespace
- Separate vault files (different `pg` in filename)

**Environment Mapping:**
| Environment | Process Group | Master Key Vault |
|-------------|---------------|------------------|
| Production | PG 1 | `smm-01-*` (mainnet), `stm-01-*` (testnet) |
| Development | PG 2 | `smm-02-*` (mainnet), `stm-02-*` (testnet) |

### Why This Matters for Seal Keys

Seal keys are **derived** from a master seed using a derivation index:
```
master_seed[pg] + derivation_index → BLS12-381 private key → public key
```

If development and production share the same master seed (PG 1), then:
- Dev key at index 5 = Prod key at index 5 (IDENTICAL KEYS!)
- Dev testing could accidentally use production cryptographic material
- No isolation between environments

**With separate process groups:**
- Dev (PG 2) key at index 5 ≠ Prod (PG 1) key at index 5
- Complete cryptographic isolation between environments
- Safe to test with real derivation indices in dev

### Current State Analysis

**Hardcoded to PG 1:**
```typescript
// File: apps/api/src/lib/api-keys.ts (line 281)
procGroup: options.procGroup ?? 1  // Always 1!

// File: services/global-manager/src/tasks/generate-vault.ts
pg: 1  // Hardcoded in vault writer options
```

**Vault Infrastructure Ready:**
- Vault types defined: `smm` (Seal mainnet master), `stm` (Seal testnet master)
- Filename format includes PG: `{vault:3}-{pg:02d}-{seq:09d}-...`
- Database has tracking columns for all vault types
- kvcrypt supports arbitrary vault types

**Missing Implementation:**
1. Master key vault generation (`smm`/`stm`) - not yet implemented
2. Dynamic PG selection based on environment
3. Key derivation using PG-specific master seed

### Implementation Design

#### 1. Fixed Process Group Per Server (via system.conf)

Process group is **hardcoded per server** in `system.conf`, not determined at runtime:

**File:** `system.conf`
```bash
# Development box
ENVIRONMENT=development
SEAL_PROCESS_GROUP=2

# Production server
ENVIRONMENT=production
SEAL_PROCESS_GROUP=1
```

**File:** `packages/system-config/src/index.ts` (extend existing)

```typescript
// Add to existing system-config exports
export function getSealProcessGroup(): number {
  const pg = parseInt(config.SEAL_PROCESS_GROUP || '1', 10);
  // Only PG 1-2 supported (schema has per-PG counters for these)
  // Future: expand to 1-7 with flexible counter table if needed
  if (pg < 1 || pg > 2) {
    throw new Error(`Invalid SEAL_PROCESS_GROUP: ${pg}. Must be 1 or 2.`);
  }
  return pg;
}
```

**Why hardcoded per server (for now)?**
- **Simplicity:** No runtime logic needed - just read from config
- **Safety:** Dev server can NEVER accidentally use PG 1 (production)
- **Clear isolation:** Each server owns exactly one process group
- **Spend freely:** Dev can allocate derivation indices without affecting prod namespace

> **Future consideration:** Multiple PGs per server may be supported later, but is not actively implemented now. The infrastructure (per-PG counters, PG in vault filenames) already supports this.

#### 2. Master Key Vault Structure

**Vault Types:**
- `smm` - Seal mainnet master keys (per process group)
- `stm` - Seal testnet master keys (per process group)

**Storage Pattern:**
```
/opt/coord/.sys/vaults/smm/
  smm-01-000000001-*.enc  # PG 1 (Production) master key
  smm-02-000000001-*.enc  # PG 2 (Development) master key
```

**Master Key Vault Data:**
```typescript
interface MasterKeyVaultData {
  // Key: `master:${pg}`
  // Value: JSON string of:
  masterSeed: string;     // 32 bytes, hex-encoded BLS12-381 seed
  createdAt: string;      // ISO timestamp
  createdBy: string;      // 'bootstrap' | 'rotation'
}

interface MasterKeyVaultMetadata {
  seq: number;
  pg: number;             // Process group this master key belongs to
  createdAt: string;
  contentHash: string;
}
```

**`getMasterSeed` Implementation:**

**File:** `apps/api/src/lib/master-keys.ts`

```typescript
import { VaultReader } from '@walrus/vault-codec';
import { getSealProcessGroup } from '@walrus/system-config';

// Cache master seeds in memory (loaded once on startup)
const masterSeedCache = new Map<string, Buffer>();

export async function getMasterSeed(
  network: 'mainnet' | 'testnet',
  pg?: number
): Promise<Buffer> {
  const processGroup = pg ?? getSealProcessGroup();
  const vaultType = network === 'mainnet' ? 'smm' : 'stm';
  const cacheKey = `${vaultType}-${processGroup}`;

  // Return cached if available
  if (masterSeedCache.has(cacheKey)) {
    return masterSeedCache.get(cacheKey)!;
  }

  // Load from vault (uses KMS-encrypted storage)
  const reader = new VaultReader({ vaultDir: '/opt/coord/.sys/vaults' });
  const vault = await reader.loadLatest(vaultType, { pg: processGroup });

  if (!vault) {
    throw new Error(`Master key vault not found: ${vaultType} pg=${processGroup}`);
  }

  const masterData = vault.data.get(`master:${processGroup}`);
  if (!masterData) {
    throw new Error(`Master seed not found in vault: ${cacheKey}`);
  }

  const parsed = JSON.parse(masterData);
  const seed = Buffer.from(parsed.masterSeed, 'hex');

  // Cache for future use (master keys don't change at runtime)
  masterSeedCache.set(cacheKey, seed);

  return seed;
}
```

**Security notes:**
- Master seeds are KMS-encrypted at rest (via kvcrypt/vault-codec)
- Cached in memory after first load (no repeated disk/decrypt operations)
- Process group from `system.conf` ensures correct vault is loaded
- No HSM required - KMS certificates provide the encryption layer

#### 3. Key Derivation with Process Group

**Current (Bug - Ignores PG):**
```typescript
// apps/api/src/routes/seal.ts
const keyResult = await generateSealKey({
  derivationIndex,
  customerId: ctx.user!.customerId,
});
```

**Fixed (Uses PG-specific master seed):**
```typescript
import { getSealProcessGroup } from '@walrus/system-config';
import { getMasterSeed } from '../lib/master-keys';

// apps/api/src/routes/seal.ts
const pg = getSealProcessGroup();  // From system.conf (fixed per server)
const masterSeed = await getMasterSeed(network, pg);  // From smm/stm vault

const keyResult = await generateSealKey({
  derivationIndex,
  masterSeed,           // PG-specific master seed
  customerId: ctx.user!.customerId,
  processGroup: pg,     // Stored for audit trail
});
```

#### 4. Database Schema Update

**File:** `packages/database/src/schema/seal.ts`

```typescript
export const sealKeys = pgTable('seal_keys', {
  // ... existing fields ...

  // NEW: Track which process group the key belongs to
  processGroup: integer('process_group')
    .notNull()
    .default(1),  // Default to 1 for backward compatibility
});
```

**Migration for Existing Keys:**
```sql
-- All existing keys were created with PG 1 (or no PG awareness)
-- Mark them explicitly
UPDATE seal_keys SET process_group = 1 WHERE process_group IS NULL;
```

#### 5. Global Derivation Index - Per Process Group

**Critical Update to Phase 0 Design:**

The derivation index counter must be **per process group**, not global:

```typescript
// File: packages/database/src/schema/system-control.ts
export const systemControl = pgTable('system_control', {
  // ... existing fields ...

  // UPDATED: Per-process-group counters
  nextSealDerivationIndexPg1: integer('next_seal_derivation_index_pg1')
    .notNull()
    .default(0),
  nextSealDerivationIndexPg2: integer('next_seal_derivation_index_pg2')
    .notNull()
    .default(0),
});
```

**Why per-PG counters?**
- Each PG has a different master seed
- Derivation index 5 in PG 1 → completely different key than index 5 in PG 2
- No collision risk between PGs
- Development can freely allocate indices without affecting production namespace

**Allocation Flow:**
```typescript
import { getSealProcessGroup } from '@walrus/system-config';

const pg = getSealProcessGroup();  // From system.conf

// Use conditional logic (Drizzle columns aren't string-indexed)
const [control] = pg === 1
  ? await tx.update(systemControl)
      .set({ nextSealDerivationIndexPg1: sql`${systemControl.nextSealDerivationIndexPg1} + 1` })
      .returning({ allocatedIndex: systemControl.nextSealDerivationIndexPg1 })
  : await tx.update(systemControl)
      .set({ nextSealDerivationIndexPg2: sql`${systemControl.nextSealDerivationIndexPg2} + 1` })
      .returning({ allocatedIndex: systemControl.nextSealDerivationIndexPg2 });

const derivationIndex = control.allocatedIndex;
```

#### 6. API Key Process Group

API keys embed process group (3 bits):

```typescript
// File: apps/api/src/lib/api-keys.ts

// BEFORE (hardcoded):
procGroup: options.procGroup ?? 1

// AFTER (from system.conf):
import { getSealProcessGroup } from '@walrus/system-config';

procGroup: options.procGroup ?? getSealProcessGroup()
```

HAProxy uses this to route to correct backend:
- `X-Suiftly-Proc-Group: 1` → Production seal servers
- `X-Suiftly-Proc-Group: 2` → Development seal servers (rejected in prod HAProxy)

#### 7. Vault Generation with Process Group

**File:** `services/global-manager/src/tasks/generate-vault.ts`

```typescript
import { getSealProcessGroup } from '@walrus/system-config';

// BEFORE:
const result = await writer.write(vaultType, vaultData, {
  seq: newSeq,
  pg: 1,  // Hardcoded!
  source: 'gm-primary',
});

// AFTER:
const pg = getSealProcessGroup();  // From system.conf
const result = await writer.write(vaultType, vaultData, {
  seq: newSeq,
  pg,     // Fixed per server
  source: 'gm-primary',
});
```

### Bootstrap Procedure

**One-time setup for each server:**

1. **Configure system.conf:**
   ```bash
   # On dev box:
   echo "SEAL_PROCESS_GROUP=2" >> ~/walrus/system.conf

   # On production:
   echo "SEAL_PROCESS_GROUP=1" >> ~/walrus/system.conf
   ```

2. **Generate Master Seeds (run on each server for its PG):**
   ```bash
   # On dev box (PG 2):
   ./scripts/bootstrap-master-key.ts --network mainnet
   ./scripts/bootstrap-master-key.ts --network testnet
   # Script reads SEAL_PROCESS_GROUP from system.conf

   # On production (PG 1):
   ./scripts/bootstrap-master-key.ts --network mainnet
   ./scripts/bootstrap-master-key.ts --network testnet
   ```

3. **Verify:**
   ```bash
   # On dev: should see PG 2 vault
   ls /opt/coord/.sys/vaults/smm/
   # smm-02-*.enc

   # On prod: should see PG 1 vault
   ls /opt/coord/.sys/vaults/smm/
   # smm-01-*.enc
   ```

4. **Database counters** are initialized per-PG automatically (both start at 0).

### Validation Checklist

Before implementing Seal key registration, verify:

- [ ] `system.conf` has `SEAL_PROCESS_GROUP` set correctly (2 for dev, 1 for prod)
- [ ] `getSealProcessGroup()` returns expected value
- [ ] Master key vaults exist for the current PG (`smm-0X-*`, `stm-0X-*`)
- [ ] API key generation uses `getSealProcessGroup()`
- [ ] Derivation index counter uses correct PG column
- [ ] Vault writer uses `getSealProcessGroup()`
- [ ] No hardcoded `pg: 1` remains in codebase

### Impact on Implementation Plan

**Process Group support should be Phase -1 (before Phase 0):**

| Phase | Task | Depends On |
|-------|------|------------|
| **-1** | Process Group infrastructure | None |
| 0 | Derivation Index fix (per-PG) | Phase -1 |
| 1 | Registration State Machine | Phase 0 |
| 2+ | ... | ... |

---

## Current State Analysis

### Existing Infrastructure
- `seal_keys` table has `object_id` and `register_txn_digest` fields (nullable, unpopulated)
- `seal_keys` has `derivation_index` field (for derived keys) or `encrypted_private_key` (for imported)
- `seal_packages` table tracks packages per key
- GM handles vault generation with sequence-based sync (`smaConfigChangeVaultSeq`)
- UI uses React Query + tRPC with adaptive polling (15s-1hr based on activity)
- Move contract: `create_and_transfer_v1(name, url, key_type, pk)` creates KeyServer objects

### Critical Constraint: Derivation Index Management
**Derivation indices are a precious, non-renewable resource:**
- Each index derives a unique BLS12-381 key from the master seed
- Once allocated, an index is **permanently bound** to that customer
- Indices must **never be recycled** - even if key is "deleted"
- Index allocation must be **atomic** with key creation (no gaps/waste)

### Sui Move Contract Reference
```move
// Package IDs:
// - Testnet: 0x927a54e9ae803f82ebf480136a9bcfe45101ccbe28b13f433c89f5181069d682
// - Mainnet: 0xa212c4c6c7183b911d0be8768f4cb1df7a383025b5d0ba0c014009f0f30f5f8d

public struct KeyServer has key, store {
    id: UID,
    first_version: u64,
    last_version: u64,
}

entry fun create_and_transfer_v1(
    name: String,
    url: String,
    key_type: u8,      // 0 = BLS12-381 G1, 1 = BLS12-381 G2
    pk: vector<u8>,    // Public key bytes
    ctx: &mut TxContext,
)
```

---

## Derivation Index Management (Critical Bug Fix)

### BUG IN CURRENT INDEX ALLOCATION (Production Path)

**File:** `apps/api/src/routes/seal.ts` lines 739-750

```typescript
// CURRENT CODE (BUG!): Allocates per-service, not globally
const allKeys = await tx.query.sealKeys.findMany({
  where: eq(sealKeys.instanceId, service.instanceId),  // <-- WRONG!
});
const nextIndex = usedIndices.length === 0 ? 0 : Math.max(...usedIndices) + 1;
```

**Why this is a bug (for production):**

In production, keys will be derived from a master seed using ONLY the derivation index:
```
master_seed + derivation_index → BLS12-381 private key
```

If two customers both get derivation index 0, they get **identical keys** from the same master seed.

> **Note:** The current MOCK implementation (`seal-key-generation.ts`) happens to avoid this by mixing
> `customerId` into the key material: `(customerId + derivationIndex + i) % 256`. This is a mock behavior
> that masks the underlying allocation bug. When production derivation is implemented (using real BLS12-381
> cryptography), the bug will surface as identical keys across customers.

### Requirements for Fix
1. **Global uniqueness** - Indices must be global across ALL customers
2. **Atomic allocation** - Index reserved in same transaction as key creation
3. **Permanent binding** - Once allocated, index belongs to that customer forever
4. **No recycling** - "Deleted" keys retain their index (soft-delete only)
5. **No gaps on failure** - If transaction fails, index is not consumed

### Solution: Per-Process-Group Counter in system_control

Use the existing `system_control` table pattern for atomic counters, **one per process group**:

> **Note:** See "Process Group Support" section above for why counters are per-PG.
> Each PG has a different master seed, so derivation indices are independent namespaces.

**File:** `packages/database/src/schema/system-control.ts`

```typescript
export const systemControl = pgTable('system_control', {
  // ... existing fields ...

  // NEW: Per-process-group seal key derivation counters
  nextSealDerivationIndexPg1: integer('next_seal_derivation_index_pg1')
    .notNull()
    .default(0),
  nextSealDerivationIndexPg2: integer('next_seal_derivation_index_pg2')
    .notNull()
    .default(0),
});
```

### Fixed Allocation Flow

```typescript
import { getSealProcessGroup } from '@walrus/system-config';
import { getMasterSeed } from '../lib/master-keys';

// In createKey mutation - FIXED
createKey: protectedProcedure.mutation(async ({ ctx, input }) => {
  // ... validation ...

  // Get process group from system.conf (fixed per server)
  const pg = getSealProcessGroup();
  const network = service.network; // 'mainnet' | 'testnet'

  // Load master seed OUTSIDE transaction (I/O should not hold tx locks)
  const masterSeed = await getMasterSeed(network, pg);

  return await withCustomerLockForAPI(customerId, 'createKey', async (tx) => {
    // ATOMIC INDEX ALLOCATION (per-PG, not per-service!)
    // Use conditional logic (Drizzle columns aren't string-indexed)
    const [control] = pg === 1
      ? await tx.update(systemControl)
          .set({ nextSealDerivationIndexPg1: sql`${systemControl.nextSealDerivationIndexPg1} + 1` })
          .returning({ allocatedIndex: systemControl.nextSealDerivationIndexPg1 })
      : await tx.update(systemControl)
          .set({ nextSealDerivationIndexPg2: sql`${systemControl.nextSealDerivationIndexPg2} + 1` })
          .returning({ allocatedIndex: systemControl.nextSealDerivationIndexPg2 });

    const derivationIndex = control.allocatedIndex;

    // Generate key with PG-unique index and pre-loaded master seed
    const keyResult = await generateSealKey({
      derivationIndex,
      masterSeed,         // PG-specific, loaded outside tx!
      customerId: ctx.user!.customerId,
    });

    // Create seal key record
    const [newKey] = await tx.insert(sealKeys).values({
      customerId: ctx.user!.customerId,
      instanceId: service.instanceId,
      derivationIndex,    // Unique within PG!
      processGroup: pg,   // Track which PG this key belongs to
      publicKey: keyResult.publicKey,
      registrationStatus: 'registering',
    }).returning();

    // Queue registration op (denormalize customerId/network for GM efficiency)
    await tx.insert(sealRegistrationOps).values({
      sealKeyId: newKey.sealKeyId,
      customerId: ctx.user!.customerId,
      network: service.network,  // 'mainnet' | 'testnet'
      opType: 'register',
      status: 'queued',
      packagesVersionAtOp: 0,
    });

    // ... rest of key creation ...
  });
});
```

### Why This Works
- **Atomic:** `UPDATE ... RETURNING` allocates index in single atomic operation
- **Per-PG isolation:** Counter is per process group - dev can't collide with prod
- **No gaps:** If transaction fails, the UPDATE is rolled back
- **No duplicates:** PostgreSQL guarantees sequential increment within each PG
- **Full audit trail:** `customerId` and `processGroup` stored in `seal_keys` record

### Migration for Existing Keys (if any)

```sql
-- First, mark all existing keys with their process group
-- (Existing keys were created before PG awareness, assume PG 1)
UPDATE seal_keys SET process_group = 1 WHERE process_group IS NULL;

-- Check for collision within each PG (must run before fix)
SELECT derivation_index, process_group, COUNT(*) as cnt
FROM seal_keys
WHERE derivation_index IS NOT NULL
GROUP BY derivation_index, process_group
HAVING COUNT(*) > 1;

-- If collisions exist within a PG, keys must be regenerated (contact affected customers)

-- Set counters to max existing + 1 for each PG
UPDATE system_control SET
  next_seal_derivation_index_pg1 = (
    SELECT COALESCE(MAX(derivation_index), -1) + 1
    FROM seal_keys WHERE process_group = 1
  ),
  next_seal_derivation_index_pg2 = (
    SELECT COALESCE(MAX(derivation_index), -1) + 1
    FROM seal_keys WHERE process_group = 2
  );
```

### Production Deletion Prevention

**File:** `apps/api/src/routes/seal.ts`

```typescript
// Add deleteKey mutation (currently missing!)
deleteKey: protectedProcedure
  .input(z.object({ sealKeyId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    // BLOCK in production
    if (isProduction()) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Key deletion is disabled in production. Contact support for key export.',
      });
    }

    // Development only: soft-delete (keep derivation_index consumed)
    await withCustomerLockForAPI(ctx.user!.customerId, 'deleteKey', async (tx) => {
      // Verify ownership
      const key = await tx.query.sealKeys.findFirst({
        where: and(
          eq(sealKeys.sealKeyId, input.sealKeyId),
          eq(sealKeys.customerId, ctx.user!.customerId)
        ),
      });

      if (!key) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Seal key not found' });
      }

      // Soft delete - index remains consumed forever
      await tx.update(sealKeys)
        .set({ deletedAt: dbClock.now() })
        .where(eq(sealKeys.sealKeyId, input.sealKeyId));
    });
  });
```

### Schema Update: Add deletedAt to seal_keys

```typescript
// File: packages/database/src/schema/seal.ts
export const sealKeys = pgTable('seal_keys', {
  // ... existing fields ...

  // NEW: Soft delete support
  deletedAt: timestamp('deleted_at'),
});
```

### Registration Failure ≠ Index Waste
**Important:** If Sui registration fails (the new feature), the key still exists in the DB with its derivation index. The index is NOT wasted - the key is valid, it just doesn't have an on-chain object ID yet. Auto-retry will eventually succeed.

---

## Architecture Design

### 1. Registration State Machine

New `registration_status` enum for `seal_keys` table:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  KEY CREATED                                                    │
│       │                                                         │
│       ▼                                                         │
│  ┌───────────┐    success    ┌────────────┐   pkg change        │
│  │REGISTERING│ ─────────────▶│ REGISTERED │────────────┐       │
│  └───────────┘               └────────────┘            │        │
│       │  ▲                       ▲                     ▼        │
│       │  │ failure               │ success      ┌──────────┐    │
│       │  │ (auto-retry)          └──────────────│ UPDATING │    │
│       └──┘                                      └──────────┘    │
│                                                    │     ▲      │
│                                          failure   │     │      │
│                                        (auto-retry)└─────┘      │
└─────────────────────────────────────────────────────────────────┘
```

**States:**
| State | Description | object_id | Can Edit Packages | UI Display |
|-------|-------------|-----------|-------------------|------------|
| `registering` | Initial registration in progress | NULL | No (locked) | "Registering..." spinner |
| `registered` | Successfully registered on-chain | Set | Yes | Green checkmark |
| `updating` | Re-registration in progress | Set | No (locked) | "Updating..." spinner |

**Notes:**
- No `pending` state - keys auto-queue registration on creation
- No `failed` state - unlimited auto-retry with exponential backoff
- Error info stored in `registrationError` field for debugging (cleared on success)
- Retry tracking via `registrationAttempts` and `nextRetryAt` fields

### 2. Database Schema Changes

**File:** `packages/database/src/schema/seal.ts`

```typescript
// New enum (simplified - no pending/failed states)
export const registrationStatusEnum = pgEnum('seal_registration_status', [
  'registering',   // Initial registration in progress
  'registered',    // Successfully registered on-chain
  'updating',      // Re-registration in progress (packages changed)
]);

// Updates to seal_keys table
export const sealKeys = pgTable('seal_keys', {
  // ... existing fields ...

  // NEW FIELDS
  registrationStatus: registrationStatusEnum('registration_status')
    .notNull()
    .default('registering'),  // Auto-starts registering on creation
  registrationError: text('registration_error'),  // Last error (for debugging, cleared on success)
  registrationAttempts: integer('registration_attempts')
    .notNull()
    .default(0),
  lastRegistrationAttemptAt: timestamp('last_registration_attempt_at'),
  nextRetryAt: timestamp('next_retry_at'),  // For exponential backoff
  packagesVersion: integer('packages_version')
    .notNull()
    .default(0),
  registeredPackagesVersion: integer('registered_packages_version')
    .default(null),
});
```

**Exponential Backoff Schedule:**
| Attempt | Delay | Cumulative Wait |
|---------|-------|-----------------|
| 1 | 0s (immediate) | 0s |
| 2 | 5s | 5s |
| 3 | 15s | 20s |
| 4 | 45s | 1m 5s |
| 5 | 2m 15s | 3m 20s |
| 6+ | 5m (capped) | +5m each |

Formula: `attempt <= 1 ? 0 : min(5 * (3^(attempt-2)), 300)` seconds (capped at 5 minutes)

### 3. Registration Operations Table

New table to track async operations:

```typescript
export const sealRegistrationOps = pgTable('seal_registration_ops', {
  opId: serial('op_id').primaryKey(),
  sealKeyId: integer('seal_key_id')
    .notNull()
    .references(() => sealKeys.sealKeyId, { onDelete: 'cascade' }),

  // Denormalized for GM efficiency (avoids joins)
  customerId: integer('customer_id').notNull(),
  network: text('network').notNull(),  // 'mainnet' | 'testnet'

  opType: text('op_type').notNull(),  // 'register' | 'update'
  status: text('status').notNull(),   // 'queued' | 'processing' | 'completed'
  packagesVersionAtOp: integer('packages_version_at_op').notNull(),

  // Retry tracking
  attemptCount: integer('attempt_count').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at'),  // For exponential backoff

  // Results
  txDigest: bytea('tx_digest'),       // Set on completion
  objectId: bytea('object_id'),       // Set on completion (for register)
  errorMessage: text('error_message'),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

// Index for efficient GM polling
// CREATE INDEX idx_seal_reg_ops_pending ON seal_registration_ops(status, next_retry_at, created_at)
// WHERE status = 'queued';
```

---

## Component Design

### 4. Sui Transaction Service (Mock)

**File:** `apps/api/src/lib/sui-transaction-service.ts`

```typescript
interface RegisterKeyParams {
  name: string;
  url: string;
  keyType: number;      // 0 = G1, 1 = G2
  publicKey: Buffer;
  network: 'mainnet' | 'testnet';
  existingObjectId?: string;  // For idempotency check
}

interface RegisterKeyResult {
  success: boolean;
  objectId?: string;    // 0x-prefixed, 64 hex chars
  txDigest?: string;    // 0x-prefixed, 64 hex chars
  alreadyExists?: boolean;  // True if object already existed
  error?: string;
}

class SuiTransactionService {
  // Production: calls actual Sui RPC
  // Development: mock with 2 second delay

  async registerKey(params: RegisterKeyParams): Promise<RegisterKeyResult>;
  async updateKey(objectId: string, packages: string[]): Promise<RegisterKeyResult>;
}
```

**Mock Implementation:**
- 2 second simulated delay
- Deterministic object IDs based on input hash (for testing reproducibility)
- Configurable failure rate for testing error handling

**Idempotency Handling:**

The Sui transaction must be idempotent. If the tx succeeds but DB update fails, retry should NOT create a duplicate KeyServer object.

**Strategy: Check-then-create with object ID caching**

```typescript
async registerKey(params: RegisterKeyParams): Promise<RegisterKeyResult> {
  // 1. If we already have an objectId in DB, verify it exists on-chain
  if (params.existingObjectId) {
    const exists = await this.checkObjectExists(params.existingObjectId);
    if (exists) {
      return {
        success: true,
        objectId: params.existingObjectId,
        alreadyExists: true,
      };
    }
    // Object doesn't exist (shouldn't happen), fall through to create
  }

  // 2. Query on-chain for existing KeyServer with matching public key
  //    (Sui objects are queryable by type + owner)
  const existing = await this.findKeyServerByPublicKey(params.publicKey, params.network);
  if (existing) {
    return {
      success: true,
      objectId: existing.objectId,
      txDigest: existing.txDigest,
      alreadyExists: true,
    };
  }

  // 3. No existing object, create new one
  const result = await this.createKeyServer(params);
  return result;
}
```

**Why this works:**
- If Sui tx succeeded but DB failed, retry finds the existing object by public key
- Public key is unique per derivation index, so lookup is deterministic
- No duplicate objects created on retry

### 5. GM Registration Processor

**File:** `services/global-manager/src/tasks/process-seal-registrations.ts`

```typescript
// Periodic task (every 5 seconds)
export async function processSealRegistrations(): Promise<void> {
  const now = dbClock.now();

  // 1. Find operations ready to process (queued AND past retry time)
  const pendingOps = await db.query.sealRegistrationOps.findMany({
    where: and(
      eq(sealRegistrationOps.status, 'queued'),
      or(
        isNull(sealRegistrationOps.nextRetryAt),
        lte(sealRegistrationOps.nextRetryAt, now)
      )
    ),
    orderBy: asc(sealRegistrationOps.createdAt),
    limit: 5,  // Process in batches
  });

  // 2. Process each operation sequentially
  for (const op of pendingOps) {
    await processOperation(op);
  }
}

async function processOperation(op: SealRegistrationOp): Promise<void> {
  const now = dbClock.now();

  // Mark as processing (idempotent - if already processing, this is a no-op)
  await db.update(sealRegistrationOps)
    .set({ status: 'processing', startedAt: now })
    .where(eq(sealRegistrationOps.opId, op.opId));

  try {
    // Get seal key data for registration
    const sealKey = await db.query.sealKeys.findFirst({
      where: eq(sealKeys.sealKeyId, op.sealKeyId),
    });

    // Branch based on operation type
    let result: RegisterKeyResult;

    if (op.opType === 'register') {
      // Initial registration - create KeyServer object
      result = await suiService.registerKey({
        network: op.network,
        publicKey: sealKey.publicKey,
        existingObjectId: sealKey.objectId ? `0x${sealKey.objectId.toString('hex')}` : undefined,
        // ... other params (name, url, keyType)
      });
    } else {
      // Update - re-register with updated packages
      // Note: Seal's on-chain model may not require update tx - TBD based on Mysten's contract
      result = await suiService.updateKey({
        network: op.network,
        objectId: `0x${sealKey.objectId.toString('hex')}`,
        packages: await getEnabledPackages(sealKey.sealKeyId),
      });
    }

    if (result.success) {
      // SUCCESS: Update op + key in transaction
      await db.transaction(async (tx) => {
        await tx.update(sealRegistrationOps).set({
          status: 'completed',
          completedAt: now,
          txDigest: Buffer.from(result.txDigest.slice(2), 'hex'),
          objectId: Buffer.from(result.objectId.slice(2), 'hex'),
        }).where(eq(sealRegistrationOps.opId, op.opId));

        // Get current key state to check for version mismatch
        const [key] = await tx.update(sealKeys).set({
          registrationStatus: 'registered',
          objectId: Buffer.from(result.objectId.slice(2), 'hex'),
          registerTxnDigest: Buffer.from(result.txDigest.slice(2), 'hex'),
          registeredPackagesVersion: op.packagesVersionAtOp,
          registrationError: null,
          registrationAttempts: 0,
          nextRetryAt: null,
        })
        .where(eq(sealKeys.sealKeyId, op.sealKeyId))
        .returning();

        // Handle edge case: key was deleted during processing
        if (!key) {
          logger.warn(`Seal key ${op.sealKeyId} was deleted during registration, op completed but key gone`);
          return; // Op already marked completed, nothing more to do
        }

        // CHECK: More work needed? (package changed during processing)
        if (key.packagesVersion > op.packagesVersionAtOp) {
          // Package was added/changed during registration - queue update
          await tx.update(sealKeys)
            .set({ registrationStatus: 'updating' })
            .where(eq(sealKeys.sealKeyId, op.sealKeyId));

          await tx.insert(sealRegistrationOps).values({
            sealKeyId: op.sealKeyId,
            customerId: op.customerId,
            network: op.network,
            opType: 'update',
            status: 'queued',
            packagesVersionAtOp: key.packagesVersion,
          });

          logger.info(`Key ${op.sealKeyId}: packages changed during registration, queued update`);
        }
      });

      // Trigger vault sync (fire-and-forget, don't block on failure)
      // If this fails, registration is still successful - vault sync will happen via GM periodic task
      // NOTE: triggerVaultSync() takes no params - it triggers global sync-all endpoint
      try {
        await triggerVaultSync();  // No parameters - global vault regeneration
      } catch (syncError) {
        logger.error(`Vault sync failed after registration:`, syncError);
        // Don't rethrow - registration succeeded, vault sync can happen later
      }
    }
  } catch (error) {
    // FAILURE: Schedule retry with exponential backoff
    const attempts = op.attemptCount + 1;
    // Attempt 1 = immediate, then exponential backoff capped at 5 min
    const delaySeconds = attempts <= 1 ? 0 : Math.min(5 * Math.pow(3, attempts - 2), 300);
    const nextRetryAt = new Date(now.getTime() + delaySeconds * 1000);

    await db.transaction(async (tx) => {
      await tx.update(sealRegistrationOps).set({
        status: 'queued',  // Back to queued for retry
        attemptCount: attempts,
        nextRetryAt,
        errorMessage: error.message,
      }).where(eq(sealRegistrationOps.opId, op.opId));

      await tx.update(sealKeys).set({
        registrationError: error.message,
        registrationAttempts: attempts,
        lastRegistrationAttemptAt: now,
        nextRetryAt,
      }).where(eq(sealKeys.sealKeyId, op.sealKeyId));
    });

    logger.warn(`Seal registration failed for key ${op.sealKeyId}, attempt #${attempts}, next retry at ${nextRetryAt}`);
  }
}
```

**Key Design Points:**
- **Denormalized data:** `customerId` and `network` on op avoids joins
- **Version mismatch check:** After success, if `packagesVersion > packagesVersionAtOp`, auto-queue update
- **Idempotent:** Operations are processed sequentially; status transitions are atomic
- **Backoff fix:** Attempt 1 is immediate (0s), then exponential
- **opType branching:** Handles both `register` (create) and `update` (re-register) operations

**Single GM Instance Assumption:**

> ⚠️ **Current design assumes only ONE GM instance runs at a time.**
>
> The query at line `findMany({ where: status='queued' })` does not use row-level locking.
> If multiple GM instances run concurrently (HA setup), they could fetch and process the
> same ops, causing duplicate Sui transaction attempts (idempotency should catch this,
> but it wastes resources).
>
> **Future HA Support:** To support multiple GM instances, add row-level locking:
> ```sql
> SELECT * FROM seal_registration_ops
> WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())
> ORDER BY created_at ASC
> LIMIT 5
> FOR UPDATE SKIP LOCKED  -- Skip rows being processed by other GMs
> ```
> This allows multiple GMs to process different ops in parallel without conflicts.

**Staleness Recovery:**

If GM crashes while processing, ops could get stuck in `processing` state. Add recovery on startup and periodically:

```typescript
// Run on GM startup and every 5 minutes
async function recoverStaleOps(): Promise<void> {
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes

  const staleOps = await db.update(sealRegistrationOps)
    .set({
      status: 'queued',
      errorMessage: 'Recovered from stale processing state',
    })
    .where(and(
      eq(sealRegistrationOps.status, 'processing'),
      lt(sealRegistrationOps.startedAt, staleThreshold)
    ))
    .returning();

  if (staleOps.length > 0) {
    logger.warn(`Recovered ${staleOps.length} stale registration ops`);
  }
}
```

**Task Queue Integration:**

```typescript
// File: services/global-manager/src/task-queue.ts

export async function setupSealRegistrationTasks(): Promise<void> {
  // Recover any stale ops on startup
  await recoverStaleOps();

  // Process pending registrations every 5 seconds
  scheduleTask('processSealRegistrations', '*/5 * * * * *', processSealRegistrations);

  // Recover stale ops every 5 minutes (in case GM was restarted without crash)
  scheduleTask('recoverStaleSealOps', '*/5 * * * *', recoverStaleOps);
}
```

This makes the system self-healing - stuck ops automatically retry.

### 6. API Layer (tRPC Procedures)

**File:** `apps/api/src/routes/seal.ts` - Modifications

```typescript
// MODIFIED: createKey - now auto-queues registration
createKey: protectedProcedure
  .input(z.object({...}))
  .mutation(async ({ ctx, input }) => {
    return await withCustomerLockForAPI(customerId, async () => {
      // ... existing key generation logic ...

      await db.transaction(async (tx) => {
        // Insert seal key with status='registering' (default)
        const [newKey] = await tx.insert(sealKeys).values({
          customerId,
          instanceId,
          derivationIndex,
          publicKey: keyResult.publicKey,
          // registrationStatus defaults to 'registering'
        }).returning();

        // AUTO-QUEUE REGISTRATION (new)
        await tx.insert(sealRegistrationOps).values({
          sealKeyId: newKey.sealKeyId,
          customerId,           // Denormalized for GM efficiency
          network: service.network,  // 'mainnet' | 'testnet'
          opType: 'register',
          status: 'queued',
          packagesVersionAtOp: 0,
        });
      });

      // Trigger vault sync OUTSIDE transaction (fire-and-forget)
      // NOTE: triggerVaultSync() takes no params - it triggers global sync-all endpoint
      void triggerVaultSync();

      return { sealKeyId: newKey.sealKeyId };
    });
  });

// NEW: Get registration status for polling
getRegistrationStatus: protectedProcedure
  .query(async ({ ctx }) => {
    const keys = await db.query.sealKeys.findMany({
      where: eq(sealKeys.customerId, ctx.customer.customerId),
      columns: {
        sealKeyId: true,
        registrationStatus: true,
        registrationError: true,
        registrationAttempts: true,
        nextRetryAt: true,
        objectId: true,
      },
    });

    return keys.map(key => ({
      sealKeyId: key.sealKeyId,
      status: key.registrationStatus,
      error: key.registrationError,
      attempts: key.registrationAttempts,
      nextRetryAt: key.nextRetryAt,
      objectId: key.objectId ? `0x${key.objectId.toString('hex')}` : null,
    }));
  });
```

**Note:** No `registerKey` or `retryRegistration` mutations needed - everything is automatic.

### 7. Automatic Package Change Detection

When packages are added/modified/deleted:

```typescript
// In addPackage mutation (seal.ts)
addPackage: protectedProcedure
  .input(z.object({...}))
  .mutation(async ({ ctx, input }) => {
    // ... existing logic ...

    await db.transaction(async (tx) => {
      // Insert package
      await tx.insert(sealPackages).values({...});

      // Increment packages version
      const [updatedKey] = await tx.update(sealKeys)
        .set({
          packagesVersion: sql`${sealKeys.packagesVersion} + 1`
        })
        .where(eq(sealKeys.sealKeyId, input.sealKeyId))
        .returning();

      // Defensive check (ownership should be verified earlier, but be safe)
      if (!updatedKey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Seal key not found' });
      }

      // If key is registered, auto-queue update
      if (updatedKey.registrationStatus === 'registered') {
        // Mark as updating
        await tx.update(sealKeys)
          .set({ registrationStatus: 'updating' })
          .where(eq(sealKeys.sealKeyId, input.sealKeyId));

        // Queue re-registration
        await tx.insert(sealRegistrationOps).values({
          sealKeyId: input.sealKeyId,
          customerId: ctx.user!.customerId,
          network: service.network,
          opType: 'update',
          status: 'queued',
          packagesVersionAtOp: updatedKey.packagesVersion,
        });
      }

      // Trigger vault sync (outside transaction would be better, but fire-and-forget is OK)
      // NOTE: triggerVaultSync() takes no params - it triggers global sync-all endpoint
      void triggerVaultSync();
    });
  });

// Same pattern applies to:
// - updatePackage (if address changes)
// - deletePackage
// - togglePackage
```

**Note:** Multiple rapid package changes may create multiple ops. This is acceptable because:
1. Ops are processed sequentially - no race conditions
2. Each op registers the packages at that point in time
3. Final state converges correctly to latest configuration

**Why debouncing isn't needed:** The "more work needed" check after each op completion ensures that if `packagesVersion > registeredPackagesVersion`, another update is queued. This handles any drift automatically.

**Handling `updating` state:** If a package is added while status is `updating`:
- `packagesVersion` is incremented (package added to DB)
- No new op is queued (status != 'registered')
- When current update completes, the version mismatch check triggers another update
- System is self-healing - no package changes are lost

---

## UI Design

### 8. Registration Status Display

**File:** `apps/webapp/src/components/services/SealKeysSection.tsx`

Add status badge next to each key:

```tsx
const statusConfig = {
  registering: {
    label: 'Registering...',
    color: 'blue',
    icon: Loader2,
    spin: true,
    tooltip: 'Initial registration in progress'
  },
  registered: {
    label: 'Registered',
    color: 'green',
    icon: CheckCircle,
    spin: false,
    tooltip: null
  },
  updating: {
    label: 'Updating...',
    color: 'blue',
    icon: Loader2,
    spin: true,
    tooltip: 'Package changes being registered on-chain'
  },
};

// Extended tooltip for retry info
function getTooltip(key: SealKey): string | null {
  if (key.registrationAttempts > 0 && key.nextRetryAt) {
    const retryIn = formatDistanceToNow(key.nextRetryAt);
    return `Retry #${key.registrationAttempts + 1} in ${retryIn}`;
  }
  return statusConfig[key.registrationStatus].tooltip;
}
```

### 9. UI Behavior (Fully Automatic)

| Status | Edit Packages | Delete Key | Object ID Display |
|--------|---------------|------------|-------------------|
| `registering` | Disabled | Disabled | Hidden |
| `registered` | Enabled | Enabled | Shown (truncated, copyable) |
| `updating` | Disabled | Disabled | Shown (with spinner) |

**No manual action buttons** - registration is fully automatic with unlimited retries.

**Retry info display:** When `registrationAttempts > 0`, show subtle indicator with next retry time.

### 10. Status Polling Enhancement

Extend `getServicesStatus` to include registration states:

```typescript
// Response includes
{
  seal: {
    keys: [{
      sealKeyId: number,
      registrationStatus: string,
      hasActivePendingOp: boolean,
    }]
  }
}
```

---

## LM Integration (Phase 6)

### 11. Vault Configuration Extension

**Current vault structure** (in `generate-vault.ts`):
```typescript
interface SealKeyVaultConfig {
  sealKeyId: number;
  publicKey: string;       // hex
  packages: string[];      // hex addresses of enabled packages
  isUserEnabled: boolean;
}
```

**Updated structure** (add `objectId` and `registrationStatus`):
```typescript
interface SealKeyVaultConfig {
  sealKeyId: number;
  publicKey: string;       // hex (BLS12-381 G1 point)
  objectId: string | null; // hex (Sui object ID), null if not registered
  registrationStatus: 'registering' | 'registered' | 'updating';
  packages: string[];      // hex addresses of enabled packages
  isUserEnabled: boolean;
}
```

**Changes needed in `generate-vault.ts`:**
```typescript
// Current query (line ~534):
const sealKeysData = await db
  .select({
    sealKeyId: sealKeys.sealKeyId,
    publicKey: sealKeys.publicKey,
    isUserEnabled: sealKeys.isUserEnabled,
  })
  .from(sealKeys)
  .where(eq(sealKeys.instanceId, service.instanceId));

// Updated query (add objectId and registrationStatus):
const sealKeysData = await db
  .select({
    sealKeyId: sealKeys.sealKeyId,
    publicKey: sealKeys.publicKey,
    objectId: sealKeys.objectId,                    // NEW
    registrationStatus: sealKeys.registrationStatus, // NEW
    isUserEnabled: sealKeys.isUserEnabled,
  })
  .from(sealKeys)
  .where(eq(sealKeys.instanceId, service.instanceId));

// Include in vault config:
sealKeysConfig.push({
  sealKeyId: sk.sealKeyId,
  publicKey: Buffer.from(sk.publicKey).toString('hex'),
  objectId: sk.objectId ? Buffer.from(sk.objectId).toString('hex') : null,  // NEW
  registrationStatus: sk.registrationStatus,  // NEW
  packages: packages.map((p) => Buffer.from(p.packageAddress).toString('hex')),
  isUserEnabled: sk.isUserEnabled,
});
```

### 12. LM Config Generation

**Flow:**
1. GM generates vault with seal keys including `objectId` and `registrationStatus`
2. Vault synced to LM via `sync-files.py` (existing infrastructure)
3. LM reads vault from `/opt/syncf/data/sma/` directory
4. LM generates `key-server-config.yaml` for seal-server process

**LM processing rules:**
- **`registrationStatus === 'registered'`**: Include key in seal-server config
- **`registrationStatus === 'registering'`**: Skip key, log info (still being registered)
- **`registrationStatus === 'updating'`**: Include key (objectId is valid, just updating packages)
- **`objectId === null`**: Skip key, log warning (should not happen for 'registered' status)

**key-server-config.yaml format** (seal-server expects):
```yaml
# Auto-generated by LM - DO NOT EDIT
keys:
  - object_id: "0x1234567890abcdef..."    # 64 hex chars
    public_key: "0xabcdef..."             # 96 hex chars (BLS12-381 G1)
    packages:
      - "0xaaa..."                         # Package address 1
      - "0xbbb..."                         # Package address 2
  - object_id: "0x9876543210fedcba..."
    public_key: "0xfedcba..."
    packages:
      - "0xccc..."
```

**LM reports applied status:**
- After updating `key-server-config.yaml` and reloading seal-server
- Reports `appliedSeq` via `/api/health` endpoint
- GM polls this to determine sync completion

### 13. Sync Status for UI

**Important:** Seal key registration does NOT use `smaConfigChangeVaultSeq` pattern.

The `smaConfigChangeVaultSeq` pattern is used for service-level config changes (IP allowlist, burst limits) where we need to track "pending" vs "synced" per-service.

For seal keys, the tracking is different:
- `registrationStatus` on the key itself shows registration progress
- `objectId` presence indicates successful Sui registration
- Vault sync status is implicit (keys in vault = keys LM will configure)

The UI shows:
- `registrationStatus === 'registering'` → "Registering..." (Sui tx in progress)
- `registrationStatus === 'registered'` → "Registered" (Sui tx complete)
- `registrationStatus === 'updating'` → "Updating..." (package change in progress)

This is separate from HAProxy sync status which is tracked per-service.

---

## Implementation Plan

> **Existing Infrastructure (leveraged, not modified):**
> - `markConfigChanged()` + `triggerVaultSync()` pattern for HAProxy config sync
> - GM vault generation (`generate-vault.ts`) - extended with new fields
> - LM vault consumption and config application
> - `sync-files.py` for vault distribution to remote servers
> - `@walrus/system-config` package - extended with PG support
> - `@walrus/vault-codec` for encrypted vault storage
>
> **New Infrastructure (built by this plan):**
> - Process group config and master seed vaults (Phase -1)
> - Per-PG derivation index counters (Phase 0)
> - Registration state machine in `seal_keys` schema (Phase 1)
> - Mock Sui transaction service (Phase 2)
> - GM registration processor task (Phase 3)
> - Auto-registration in API mutations (Phase 4)
> - UI status display (Phase 5)
> - LM seal-server config generation (Phase 6)

### Phase -1: Process Group Infrastructure (PREREQUISITE)
**Must be done first - all other phases depend on correct PG selection**

1. Add `SEAL_PROCESS_GROUP` to `system.conf`:
   - Dev box: `SEAL_PROCESS_GROUP=2`
   - Production: `SEAL_PROCESS_GROUP=1`
2. Add `getSealProcessGroup()` to `@walrus/system-config` package
3. Create master key vault generation script (`scripts/bootstrap-master-key.ts`)
4. Add `getMasterSeed(network, pg)` function to load PG-specific master seed
5. Update `generateSealKey()` to accept master seed and process group params
6. Add `processGroup` column to `seal_keys` table schema
7. Replace all hardcoded `pg: 1` with `getSealProcessGroup()`:
   - `apps/api/src/lib/api-keys.ts` (line ~281)
   - `services/global-manager/src/tasks/generate-vault.ts`
8. Bootstrap master keys for dev environment (PG 2)

### Phase 0: CRITICAL BUG FIX - Per-PG Derivation Index
**Must be done after Phase -1 - blocks all other work**

1. Add `nextSealDerivationIndexPg1` and `nextSealDerivationIndexPg2` columns to `system_control` table
2. Check for existing derivation index collisions:
   ```sql
   SELECT derivation_index, process_group, COUNT(*) FROM seal_keys
   WHERE derivation_index IS NOT NULL
   GROUP BY derivation_index, process_group
   HAVING COUNT(*) > 1;
   ```
3. Initialize counters per PG:
   ```sql
   UPDATE system_control SET
     next_seal_derivation_index_pg1 = (
       SELECT COALESCE(MAX(derivation_index), -1) + 1
       FROM seal_keys WHERE process_group = 1
     ),
     next_seal_derivation_index_pg2 = (
       SELECT COALESCE(MAX(derivation_index), -1) + 1
       FROM seal_keys WHERE process_group = 2
     );
   ```
4. Fix `createKey` to use atomic per-PG counter
5. Add `deletedAt` field to `seal_keys` schema
6. Add `deleteKey` procedure (blocked in production via `isProduction()`)

### Phase 1: Database - Registration State Machine
1. Add migration for new fields on `seal_keys` table (`registrationStatus`, `registrationError`, `nextRetryAt`, etc.)
2. Add `seal_registration_ops` table
3. Add `registrationStatusEnum` to schema
4. Update drizzle relations and index exports

### Phase 2: Mock Sui Service
1. Create `SuiTransactionService` class with interface
2. Implement mock with 2-second delay
3. Add deterministic ID generation (hash-based for test reproducibility)
4. Add configurable failure rate for testing

### Phase 3: GM Registration Processor
1. Add `process-seal-registrations.ts` task
2. Implement exponential backoff retry logic
3. Add `recoverStaleOps()` function for self-healing
4. Integrate with task queue via `setupSealRegistrationTasks()`:
   - Run `recoverStaleOps()` on GM startup
   - Schedule `processSealRegistrations` every 5 seconds
   - Schedule `recoverStaleOps` every 5 minutes
5. Add logging for monitoring retries

### Phase 4: API Layer - Auto Registration
1. Modify `createKey` to auto-queue registration op (in same transaction as index allocation)
2. Add `getRegistrationStatus` query procedure
3. Modify `addPackage`/`updatePackage`/`deletePackage`/`togglePackage` to auto-queue updates
4. Add deduplication logic for rapid package changes

### Phase 5: UI Updates
1. Add status badges to `SealKeysSection` (registering/registered/updating)
2. Update `listKeys` response to include registration status
3. Add disabled states during operations
4. Add retry info tooltip display

### Phase 6: LM Integration
1. Update `generate-vault.ts` to include `objectId` and `registrationStatus` in SealKeyVaultConfig
2. Update LM to process vault and generate `key-server-config.yaml`
3. Add validation: only keys with `registrationStatus === 'registered'` get included in seal-server config
4. Test full flow: key creation → Sui registration → vault sync → LM config update
3. Add validation: only keys with `objectId` get production config

---

## Testing Strategy

### Unit Tests
- State machine transitions
- Mock Sui service responses
- Registration op creation

### API Tests
- `registerKey` procedure
- Status tracking queries
- Concurrent operation handling

### E2E Tests
- Full registration flow with mock delay
- UI status updates during registration
- Error handling and retry flow

### Integration Tests
- GM processor with mock Sui
- Vault generation with registered keys
- LM config updates

---

## Critical Files to Modify

### Phase -1: Process Group Infrastructure
| File | Changes |
|------|---------|
| `system.conf` | Add `SEAL_PROCESS_GROUP=2` (dev) or `=1` (prod) |
| `packages/system-config/src/index.ts` | Add `getSealProcessGroup()` export |
| `apps/api/src/lib/master-keys.ts` | **NEW:** `getMasterSeed(network, pg)` to load from smm/stm vault |
| `apps/api/src/lib/api-keys.ts` | Replace hardcoded `pg: 1` with `getSealProcessGroup()` |
| `services/global-manager/src/tasks/generate-vault.ts` | Replace hardcoded `pg: 1` with `getSealProcessGroup()` |
| `packages/database/src/schema/seal.ts` | Add `processGroup` column |
| `scripts/bootstrap-master-key.ts` | **NEW:** One-time master key generation script |

### Phase 0+: Registration State Machine
| File | Changes |
|------|---------|
| `packages/database/src/schema/seal.ts` | New enum, new fields (`registrationStatus`, `deletedAt`), new table (`sealRegistrationOps`) |
| `packages/database/src/schema/system-control.ts` | Add `nextSealDerivationIndexPg1`, `nextSealDerivationIndexPg2` counters |
| `apps/api/src/routes/seal.ts` | **FIX BUG:** Per-PG index allocation in `createKey`, add `deleteKey` procedure, auto-queue registration |
| `apps/api/src/lib/sui-transaction-service.ts` | **NEW:** Mock Sui transactions |
| `services/global-manager/src/tasks/process-seal-registrations.ts` | **NEW:** GM registration processor |
| `services/global-manager/src/task-queue.ts` | Add registration task to periodic processing |
| `apps/webapp/src/components/services/SealKeysSection.tsx` | Status display (registering/registered/updating) |

### Phase 6: LM Integration
| File | Changes |
|------|---------|
| `services/global-manager/src/tasks/generate-vault.ts` | Add `objectId`, `registrationStatus` to SealKeyVaultConfig |
| `services/local-manager/src/tasks/process-vault.ts` | Parse seal keys, generate `key-server-config.yaml` |
| LM seal-server config generator | **NEW:** Transform vault data to seal-server YAML format |

---

## Verification Plan

### Manual Testing
1. Create a seal key → verify status shows "Registering..." → wait 2s → verify "Registered" with object ID
2. Add a package to registered key → verify status shows "Updating..." → wait 2s → verify "Registered"
3. Simulate failure (mock service) → verify exponential backoff (check `nextRetryAt` increases)
4. Verify UI disables edit/delete during registering/updating states

### Automated Testing
1. **Unit tests:** State machine transitions, backoff calculation, mock service
2. **API tests:** `createKey` + op creation, `getRegistrationStatus`, package change triggers
3. **E2E tests:** Full flow with 2-second delays, UI state transitions

### Monitoring
- Log all registration attempts with timing info
- Track retry counts per key for alerting on persistent failures
- GM health endpoint should report pending ops count

