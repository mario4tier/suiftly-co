# Database Enum Implementation Guide

## Overview

This document describes the single source of truth approach for enumerations in the Suiftly platform, using PostgreSQL native ENUMs as the authoritative source with TypeScript type inference.

## Design Principles

1. **PostgreSQL ENUM as Source of Truth**: Database schema defines all enumeration values
2. **Type Safety**: TypeScript types automatically inferred from database schema via Drizzle ORM
3. **No Duplication**: Avoid maintaining separate constant definitions and database constraints
4. **Migration Safety**: Enum changes are versioned and trackable through migrations
5. **Runtime Validation**: Zod schemas derive from the same types for request validation

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ PostgreSQL Database                                          │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ CREATE TYPE customer_status AS ENUM (                   │ │
│ │   'active', 'suspended', 'closed'                       │ │
│ │ );                                                       │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Drizzle ORM reads schema
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Drizzle Schema (packages/database/src/schema/*.ts)          │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ export const customerStatusEnum = pgEnum(                │ │
│ │   'customer_status',                                     │ │
│ │   ['active', 'suspended', 'closed']                     │ │
│ │ );                                                       │ │
│ │                                                          │ │
│ │ export const customers = pgTable('customers', {          │ │
│ │   status: customerStatusEnum('status').notNull()         │ │
│ │ });                                                      │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Type inference
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ TypeScript Types (auto-generated)                           │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ type CustomerStatus =                                    │ │
│ │   typeof customerStatusEnum.enumValues[number]           │ │
│ │ // Result: 'active' | 'suspended' | 'closed'            │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Used in validation
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Zod Schemas (packages/shared/src/schemas/*.ts)              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ import { customerStatusEnum } from '@suiftly/database';  │ │
│ │                                                          │ │
│ │ export const customerStatusSchema = z.enum(              │ │
│ │   customerStatusEnum.enumValues                          │ │
│ │ );                                                       │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Runtime validation
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ API/Frontend (apps/api, apps/webapp)                        │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ // Type-safe constants object                           │ │
│ │ export const CUSTOMER_STATUS = {                         │ │
│ │   ACTIVE: 'active',                                      │ │
│ │   SUSPENDED: 'suspended',                                │ │
│ │   CLOSED: 'closed'                                       │ │
│ │ } as const satisfies Record<string, CustomerStatus>;     │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Define PostgreSQL ENUMs in Drizzle Schema

**File**: `packages/database/src/schema/enums.ts` (new file)

```typescript
import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Database Enumerations - Single Source of Truth
 *
 * All enum types defined here and used across the schema.
 * These map to PostgreSQL ENUM types.
 */

// Customer status values
export const customerStatusEnum = pgEnum('customer_status', [
  'active',
  'suspended',
  'closed'
]);

// Service types
export const serviceTypeEnum = pgEnum('service_type', [
  'seal',
  'grpc',
  'graphql'
]);

// Service states (7 distinct states)
export const serviceStateEnum = pgEnum('service_state', [
  'not_provisioned',
  'provisioning',
  'disabled',
  'enabled',
  'suspended_maintenance',
  'suspended_no_payment',
  'cancellation_pending'  // 7-day grace period after billing period ends
]);

// Service tiers
export const serviceTierEnum = pgEnum('service_tier', [
  'starter',
  'pro',
  'enterprise'
]);

// Transaction types
export const transactionTypeEnum = pgEnum('transaction_type', [
  'deposit',
  'withdraw',
  'charge',
  'credit'
]);

// Billing status (invoice lifecycle states)
export const billingStatusEnum = pgEnum('billing_status', [
  'draft',    // Pre-computed projection for next billing cycle
  'pending',  // Ready for payment processing
  'paid',     // Fully paid
  'failed',   // Charge attempt failed
  'voided'    // Cancelled (billing error, etc.)
]);

// Billing type (distinguishes invoice creation context)
export const billingTypeEnum = pgEnum('billing_type', [
  'immediate', // Mid-cycle charges (upgrades, first subscription) - void on failure
  'scheduled'  // Monthly billing (from DRAFT) - retry until paid
]);

// Invoice line item types (semantic categorization of invoice charges)
export const invoiceLineItemTypeEnum = pgEnum('invoice_line_item_type', [
  'subscription_starter',
  'subscription_pro',
  'subscription_enterprise',
  'tier_upgrade',
  'requests',
  'extra_api_keys',
  'extra_seal_keys',
  'extra_allowlist_ips',
  'extra_packages',
  'credit',
  'tax'
]);

// Export TypeScript types derived from enums
export type CustomerStatus = typeof customerStatusEnum.enumValues[number];
export type ServiceType = typeof serviceTypeEnum.enumValues[number];
export type ServiceState = typeof serviceStateEnum.enumValues[number];
export type ServiceTier = typeof serviceTierEnum.enumValues[number];
export type TransactionType = typeof transactionTypeEnum.enumValues[number];
export type BillingStatus = typeof billingStatusEnum.enumValues[number];
export type BillingType = typeof billingTypeEnum.enumValues[number];
export type InvoiceLineItemType = typeof invoiceLineItemTypeEnum.enumValues[number];
```

### Step 2: Update Schema Files to Use ENUMs

**File**: `packages/database/src/schema/customers.ts`

```typescript
import { pgTable, integer, varchar, bigint, date, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { FIELD_LIMITS } from '@suiftly/shared/constants';
import { customerStatusEnum } from './enums';

export const customers = pgTable('customers', {
  customerId: integer('customer_id').primaryKey(),
  walletAddress: varchar('wallet_address', { length: FIELD_LIMITS.SUI_ADDRESS }).notNull().unique(),
  escrowContractId: varchar('escrow_contract_id', { length: FIELD_LIMITS.SUI_ADDRESS }),
  status: customerStatusEnum('status').notNull().default('active'),  // ← Changed to enum
  spendingLimitUsdCents: bigint('max_monthly_usd_cents', { mode: 'number' }),
  currentBalanceUsdCents: bigint('current_balance_usd_cents', { mode: 'number' }),
  currentPeriodChargedUsdCents: bigint('current_month_charged_usd_cents', { mode: 'number' }),
  : bigint('last_month_charged_usd_cents', { mode: 'number' }),
  currentPeriodStart: date('current_month_start'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  idxWallet: index('idx_wallet').on(table.walletAddress),
  idxCustomerStatus: index('idx_customer_status').on(table.status).where(sql`${table.status} != 'active'`),
  checkCustomerId: check('check_customer_id', sql`${table.customerId} != 0`),
  // Note: check_status constraint removed - ENUM type provides validation
}));
```

**File**: `packages/database/src/schema/services.ts`

```typescript
import { pgTable, serial, integer, boolean, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { serviceTypeEnum, serviceStateEnum, serviceTierEnum } from './enums';

export const serviceInstances = pgTable('service_instances', {
  instanceId: serial('instance_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),  // ← Changed to enum
  state: serviceStateEnum('state').notNull().default('not_provisioned'),  // ← Changed to enum
  tier: serviceTierEnum('tier').notNull(),  // ← Changed to enum
  isUserEnabled: boolean('is_user_enabled').notNull().default(true),
  subscriptionChargePending: boolean('subscription_charge_pending').notNull().default(true),
  config: jsonb('config'),
  enabledAt: timestamp('enabled_at'),
  disabledAt: timestamp('disabled_at'),
}, (table) => ({
  uniqueCustomerService: unique().on(table.customerId, table.serviceType),
}));
```

### Step 3: Update Shared Constants

**File**: `packages/shared/src/constants/index.ts`

```typescript
// Re-export enum types from database package
export type {
  CustomerStatus,
  ServiceType,
  ServiceState,
  ServiceTier,
  TransactionType,
  BillingStatus
} from '@suiftly/database/schema/enums';

// Import for creating constants objects
import type {
  CustomerStatus,
  ServiceType,
  ServiceState,
  ServiceTier,
  TransactionType,
  BillingStatus
} from '@suiftly/database/schema/enums';

/**
 * Constants objects for convenient access
 * These are derived from database enums to ensure consistency
 */

export const CUSTOMER_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CLOSED: 'closed',
} as const satisfies Record<string, CustomerStatus>;

export const SERVICE_TYPE = {
  SEAL: 'seal',
  GRPC: 'grpc',
  GRAPHQL: 'graphql',
} as const satisfies Record<string, ServiceType>;

export const SERVICE_STATE = {
  NOT_PROVISIONED: 'not_provisioned',
  PROVISIONING: 'provisioning',
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  SUSPENDED_MAINTENANCE: 'suspended_maintenance',
  SUSPENDED_NO_PAYMENT: 'suspended_no_payment',
} as const satisfies Record<string, ServiceState>;

export const SERVICE_TIER = {
  STARTER: 'starter',
  PRO: 'pro',
  ENTERPRISE: 'enterprise',
} as const satisfies Record<string, ServiceTier>;

export const TRANSACTION_TYPE = {
  DEPOSIT: 'deposit',
  WITHDRAW: 'withdraw',
  CHARGE: 'charge',
  CREDIT: 'credit',
} as const satisfies Record<string, TransactionType>;

export const BILLING_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  VOIDED: 'voided',
} as const satisfies Record<string, BillingStatus>;

export const INVOICE_LINE_ITEM_TYPE = {
  SUBSCRIPTION_STARTER: 'subscription_starter',
  SUBSCRIPTION_PRO: 'subscription_pro',
  SUBSCRIPTION_ENTERPRISE: 'subscription_enterprise',
  TIER_UPGRADE: 'tier_upgrade',
  REQUESTS: 'requests',
  EXTRA_API_KEYS: 'extra_api_keys',
  EXTRA_SEAL_KEYS: 'extra_seal_keys',
  EXTRA_ALLOWLIST_IPS: 'extra_allowlist_ips',
  EXTRA_PACKAGES: 'extra_packages',
  CREDIT: 'credit',
  TAX: 'tax',
} as const satisfies Record<string, InvoiceLineItemType>;

// Other constants remain unchanged
export const SPENDING_LIMIT = {
  DEFAULT_USD: 250,
  MINIMUM_USD: 10,
  MAXIMUM_USD: null,
  PERIOD_DAYS: 28,
  PERIOD_MS: 28 * 24 * 60 * 60 * 1000,
} as const;

export const BALANCE_LIMITS = {
  MINIMUM_ACTIVE_SERVICES_USD: 50,
} as const;

export const FIELD_LIMITS = {
  SUI_ADDRESS: 66,
  SUI_TX_DIGEST: 64,
  SUI_PUBLIC_KEY: 66,
  API_KEY_ID: 150,
  AUTH_NONCE: 64,
  TOKEN_HASH: 64,
  SERVICE_TYPE: 20,
  SERVICE_STATE: 30,
  SERVICE_TIER: 20,
  CUSTOMER_STATUS: 20,
  TRANSACTION_TYPE: 20,
  BILLING_STATUS: 20,
  PACKAGE_NAME: 100,
  INVOICE_ID: 50,
  VAULT_VERSION: 64,
} as const;
```

### Step 4: Update Zod Validation Schemas

**File**: `packages/shared/src/schemas/customer.ts`

```typescript
import { z } from 'zod';
import { customerStatusEnum } from '@suiftly/database/schema/enums';
import { SPENDING_LIMIT } from '../constants';

/**
 * Customer validation schemas
 * Derive enums from database schema for consistency
 */

// Sui wallet address validation (0x + 64 hex chars)
export const walletAddressSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid Sui wallet address format');

// Customer status enum - derived from database
export const customerStatusSchema = z.enum(customerStatusEnum.enumValues);

// 28-day spending limit validation
export const spendingLimitSchema = z.number()
  .int()
  .min(SPENDING_LIMIT.MINIMUM_USD * 100, `Minimum spending limit is $${SPENDING_LIMIT.MINIMUM_USD}`)
  .nullable();

// Complete customer schema
export const customerSchema = z.object({
  customerId: z.number().int().positive(),
  walletAddress: walletAddressSchema,
  escrowContractId: z.string().regex(/^0x[a-fA-F0-9]{64}$/).nullable().optional(),
  status: customerStatusSchema,
  spendingLimitUsdCents: spendingLimitSchema.nullable().optional(),
  currentBalanceUsdCents: z.number().int().nonnegative().nullable().optional(),
  currentPeriodChargedUsdCents: z.number().int().nonnegative().nullable().optional(),
  : z.number().int().nonnegative().nullable().optional(),
  currentPeriodStart: z.string().date().nullable().optional(),
  createdAt: z.date().or(z.string().datetime()),
  updatedAt: z.date().or(z.string().datetime()),
});

// Insert/update schemas remain the same
export const customerInsertSchema = customerSchema.omit({
  createdAt: true,
  updatedAt: true,
});

export const customerUpdateSchema = customerSchema.partial().required({
  customerId: true,
});

export const customerPublicSchema = customerSchema.pick({
  customerId: true,
  walletAddress: true,
  status: true,
  currentBalanceUsdCents: true,
  spendingLimitUsdCents: true,
  currentPeriodChargedUsdCents: true,
  : true,
});
```

### Step 5: Export ENUMs from Database Package

**File**: `packages/database/src/schema/index.ts`

```typescript
// Export all table schemas
export * from './customers';
export * from './services';
export * from './api_keys';
export * from './auth';
export * from './seal';
export * from './escrow';
export * from './usage';
export * from './system';
export * from './logs';

// Export enums and types
export * from './enums';
```

**File**: `packages/database/src/index.ts`

```typescript
export * from './db';
export * from './schema';  // This now includes enums
export * from './activity-logger';
```

## Migration Strategy

### For New Databases (Greenfield)

Run migration generator to create ENUMs:

```bash
npm run db:generate
```

This will generate SQL like:

```sql
-- Create ENUM types
CREATE TYPE "customer_status" AS ENUM('active', 'suspended', 'closed');
CREATE TYPE "service_type" AS ENUM('seal', 'grpc', 'graphql');
CREATE TYPE "service_state" AS ENUM('not_provisioned', 'provisioning', 'disabled', 'enabled', 'suspended_maintenance', 'suspended_no_payment');
CREATE TYPE "service_tier" AS ENUM('starter', 'pro', 'enterprise');
CREATE TYPE "transaction_type" AS ENUM('deposit', 'withdraw', 'charge', 'credit');
CREATE TYPE "billing_status" AS ENUM('pending', 'paid', 'failed');

-- Alter tables to use ENUM types
ALTER TABLE "customers" ALTER COLUMN "status" TYPE "customer_status" USING "status"::"customer_status";
ALTER TABLE "service_instances" ALTER COLUMN "service_type" TYPE "service_type" USING "service_type"::"service_type";
ALTER TABLE "service_instances" ALTER COLUMN "state" TYPE "service_state" USING "state"::"service_state";
ALTER TABLE "service_instances" ALTER COLUMN "tier" TYPE "service_tier" USING "tier"::"service_tier";
-- ... etc for other tables
```

### For Existing Databases (Migration)

**IMPORTANT**: Since you're in early development and mentioned you can reset the database, the simplest approach is:

1. **Squash existing migrations** (you have the script):
   ```bash
   ./scripts/dev/squash-migrations.sh
   ```

2. **Update schema files** to use ENUMs (as shown above)

3. **Generate new migration**:
   ```bash
   npm run db:generate
   ```

4. **Reset database**:
   ```bash
   ./scripts/dev/reset-database.sh
   ```

This gives you a clean start with ENUMs as the foundation.

### For Production (Future)

If you need to migrate an existing production database:

1. Create ENUMs
2. Add new columns with ENUM types
3. Copy data from VARCHAR columns
4. Drop old VARCHAR columns
5. Rename new columns

Example migration:

```sql
-- Step 1: Create ENUM type
CREATE TYPE customer_status AS ENUM('active', 'suspended', 'closed');

-- Step 2: Add new column
ALTER TABLE customers ADD COLUMN status_new customer_status;

-- Step 3: Copy data (with validation)
UPDATE customers SET status_new = status::customer_status;

-- Step 4: Drop old column
ALTER TABLE customers DROP COLUMN status;

-- Step 5: Rename new column
ALTER TABLE customers RENAME COLUMN status_new TO status;

-- Step 6: Add NOT NULL and default
ALTER TABLE customers ALTER COLUMN status SET NOT NULL;
ALTER TABLE customers ALTER COLUMN status SET DEFAULT 'active';

-- Step 7: Drop old CHECK constraint (no longer needed)
ALTER TABLE customers DROP CONSTRAINT IF EXISTS check_status;
```

## Adding New Enum Values

When you need to add a new value to an existing ENUM:

```sql
-- PostgreSQL 12+ supports this
ALTER TYPE customer_status ADD VALUE 'archived';

-- Add at specific position (before/after)
ALTER TYPE customer_status ADD VALUE 'archived' AFTER 'closed';
```

**Important**:
- Can only add values, cannot remove or reorder
- Adding values is safe and non-blocking
- If you need to remove values, requires recreating the type (complex migration)

## Benefits of This Approach

### 1. Type Safety Everywhere

```typescript
// Database layer - type-safe
const customer = await db.select().from(customers).where(eq(customers.customerId, 123));
customer.status;  // Type: 'active' | 'suspended' | 'closed'

// API layer - type-safe
import { CUSTOMER_STATUS } from '@suiftly/shared/constants';
if (customer.status === CUSTOMER_STATUS.ACTIVE) {  // ✅ Type-safe
  // ...
}

// Validation layer - type-safe
const result = customerStatusSchema.parse('active');  // ✅ Passes
const error = customerStatusSchema.parse('invalid');  // ❌ Throws ZodError
```

### 2. Single Source of Truth

```
Database ENUM
    ↓
Drizzle Schema (pgEnum)
    ↓
TypeScript Types (inferred)
    ↓
Zod Schemas (validated)
    ↓
Constants Objects (convenient access)
```

### 3. Database-Level Validation

```sql
-- Invalid values rejected by PostgreSQL
INSERT INTO customers (customer_id, wallet_address, status)
VALUES (1, '0x...', 'invalid_status');
-- ERROR: invalid input value for enum customer_status: "invalid_status"
```

### 4. Migration Tracking

All enum changes are versioned in migrations:

```sql
-- migrations/0042_add_archived_status.sql
ALTER TYPE customer_status ADD VALUE 'archived';
```

### 5. No Duplication

**Before** (separate definitions):
- `CHECK` constraint in SQL
- Constant definition in TypeScript
- Zod enum values
- Manual sync required

**After** (single source):
- PostgreSQL ENUM type
- Everything else derives from it
- Impossible to get out of sync

## Testing

### Unit Tests

```typescript
import { customerStatusEnum } from '@suiftly/database/schema/enums';
import { CUSTOMER_STATUS } from '@suiftly/shared/constants';

describe('Customer Status Enum', () => {
  it('should have correct values', () => {
    expect(customerStatusEnum.enumValues).toEqual(['active', 'suspended', 'closed']);
  });

  it('should match constants', () => {
    expect(CUSTOMER_STATUS.ACTIVE).toBe('active');
    expect(CUSTOMER_STATUS.SUSPENDED).toBe('suspended');
    expect(CUSTOMER_STATUS.CLOSED).toBe('closed');
  });
});
```

### Integration Tests

```typescript
import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';

describe('Customer Status in Database', () => {
  it('should accept valid status values', async () => {
    await expect(
      db.insert(customers).values({
        customerId: 123,
        walletAddress: '0x...',
        status: 'active'  // ✅ Valid
      })
    ).resolves.not.toThrow();
  });

  it('should reject invalid status values', async () => {
    await expect(
      db.insert(customers).values({
        customerId: 124,
        walletAddress: '0x...',
        status: 'invalid' as any  // ❌ Invalid
      })
    ).rejects.toThrow(/invalid input value for enum/);
  });
});
```

## Best Practices

### ✅ DO

- Define all enums in `packages/database/src/schema/enums.ts`
- Use `pgEnum()` for database enum types
- Export TypeScript types using `typeof enumName.enumValues[number]`
- Derive Zod schemas from enum values
- Create constants objects with `satisfies` for type checking
- Document enum changes in migration files

### ❌ DON'T

- Use VARCHAR with CHECK constraints for enum-like fields
- Duplicate enum values in multiple places
- Hard-code enum values in API/frontend code
- Skip migrations when adding new enum values
- Remove enum values (requires complex migration)

## Performance Considerations

### Storage

- **VARCHAR(20)**: Variable length, ~21-24 bytes per value
- **ENUM**: Fixed internal integer (4 bytes), stored as OID reference
- **Savings**: ~80% reduction in storage for enum columns

### Indexing

- ENUMs are stored as integers internally
- Smaller indexes (4 bytes vs 20+ bytes)
- Faster comparisons (integer vs string)

### Query Performance

```sql
-- Both are fast, but ENUM uses integer comparison internally
SELECT * FROM customers WHERE status = 'active';

-- ENUM: Integer comparison (status_oid = 1)
-- VARCHAR: String comparison (status = 'active')
```

## Troubleshooting

### Issue: "Type does not exist"

**Cause**: Migration not applied or enum not created

**Solution**:
```bash
npm run db:generate  # Generate migration
npm run db:push      # Apply to dev database
```

### Issue: "Cannot add value to enum"

**Cause**: PostgreSQL transaction restrictions

**Solution**:
```sql
-- Run outside transaction
ALTER TYPE customer_status ADD VALUE 'new_value';
COMMIT;
```

### Issue: TypeScript type not updating

**Cause**: Build cache

**Solution**:
```bash
npm run build --force
# or
rm -rf node_modules/.cache
npm run build
```

## References

- [PostgreSQL ENUM Types](https://www.postgresql.org/docs/current/datatype-enum.html)
- [Drizzle ORM pgEnum](https://orm.drizzle.team/docs/column-types/pg#enum)
- [TypeScript satisfies operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
- [Zod Enums](https://zod.dev/?id=zod-enums)

---

**Document Version**: 1.1
**Last Updated**: 2025-12-04
**Status**: Implementation guide
**Changes**: Added billingTypeEnum, invoiceLineItemTypeEnum; updated billingStatusEnum and serviceStateEnum
