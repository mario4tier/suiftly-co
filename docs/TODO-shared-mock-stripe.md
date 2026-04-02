# TODO: Shared Mock Stripe State (DB-backed)

## Problem

The `MockStripeService` uses in-memory state (Maps). The API server and Global Manager each have their own instance, so mock Stripe state (customers, payment methods, setup intents) is NOT shared between them.

**Impact**: When a user adds a credit card via the API server's mock, the GM's mock doesn't see it. The GM's `sync-customer` retry (triggered by webhook after adding a card) fails silently because the GM's mock has no payment method on file.

In production with real Stripe, both processes share the same Stripe API — no issue. This is a **dev/test-only** problem that causes flaky test behavior and confusing manual testing.

## Solution

Refactor `MockStripeService` to store state in PostgreSQL, matching the pattern already used by `MockSuiService`.

## Pattern to Follow

`MockSuiService` (`packages/database/src/sui-mock/mock.ts`) already does this:
- Uses `AsyncLocalStorage<DatabaseOrTransaction>` for DB context (`activeDb`)
- Stores balance/state in `customers` table columns
- Records transactions in `mock_sui_transactions` table
- Exposes `withActiveDb()` for transaction context injection

## Implementation Steps

### 1. Create DB tables in `packages/database/src/schema/mock.ts`

Add alongside existing `mockSuiTransactions`:

```typescript
// Mock Stripe customers (payment methods, setup intents)
export const mockStripeCustomers = pgTable('mock_stripe_customers', {
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }).primaryKey(),
  customerId: integer('customer_id').notNull(),
  walletAddress: varchar('wallet_address', { length: 66 }).notNull(),
  defaultPaymentMethodId: varchar('default_payment_method_id', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Mock Stripe payment methods (cards)
export const mockStripePaymentMethods = pgTable('mock_stripe_payment_methods', {
  id: varchar('id', { length: 100 }).primaryKey(), // pm_mock_xxx
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }).notNull(),
  brand: varchar('brand', { length: 20 }).notNull().default('visa'),
  last4: varchar('last4', { length: 4 }).notNull().default('4242'),
  expMonth: integer('exp_month').notNull().default(12),
  expYear: integer('exp_year').notNull().default(2027),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Mock Stripe setup intents
export const mockStripeSetupIntents = pgTable('mock_stripe_setup_intents', {
  setupIntentId: varchar('setup_intent_id', { length: 100 }).primaryKey(),
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }).notNull(),
  paymentMethodId: varchar('payment_method_id', { length: 100 }).notNull(),
  clientSecret: varchar('client_secret', { length: 200 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Mock Stripe idempotency cache (charge results)
export const mockStripeIdempotency = pgTable('mock_stripe_idempotency', {
  idempotencyKey: varchar('idempotency_key', { length: 200 }).primaryKey(),
  result: jsonb('result').notNull(), // StripeChargeResult serialized
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### 2. Refactor `packages/database/src/stripe-mock/mock.ts`

- Add `AsyncLocalStorage` context (copy pattern from `sui-mock/mock.ts`)
- Replace all `this.customers` Map operations with DB queries on `mockStripeCustomers` + `mockStripePaymentMethods`
- Replace `this.idempotencyCache` Map with `mockStripeIdempotency` table
- Replace `this.setupIntents` Map with `mockStripeSetupIntents` table
- Add `withActiveDb()` method
- Keep `reset()` method but make it truncate the mock tables instead of clearing Maps
- Use sequence counters from DB (or UUID/random IDs) instead of in-memory counters

### 3. Generate migration

```bash
cd packages/database && npx drizzle-kit generate --name mock_stripe_tables
```

### 4. Export tables from schema

Add the new tables to `packages/database/src/schema/index.ts` exports.

### 5. Update `reset()` / test cleanup

Update `cleanupCustomerData` in `packages/database/src/billing/test-helpers.ts` to also clean mock Stripe tables.

### 6. Update `reset-database.sh` grants

The `deploy` user needs SELECT/INSERT/UPDATE/DELETE on the new mock tables (dev only).

## Files to Modify

| File | Change |
|------|--------|
| `packages/database/src/schema/mock.ts` | Add 4 new tables |
| `packages/database/src/schema/index.ts` | Export new tables |
| `packages/database/src/stripe-mock/mock.ts` | Rewrite to use DB |
| `packages/database/src/billing/test-helpers.ts` | Clean mock Stripe in cleanup |
| `packages/database/migrations/` | New migration (drizzle-kit generate) |

## Verification

After refactoring:
1. Run `./scripts/dev/reset-database.sh`
2. Start servers with `./scripts/dev/start-dev.sh`
3. Subscribe to a service (creates Stripe customer + payment intent in DB)
4. Add a credit card (creates payment method in DB)
5. Trigger GM sync-customer — should now see the payment method and retry successfully
6. Run full test suite — existing tests should pass since the interface is unchanged
