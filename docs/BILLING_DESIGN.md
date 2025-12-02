# Billing Design

## Overview

Billing system for Suiftly infrastructure services:
- Subscription charges (monthly base fees)
- Usage charges (per-request, see [STATS_DESIGN.md](./STATS_DESIGN.md))
- Crypto escrow payments (MVP), Stripe fiat (Phase 3)

**Related:** [TIME_DESIGN.md](./TIME_DESIGN.md), [STATS_DESIGN.md](./STATS_DESIGN.md), [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md)

---

## Charge Types

| Type | Trigger | Timing |
|------|---------|--------|
| **Subscription** | Subscribe, resume, tier change | Immediate + Monthly 1st |
| **Usage** | Request metering | Threshold ($5) or monthly |
| **Add-on** | Config change (Seal keys, packages) | Immediate (prepay + reconcile) |
| **Refund** | Billing error | Added to withdrawable balance |
| **Credit** | Compensation, promo | Non-withdrawable, spend on Suiftly only |

## Billing Model: Prepay + Reconcile

All subscriptions bill on **1st of month**. Mid-month signups pay full rate upfront, credit applied on next invoice.

| Event | Charge |
|-------|--------|
| First subscribe | Full monthly rate (immediate) |
| First 1st-of-month | Adjusted (credit for partial month) |
| Tier upgrade | Pro-rated: `(new - old) × (days_remaining / days_in_month)` |
| Tier downgrade | No charge, takes effect end of cycle |
| Cancellation | No refund, service continues until period end |

**Grace period:** If `days_remaining ≤ 2`, upgrade charge = $0.

**Reconciliation credit:** `credit = amount_paid × (days_not_used / days_in_month)`

## Payment Sources (MVP)

1. **Credits** (oldest expiring first) - non-withdrawable
2. **Escrow** (crypto balance) - on-chain USDC

Phase 3: Stripe fiat fallback.

**Spending order:** Credits first → Escrow → Stripe

## Insufficient Balance Handling

| Condition | Behavior |
|-----------|----------|
| `paid_once = FALSE` | Per-service handling only, no grace period |
| `paid_once = TRUE` | 14-day grace period → account suspension |

Grace period tracked via `customers.grace_period_start`.

---

## Invoice States

```
DRAFT → PENDING → PAID/FAILED/VOIDED
```

| State | Description |
|-------|-------------|
| `draft` | Pre-computed projection for next billing cycle |
| `pending` | Ready for payment (may be partially paid) |
| `paid` | Fully paid |
| `failed` | Charge failed (retryable) |
| `voided` | Cancelled |

**One DRAFT per customer max.** Updated atomically on config changes.

---

## Tier Changes & Cancellation

### Upgrade (Immediate)
- Pro-rated charge for remaining days
- Payment required for activation
- Function: `handleTierUpgrade()`

### Downgrade (Scheduled)
- Takes effect 1st of next month
- Reversible via `cancelScheduledTierChange()`
- Fields: `scheduled_tier`, `scheduled_tier_effective_date`

### Cancellation
- Service continues until period end
- 7-day `cancellation_pending` state after period ends
- 7-day cooldown before re-provisioning allowed
- Function: `scheduleCancellation()`, `undoCancellation()`

### Key Operation Blocking
- Seal key generate/import blocked until `paidOnce = true`
- Function: `canPerformKeyOperation()`

---

## Concurrency Control

### Customer-Level Advisory Locks

Write operations that modify billing state acquire a customer-level PostgreSQL advisory lock:

```sql
SELECT pg_advisory_xact_lock(customer_id::bigint);
```

**Lock timeout:** 10 seconds (throws error if not acquired).

**Lock scope:** Transaction-scoped (`pg_advisory_xact_lock`) - auto-releases on commit/rollback.

### When Locks Are Required

Locks prevent race conditions between the **API Server** and **Global Manager**:

| Operation | Lock? | Reason |
|-----------|-------|--------|
| Read invoice/service state | NO | MVCC provides consistent snapshot |
| `handleSubscriptionBilling()` | YES | Creates invoice + charges |
| `handleTierUpgrade()` | YES | Charges + updates service |
| `scheduleTierDowngrade()` | YES | Read-modify-write pattern |
| `scheduleCancellation()` | YES | Read-modify-write pattern |
| `undoCancellation()` | YES | Updates service + recalculates DRAFT |
| `cancelScheduledTierChange()` | YES | Read-modify-write pattern |
| `processCustomerBilling()` | YES | Multi-step monthly billing |
| `processServiceDeletion()` | YES | Deletes service + records history |

### Design Principle: Minimize API Server Locks

**Read-only operations NEVER need locks** - PostgreSQL MVCC guarantees consistent reads.

**API Server** should minimize lock usage:
- Dashboard reads: No lock (query directly)
- Invoice preview: No lock (read-only calculation)
- State changes: Lock required (via `withCustomerLock()`)

**Global Manager** always uses locks for batch processing.

### Lock Contention

If API request hits lock timeout (Global Manager processing same customer):
- Return HTTP 409 Conflict with retry message
- User can retry in a few seconds

### Re-entrancy Prevention

PostgreSQL advisory locks are **NOT re-entrant** within the same session:

```sql
SELECT pg_advisory_xact_lock(123);  -- Acquires lock
SELECT pg_advisory_xact_lock(123);  -- DEADLOCKS! (waits for itself forever)
```

**Solution: `LockedTransaction` branded type**

```typescript
// Type signals: "lock is already held, don't acquire again"
export type LockedTransaction = DatabaseOrTransaction & { readonly __brand: 'LockedTransaction' };

// Entry point: acquires lock, passes LockedTransaction
export async function withCustomerLock<T>(
  db: Database,
  customerId: number,
  fn: (tx: LockedTransaction) => Promise<T>
): Promise<T>;

// Internal function: accepts LockedTransaction, NEVER calls withCustomerLock
async function updateInvoiceInternal(tx: LockedTransaction, invoiceId: string): Promise<void>;
```

**Rules:**
1. Functions taking `LockedTransaction` must NEVER call `withCustomerLock()`
2. Functions taking `DatabaseOrTransaction` are lock-agnostic (can be called with or without lock)
3. Only API route handlers and Global Manager entry points should call `withCustomerLock()`

**TypeScript enforces this**: If a function accidentally tries to pass `LockedTransaction` to `withCustomerLock()`, it will compile but the brand signals intent to developers reviewing code.

---

## Database Schema

### Core Tables
- `billing_records` - Invoices (status: draft/pending/paid/failed/voided)
- `invoice_line_items` - Itemized charges
- `invoice_payments` - Multi-source payment tracking
- `customer_credits` - Off-chain non-withdrawable credits
- `escrow_transactions` - On-chain transactions
- `billing_idempotency` - Prevent double-billing
- `service_cancellation_history` - Anti-abuse cooldown

### Key Fields on `customers`
- `paid_once` - Grace period eligibility
- `grace_period_start` - When grace period started
- `spending_limit_usd_cents` - 28-day cap
- `current_balance_usd_cents` - Escrow balance

### Key Fields on `service_instances`
- `paid_once` - Service-level payment tracking
- `subscription_charge_pending` - Awaiting first payment
- `scheduled_tier`, `scheduled_tier_effective_date` - Downgrade
- `cancellation_scheduled_for`, `cancellation_effective_at` - Cancellation

---

## Unified Periodic Job

**Function:** `runPeriodicBillingJob()` - Every 5 minutes in production

**Phases:**
1. Monthly billing (1st only): Apply tier changes → Process cancellations → DRAFT→PENDING → Charge
2. Payment retries (failed invoices)
3. Grace period expiration (→ suspension)
4. Cancellation cleanup (7+ days in `cancellation_pending`)
5. Housekeeping (clean old idempotency/history records)

**Test endpoint:** `POST /test/billing/run-periodic-job`

---

## Implementation Status

| Phase | Status | Location |
|-------|--------|----------|
| 1A: Time abstraction | ✅ Complete | `@suiftly/shared/db-clock` |
| 1B: Billing processor | ✅ Complete | `packages/database/src/billing/processor.ts` |
| 1C: Tier changes | ✅ Complete | `packages/database/src/billing/tier-changes.ts` |
| Periodic job | ✅ Complete | `packages/database/src/billing/periodic-job.ts` |
| Service billing | ✅ Complete | `packages/database/src/billing/service-billing.ts` |
| Usage metering | ❌ Pending | See [STATS_DESIGN.md](./STATS_DESIGN.md) |
| Stripe integration | ❌ Phase 3 | — |
| Tax compliance | ❌ Post-MVP | — |

---

## Key Functions Reference

| Function | File | Purpose |
|----------|------|---------|
| `runPeriodicBillingJob()` | periodic-job.ts | Main entry point |
| `processBilling()` | processor.ts | Per-customer billing |
| `applyCreditsToInvoice()` | credits.ts | Credit application |
| `handleTierUpgrade()` | tier-changes.ts | Immediate upgrade |
| `scheduleTierDowngrade()` | tier-changes.ts | Schedule downgrade |
| `scheduleCancellation()` | tier-changes.ts | Schedule cancel |
| `handleSubscriptionBilling()` | service-billing.ts | First-month charge |
| `recalculateDraftInvoice()` | service-billing.ts | Update DRAFT |
| `withCustomerLock()` | locking.ts | Advisory lock wrapper |

---

## Missing for MVP

1. **Usage metering integration** - See [STATS_DESIGN.md](./STATS_DESIGN.md)
2. **Invoice history API** - `/billing/invoices` endpoints

---

**Version:** 3.0
**Last Updated:** 2025-01-28
