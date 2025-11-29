# Billing Design

## Overview

Billing system for Suiftly infrastructure services supporting:
- Subscription-based charges (monthly base fees)
- Usage-based charges (per-request pricing)
- Hybrid payment methods (crypto escrow + fiat)
- Tax compliance (post-MVP)

**Related Documents:**
- [TIME_DESIGN.md](./TIME_DESIGN.md) - UTC convention, DBClock abstraction, testing with time
- [ESCROW_DESIGN.md](./ESCROW_DESIGN.md) - On-chain escrow account (crypto path)
- [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md) - Database schema
- [UI_DESIGN.md](./UI_DESIGN.md) - Service states and pricing display
- [CONSTANTS.md](./CONSTANTS.md) - Spending limits and constants

---

## Requirements

### R1: Charge Types

| Type | Trigger | Frequency | Examples |
|------|---------|-----------|----------|
| **Subscription** | Service subscribe, resume, tier change | Immediate + Monthly | Pro tier $29/mo, Enterprise $185/mo |
| **Usage** | Request metering | Threshold or monthly | $1 per 10K requests |
| **Add-on** | Configuration change | Immediate + monthly | Extra Seal keys, packages, allowlist entries |
| **One-time** | User action | Immediate | Future: setup fees, custom integrations |
| **Refund** | Billing error, overpayment | As needed | Returned to balance (withdrawable) |
| **Credit** | Compensation, promo, goodwill | As needed | Non-withdrawable, spend on Suiftly only |

**Subscription Billing Model: Prepay + Reconcile**

All subscriptions use universal billing on the **1st of each month**. Mid-month signups pay full rate upfront, with adjustment on next invoice.

| Event | Charge | Notes |
|-------|--------|-------|
| **First subscribe** | Full monthly rate | Immediate charge, regardless of day |
| **First 1st-of-month** | Adjusted (credit applied) | Credit for partial month already paid |
| **Ongoing** | Full monthly rate | 1st of each month |
| **Resume after suspend** | Full monthly rate | Same as first subscribe |
| **Tier upgrade** | Pro-rated difference | Immediate charge for remaining days (≤2 days = $0) |
| **Tier downgrade** | No immediate charge | Takes effect end of cycle |
| **Cancellation** | No refund | Service continues until end of paid period |

**Example:**
```
Jan 30: Subscribe to $29/mo tier → Charge $29
Feb 1:  Invoice: $29 − $27.13 (credit for unused days in Jan) = $1.87
Mar 1:  Invoice: $29
Apr 1:  Invoice: $29
```

**Customer messaging:** *"First payment is the full monthly rate. Your next invoice will be adjusted for any partial month."*

**Why this model:**
- Prevents abuse: Attacker pays full month, not $0.97 for same-day subscribe/cancel
- Fair: Customer pays same total as pro-rating, just different timing
- Simple ops: Universal billing date, always charge full month, apply credits
- Cash flow: Payment received before service delivered

**Balance vs Credit:**

| Term | Withdrawable | Source | Notes |
|------|--------------|--------|-------|
| **Balance** | Yes | Deposits, refunds | Real money, can withdraw to wallet |
| **Credit** | No | Outage compensation, promos, goodwill | Spend on Suiftly only, may have expiration |

**Spending Order:** Credits first (oldest expiring first) → Balance

### R2: Payment Methods

Support both payment paths simultaneously per customer:

| Method | Source | Settlement | Fees | Use Case |
|--------|--------|------------|------|----------|
| **Crypto** | USDC escrow (Sui) | On-chain | 0% | Web3-native users, primary path |
| **Fiat** | Credit card (Stripe) | Stripe | ~3% | Traditional users, fallback |

**Customer can:**
- Use crypto only (default)
- Use fiat only
- Use both with priority preference (e.g., "crypto first, fiat fallback")

### R3: Billing Cycle

| Event | Timing | Action |
|-------|--------|--------|
| **Subscription charge** | 1st of month, 00:00 UTC | Charge monthly base fees for all enabled services |
| **Usage aggregation** | Continuous | Meter requests per customer/service |
| **Usage charge** | Hourly or threshold ($5) | Charge accumulated usage |
| **Mid-cycle changes** | On upgrade/add-on | Upgrades: pro-rated. Add-ons: prepay + reconcile |
| **Period reset** | 1st of month | Reset usage counters, generate statements |

### R4: Mid-Cycle Change Rules

Different rules for upgrades vs add-ons:

**Upgrades (pro-rated, no reconciliation):**
```
charge = (new_tier − old_tier) × (days_remaining / days_in_month)
If days_remaining ≤ 2: charge = $0 (grace period)
```
*Where `days_remaining` = days from upgrade date to end of month, inclusive*
*Example: Upgrade from $9 to $29 on Jan 15 → Charge $20 × (17/31) = $10.97*
*Example: Upgrade on Jan 30 (2 days left) → Charge $0, new tier starts immediately*

**Downgrades:**
- Take effect on 1st of next month
- No immediate charge or refund
- Customer continues at current tier until cycle ends

**Add-ons (Seal keys, packages, allowlist):**
```
Mid-cycle: Charge full monthly add-on price
Next 1st:  Credit for partial month
```
*Example: Add extra Seal key ($5/mo) on Jan 20 → Charge $5 now, credit ~$3.06 on Feb 1*

**Reconciliation formula:**
```
credit = amount_paid × (days_not_used / days_in_month)
```
*Where:*
- *`days_not_used` = days_in_month - days_used*
- *`days_used` = days from purchase date to end of month, inclusive*
- *Example: Jan 30 purchase → days_used = 2 (Jan 30, 31) → days_not_used = 29 → credit = $amount × (29/31)*

### R5: Spending Limits (Escrow Path)

Per [CONSTANTS.md](./CONSTANTS.md):

| Limit | Value | Enforcement |
|-------|-------|-------------|
| Default 28-day cap | $250 | On-chain smart contract |
| Minimum cap | $10 | On-chain |
| Maximum cap | Unlimited | User choice |

**Behavior:**
- Charges blocked by smart contract if would exceed limit
- Service NOT suspended (existing service continues)
- User notified to increase limit or wait for period reset

### R6: Insufficient Balance Handling

**Scope:** This section applies to **scheduled monthly billing** (1st of month) only. Other charge types handled differently:

| Charge Type | On Failure | Account Suspension? |
|-------------|------------|---------------------|
| **Scheduled monthly** | See below (depends on `paid_once`) | Only if `paid_once = TRUE` |
| **Add-on purchase** | Cancel request immediately | No |
| **New service subscription** | Service stays `subscription_charge_pending = TRUE` | No (per-service only) |

**Scheduled Monthly Billing Failure:**

Grace period and account-level suspension **only apply when `customers.paid_once = TRUE`**.

| `paid_once` | On Charge Failure | Mechanism |
|-------------|-------------------|-----------|
| `FALSE` | No grace period, no account suspension | Per-service handling only |
| `TRUE` | 14-day grace period → account suspension | See below |

**When `paid_once = TRUE`:**

**Tracking:** `customers.grace_period_start` (timestamp, null = none).

| Phase | Duration | Customer Status | Effect on Services |
|-------|----------|-----------------|-------------------|
| **Charge fails** | Day 0 | `active` | Services continue; `grace_period_start = NOW()` |
| **Grace period** | Days 1-14 | `active` | Services continue; reminder emails, retry charges |
| **After grace** | Day 15+ | → `suspended` | All services blocked until payment |
| **Payment received** | — | → `active` | `grace_period_start = NULL`; all services → `disabled` |

**Customer suspension blocks all services.** On payment received, all services transition to `disabled` — user must manually re-enable.

### R7: Tax Requirements

**⚠️ NOT IN MVP** — Tax collection deferred to post-launch. MVP charges flat advertised prices with no tax calculation or remittance.

**Tax-Inclusive Pricing Model (Post-MVP)**

All prices are **tax-inclusive** — customers pay the advertised price regardless of jurisdiction. Suiftly calculates and remits applicable taxes.

```
Advertised: $29/mo (all taxes included)

CA customer (7.25% SaaS tax):    Customer pays $29, Suiftly remits $1.96 tax
TX customer (no SaaS tax):       Customer pays $29, Suiftly remits $0 tax
Non-US customer:                 Customer pays $29, no US tax obligation
```

**Why tax-inclusive:**
- Simple pricing globally ("$29/mo, period")
- No sticker shock at checkout
- Web3-friendly (predictable costs)
- Competitive in high-tax jurisdictions

**Location Requirement (Post-MVP):**

Post-MVP, customer must provide billing location before first paid subscription:

| Field | Required | Purpose |
|-------|----------|---------|
| Country | No (MVP) | Post-MVP: tax jurisdiction |
| State/Province | No (MVP) | Post-MVP: state-level tax rates |
| ZIP Code | No (MVP) | Post-MVP: local tax precision |

**Customer messaging:** *"We need your location for tax purposes. All prices include applicable taxes — you always pay the advertised price."*

**Invoice Display (tax itemization):**
```
Invoice #12345
─────────────────────────────
Seal Pro Tier                    $29.00
  Subtotal:        $27.04
  CA Sales Tax:     $1.96 (7.25%)
─────────────────────────────
Total (tax included):            $29.00
```

**Tax Calculation:**
```
tax_rate = getTaxRate(customer.country, customer.state)
tax_amount = advertised_price × (tax_rate / (1 + tax_rate))
net_revenue = advertised_price − tax_amount
```

**US Sales Tax Compliance:**
- Calculate per transaction based on customer location
- Monitor multi-state nexus thresholds (typically $100K or 200 transactions)
- SaaS taxability varies by state (~25 states tax SaaS)
- Generate tax-compliant invoices with itemization
- Export reports for filing per jurisdiction

**EU VAT:**

| Customer Type | VAT Treatment | Suiftly Obligation |
|---------------|---------------|-------------------|
| **B2B (valid VAT ID)** | Reverse charge | No VAT charged; customer self-assesses. Validate via VIES. |
| **B2C** | VAT due from €0 | Must register via OSS (One-Stop Shop) and charge destination country rate |

**B2B simplification:**
- If customer provides valid VAT ID (validated via EU VIES system), invoice shows:
  ```
  Subtotal:                 €27.00
  VAT (reverse charge):      €0.00
  "VAT reverse charge applies"
  ```
- Suiftly has **no EU VAT registration requirement** for pure B2B sales
- Customer reports VAT on their own return

**B2C complexity:**
- No threshold — VAT applies from first sale to EU consumers
- Must register via OSS or in each customer's country
- Rates vary: 19% (Germany), 20% (France), 21% (Spain), 23% (Ireland), etc.
- Recommendation: Target B2B initially; require VAT ID for EU customers

**Canada GST/HST:**

| Customer Type | Tax Treatment | Suiftly Obligation |
|---------------|---------------|-------------------|
| **B2B (valid GST/HST)** | Reverse charge | No tax charged; customer self-assesses |
| **B2C** | GST/HST due after $30K CAD | Register when threshold exceeded |

**B2B simplification:**
- Business customers self-assess (similar to EU reverse charge)
- Suiftly invoices without GST/HST; customer claims input tax credit

**B2C threshold:**
- $30,000 CAD over any 12-month period
- Below threshold: No registration required
- Above threshold: Must register and charge 5% GST (or 13-15% HST depending on province)

**International Tax Strategy (Post-MVP):**

Post-MVP, Suiftly can minimize international tax complexity by:

1. **Require business purpose declaration** for international customers
2. **Require VAT/GST ID** for EU and Canadian business customers
3. **Validate IDs** via VIES (EU) or CRA (Canada) APIs
4. **Apply reverse charge** for validated business customers
5. **Consumer sales (B2C)** — defer or block until thresholds/registration in place

**Customer data collected:**
- Billing country (required)
- Billing state/province (required for US/CA)
- ZIP code (optional, for future local tax precision)
- VAT ID (required for EU business customers)
- GST/HST number (required for Canadian business customers)

### R8: Invoice & Receipt Generation

**Invoice contains:**
- Invoice ID (INV-YYYY-MM-NNNN)
- Customer ID, billing address
- Line items with descriptions
- Subtotal, tax breakdown, total
- Payment method used
- Transaction reference (tx_digest or Stripe invoice ID)

**Retention:** 7 years (US tax requirement)

### R9: Refunds & Credits

| Type | Action | Withdrawable | Notes |
|------|--------|--------------|-------|
| **Refund** | Add to Balance | Yes | Billing error, overpayment, dispute |
| **Credit** | Add to Credits | No | Compensation, promo, goodwill (may expire) |

**Processing:**
- **Refund (crypto):** Add to escrow balance (withdrawable to wallet)
- **Refund (fiat):** Stripe refund API to original card
- **Credit:** Internal ledger entry only (no on-chain or Stripe transaction)

**Display to Customer:**
```
Available Balance:     $127.50  [Withdraw]
Credits:                $25.00  (non-withdrawable)
────────────────────────────────
Total Spending Power:  $152.50
```

**Credit Metadata:**
Each credit entry stores: `reason` (outage, promo, goodwill), `expires_at` (optional), `campaign_id` (optional)

**Credit Expiration Policy:**
- **Default expiration:** 1 year from issuance date
- **Reconciliation credits:** Never expire (from prepay adjustments)
- **Promotional credits:** May have custom expiration (30-90 days typical)
- **Compensation credits:** 1 year default (for outages, service issues)
- **Expiration handling:** Expired credits remain in database for audit but marked as expired
- **Customer notice:** Email reminder 30 days and 7 days before expiration

```typescript
// Credit creation with default expiration
async function issueCredit(customerId: number, amount: number, reason: string, customExpiry?: Date) {
  const expiresAt = customExpiry || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year default

  // Special case: reconciliation credits never expire
  if (reason === 'reconciliation') {
    expiresAt = null;
  }

  await db.insert(customerCredits).values({
    customer_id: customerId,
    original_amount_usd_cents: amount,
    remaining_amount_usd_cents: amount,
    reason,
    expires_at: expiresAt
  });
}
```

### R10: Overpayment Handling

**Scenario:** Customer pays more than the invoice amount (common with crypto due to manual transactions).

**Policy:** All overpayments are automatically added to the customer's withdrawable balance.

**Examples:**
- Invoice amount: $100.00, Customer pays: $105.00 → $5.00 added to balance
- Multiple invoices: $50 + $30 = $80 total, Customer pays: $100 → $20.00 added to balance
- Partial payment then overpayment: Invoice $100, pays $60 then $50 → $10.00 added to balance

**Implementation:**

```typescript
async function applyPayment(customerId: number, paymentAmount: number, invoiceIds: number[]) {
  return await db.transaction(async (tx) => {
    // Acquire lock
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${customerId})`);

    // Get total amount due across all specified invoices
    const totalDue = await getTotalDue(invoiceIds, tx);

    if (paymentAmount > totalDue) {
      // Apply payment to invoices
      await markInvoicesPaid(invoiceIds, totalDue, tx);

      // Add overpayment to withdrawable balance
      const overpayment = paymentAmount - totalDue;
      await tx.execute(sql`
        UPDATE customers
        SET balance = balance + ${overpayment}
        WHERE customer_id = ${customerId}
      `);

      // Record overpayment as deposit
      await tx.execute(sql`
        INSERT INTO escrow_transactions (
          customer_id, type, amount_usd_cents,
          description, tx_digest
        ) VALUES (
          ${customerId}, 'deposit', ${overpayment},
          'Overpayment from invoice payment', ${txDigest}
        )
      `);

      return {
        applied: totalDue,
        overpayment: overpayment,
        message: `Payment applied. $${overpayment/100} added to your withdrawable balance.`
      };
    }

    // Normal payment processing...
  });
}
```

**Customer Communication:**
- Email notification when overpayment detected
- Dashboard shows: "Overpayment of $X.XX has been added to your withdrawable balance"
- Balance history shows overpayment as a separate line item

**Why this approach:**
- **Simple:** No complex refund processing needed
- **Customer-friendly:** Funds immediately available for withdrawal or future charges
- **Transparent:** Clear tracking in transaction history
- **Flexible:** Customer can withdraw excess or leave for future billing

### R11: Concurrency Control

**Problem:** Multiple charge operations can occur simultaneously:
- Monthly subscription billing (cron job on 1st of month)
- Usage threshold charges (when customer hits $5 usage)
- Mid-cycle upgrades/add-ons (user-initiated requests)
- Payment retries (background jobs)
- Manual adjustments (admin operations)

Without proper locking, race conditions can cause:
- Double-charging customers
- Incorrect balance checks
- Lost updates to customer state
- Inconsistent invoice payment records

**Solution: Customer-Level Locking**

All billing operations that modify customer financial state must acquire an exclusive lock:

```sql
-- At the start of any charging operation:
BEGIN;
SELECT pg_advisory_xact_lock(customer_id::bigint);
-- Perform all balance checks and charges
-- Lock automatically released at COMMIT/ROLLBACK
```

**Implementation:**

```typescript
async function chargeCustomer(customerId: number, amount: number, reason: string) {
  return await db.transaction(async (tx) => {
    // Acquire exclusive lock for this customer
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${customerId})`);

    // Now safe to read balance and charge
    const customer = await tx.query.customers.findFirst({
      where: eq(customers.customer_id, customerId)
    });

    if (customer.balance < amount) {
      throw new InsufficientBalanceError();
    }

    // Perform charge...
    // All operations are serialized per customer
  });
}
```

**Locking Scope:**

Operations that MUST acquire customer lock:
- Creating/processing invoices
- Applying payments (credits, escrow, Stripe)
- Updating customer balance
- Changing subscription tiers
- Adding/removing add-ons
- Processing refunds
- Starting/ending grace periods

Operations that DON'T need customer lock:
- Reading billing history (SELECT only)
- Generating reports
- Sending notification emails
- Metering usage (writes to usage_records only)

**Lock Timeout:**

```typescript
// Set reasonable timeout to prevent deadlocks
await tx.execute(sql`SET lock_timeout = '10s'`);
```

**Alternative for High Throughput (Future):**

If PostgreSQL advisory locks become a bottleneck, implement distributed locking:
```typescript
// Using Redis with Redlock algorithm
const lock = await redlock.acquire([`billing:customer:${customerId}`], 10000);
try {
  // Perform billing operations
} finally {
  await lock.release();
}
```

### R12: Reporting

**Customer-facing:**
- Current balance (crypto + fiat)
- Pending charges (unbilled usage)
- Billing history (invoices, payments)
- Usage breakdown (requests by service/day)

**Internal:**
- Revenue by service, tier, customer
- MRR, ARR calculations
- Churn analysis
- Tax liability by jurisdiction

---

## Billing States

### Invoice Lifecycle

```
[First subscription or 1st of month]
         │
         │ Create DRAFT for upcoming period
         ↓
  ┌─────────────┐
  │    DRAFT    │  ← Pre-computed projection, updated on config changes
  └──────┬──────┘
         │ 1st of month
         ↓
  ┌─────────────┐
  │   PENDING   │  ← Ready to charge
  └──────┬──────┘
         │
         ├───────────────┬───────────────┐
         ↓               ↓               ↓
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │    PAID     │ │   FAILED    │ │   VOIDED    │
  └─────────────┘ └──────┬──────┘ └─────────────┘
                         │ Retry
                         ↓
                  ┌─────────────┐
                  │   PENDING   │  ← Back to retry queue
                  └─────────────┘
```

**DRAFT invoice model:**
- Exactly **one DRAFT** per customer (or none if no enabled services)
- Created on first subscription, updated atomically on every config change
- Customer views "Upcoming Charges" → single record lookup (no recalculation)
- On 1st of month: DRAFT → PENDING, new DRAFT created for next period
- Avoids repeated queries as service count grows

**When DRAFT is updated:**
- Service enabled/disabled
- Tier upgrade/downgrade scheduled
- Add-on added/removed
- Credit applied or expires

### States

| State | Description | Next Actions |
|-------|-------------|--------------|
| `draft` | Pre-computed projection for next billing cycle | Config change → recalculate; 1st of month → pending |
| `pending` | Ready for payment processing (may be partially paid) | Charge → paid/failed/voided |
| `paid` | Fully paid (`amount_paid_usd_cents >= amount_usd_cents`) | Final (immutable) |
| `failed` | Charge attempt failed (can have partial payments) | Retry or void |
| `voided` | Cancelled (billing error, etc.) | Final (immutable) |

**Note:** Database ENUM `billing_status` must include all 5 states: `draft`, `pending`, `paid`, `failed`, `voided`.
Current implementation may only have `pending`, `paid`, `failed` — migration required.

---

## Charge Flow

### Subscription Charge (Monthly)

```
1. Global Manager (1st of month, 00:00 UTC)
   │
   ├─ Query: All DRAFT invoices
   │
   ├─ For each DRAFT:
   │   │
   │   ├─ Update status: DRAFT → PENDING
   │   │
   │   ├─ Attempt charge (unified billing service)
   │   │   ├─ Crypto path: chargeFromEscrow()
   │   │   └─ Fiat path: createStripeInvoice()
   │   │
   │   ├─ On success:
   │   │   ├─ Update billing_record (status=paid)
   │   │   ├─ Create ledger_entry (tx reference)
   │   │   └─ Update customer.current_month_charged
   │   │
   │   └─ On failure:
   │       ├─ Update billing_record (status=failed)
   │       ├─ Increment retry_count
   │       └─ If balance issue AND paid_once = TRUE → start grace period
   │
   ├─ Create new DRAFT for next month (for customers with enabled services)
   │
   └─ Generate monthly statements
```

### Config Change (DRAFT Update)

```
1. API: Customer changes config (enable service, tier change, add-on)
   │
   ├─ Update config tables (service_instances, etc.)
   │
   ├─ Get or create DRAFT for current period
   │
   ├─ Recalculate DRAFT:
   │   ├─ Sum(service_tier_fee + add_ons) per enabled service
   │   └─ Apply any scheduled credits (prepay reconciliation)
   │
   └─ Update DRAFT with new line_items and total
       (atomic transaction with config change)
```

### Usage Charge (Threshold-Based)

```
1. Global Manager (every 5 minutes)
   │
   ├─ Query: Customers with unbilled usage > $5
   │
   ├─ For each customer:
   │   │
   │   ├─ Aggregate usage_records since last charge
   │   │   └─ SUM(request_count) × price_per_request
   │   │
   │   ├─ Create billing_record (type=usage)
   │   │
   │   ├─ Attempt charge
   │   │
   │   └─ Mark usage_records as billed
   │
   └─ Update last_usage_billing timestamp
```

### Mid-Cycle Change

**Tier Upgrade (pro-rated):**
```
1. API: Customer upgrades tier
   │
   ├─ BEGIN TRANSACTION + acquire pg_advisory_xact_lock(customer_id)
   │
   ├─ Calculate days_remaining until end of month
   │
   ├─ If days_remaining ≤ 2:
   │   └─ charge = $0 (grace period, avoid timezone issues)
   │
   ├─ Else:
   │   └─ charge = (new_tier − old_tier) × (days_remaining / days_in_month)
   │
   ├─ Validate: balance >= charge AND within spending limit
   │
   ├─ Create billing_record (type=upgrade)
   │
   ├─ Charge immediately
   │
   ├─ Update service_instance.tier
   │
   ├─ COMMIT TRANSACTION (releases lock)
   │
   └─ Return success (new tier active immediately)
```

**Add-on (prepay + reconcile):**
```
1. API: Customer adds Seal key, package, or allowlist entry
   │
   ├─ BEGIN TRANSACTION + acquire pg_advisory_xact_lock(customer_id)
   │
   ├─ Charge full monthly add-on price immediately
   │
   ├─ Create billing_record (type=addon_prepay)
   │   └─ Store: days_used, amount_paid
   │
   ├─ Schedule reconciliation credit for next 1st
   │   └─ credit = amount_paid × (days_not_used / days_in_month)
   │
   ├─ COMMIT TRANSACTION (releases lock)
   │
   └─ Return success (add-on active immediately)
```

---

## Subscription Charge Pending State

The `subscription_charge_pending` boolean on `service_instances` tracks whether the initial subscription charge has been successfully collected. **Billing logic drives this state.**

### State Transitions

```
┌──────────────────────────────────────────────────────────────────────┐
│               subscription_charge_pending Lifecycle                  │
└──────────────────────────────────────────────────────────────────────┘

  User subscribes
       │
       ├─ Create service_instance (subscription_charge_pending = TRUE)
       │
       ├─ Attempt immediate charge
       │
       ├─ On success:
       │   └─ Set subscription_charge_pending = FALSE
       │      Service operates normally
       │
       └─ On failure (insufficient balance):
           └─ subscription_charge_pending = TRUE remains
              UI shows "Subscription payment pending" banner
              Service in State 3 (Disabled) until payment succeeds

  Later: User deposits funds
       │
       └─ Trigger reconcilePayments(customerId)
           │
           ├─ Find services with subscription_charge_pending = TRUE
           │
           ├─ Retry charge for each
           │
           └─ On success: Set subscription_charge_pending = FALSE
```

### Integration Points

| Event | Action | subscription_charge_pending |
|-------|--------|----------------------------|
| **Subscribe** | Create service, attempt charge | `TRUE` initially |
| **Charge succeeds** | Clear flag, record ledger entry | → `FALSE` |
| **Charge fails** | Keep flag, show banner | stays `TRUE` |
| **User deposits** | Call `reconcilePayments()` | may → `FALSE` |
| **Monthly billing fails** | Set flag; if `paid_once` start grace period | → `TRUE` |
| **Resume after suspend** | Attempt charge | `TRUE` until paid |

### Relationship to DRAFT Invoice

| Concept | Scope | Purpose |
|---------|-------|---------|
| **subscription_charge_pending** | Per-service flag | Tracks if initial/monthly charge collected |
| **DRAFT invoice** | Per-customer record | Pre-computed projection of next 1st charge |

**They work together:**
- DRAFT invoice shows total upcoming charges
- `subscription_charge_pending` flags which services have unpaid charges
- When DRAFT → PENDING on 1st, any failed charges set `subscription_charge_pending = TRUE`

### UI Display

When `subscription_charge_pending = TRUE`:
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ Subscription payment pending                             │
│    Deposit funds to activate your service.                  │
│    [Deposit Now]                                            │
└─────────────────────────────────────────────────────────────┘
```

### Code Reference

```typescript
// apps/api/src/lib/reconcile-payments.ts

// Called after deposit to retry pending charges
async function reconcilePayments(customerId: number): Promise<ReconcileResult> {
  // Find services with subscription_charge_pending = true
  // Attempt charge for each
  // On success: set subscription_charge_pending = false
}

// Called on monthly billing failure
async function chargeMonthlySubscription(instanceId: number): Promise<boolean> {
  // Must acquire pg_advisory_xact_lock(customer_id) before processing
  // On failure: set subscription_charge_pending = true
}
```

---

## Data Model

### Core Billing Concepts

**Three distinct financial record types:**

| Table | Purpose | On-Chain? | Examples |
|-------|---------|-----------|----------|
| `escrow_transactions` | Completed blockchain escrow transactions | ✅ Yes (`tx_digest` NOT NULL) | Deposits, withdrawals, charges, **refunds** |
| `customer_credits` | Off-chain promotional/compensation credits | ❌ No | Outage compensation, promos, prepay reconciliation |
| `billing_records` | Invoices (intent to charge) | N/A | Monthly subscription, usage charges |
| `invoice_payments` | Payment applications to invoices | References both | Links credits + escrow transactions to invoices |

**Key principle:** Refunds are on-chain (`escrow_transactions`). Credits are off-chain (`customer_credits`).

### Multi-Source Payment Model (MVP)

**MVP Payment Sources:**
1. **Credits** (oldest expiring first) — non-withdrawable, off-chain
2. **Escrow** (crypto balance) — on-chain charge

**Phase 3:** Stripe (fiat fallback)

**Partial payment handling:**
- Invoice stays `pending` until `amount_paid_usd_cents >= amount_usd_cents`
- If escrow charge fails mid-payment, credits already applied stay applied
- Next billing run retries remaining amount from available sources

### Existing Tables (from CUSTOMER_SERVICE_SCHEMA.md)

- `customers` - balance, spending limits
- `billing_records` - invoices with line items
- `escrow_transactions` - completed on-chain escrow transactions (deposits, withdrawals, charges, **refunds**)
- `usage_records` - metered usage data

### New/Modified Fields

```sql
-- Extend customers table (MVP)
ALTER TABLE customers ADD COLUMN
  -- Payment state tracking
  paid_once BOOLEAN NOT NULL DEFAULT false,  -- Has customer ever paid anything?
  grace_period_start DATE,                   -- When grace period started (NULL = none)
  grace_period_notified_at TIMESTAMPTZ[];    -- Timestamps of reminder emails sent

-- Phase 3: Stripe and tax fields
-- primary_payment_method, stripe_customer_id, stripe_default_payment_method
-- billing_country, billing_state, billing_zip, etc.

-- Extend billing_records for multi-source payments (MVP)
ALTER TABLE billing_records ADD COLUMN
  -- Invoice metadata
  invoice_number VARCHAR(50),           -- INV-2025-01-0001
  due_date DATE,

  -- Multi-source payment tracking
  amount_paid_usd_cents BIGINT NOT NULL DEFAULT 0,  -- Running total of payments received
  -- Invoice is PAID when amount_paid_usd_cents >= amount_usd_cents

  -- Retry tracking
  retry_count INTEGER DEFAULT 0,
  last_retry_at TIMESTAMPTZ,
  failure_reason TEXT;

-- Consider: Create invoice_line_items table instead of JSONB
CREATE TABLE invoice_line_items (
  line_item_id SERIAL PRIMARY KEY,
  billing_record_id UUID REFERENCES billing_records(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount_usd_cents BIGINT NOT NULL,
  service_type VARCHAR(20),
  quantity INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  INDEX idx_line_items_billing (billing_record_id)
);

-- Customer credits (off-chain, non-withdrawable)
-- Used for: outage compensation, promos, goodwill, prepay reconciliation
CREATE TABLE customer_credits (
  credit_id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),

  -- Amounts
  original_amount_usd_cents BIGINT NOT NULL,     -- Initial credit amount
  remaining_amount_usd_cents BIGINT NOT NULL,    -- Current balance (decremented as used)

  -- Metadata
  reason VARCHAR(50) NOT NULL,           -- 'outage' | 'promo' | 'goodwill' | 'prepay_reconciliation'
  description TEXT,                      -- Human-readable description
  campaign_id VARCHAR(50),               -- Optional: promo campaign tracking

  -- Expiration
  expires_at TIMESTAMPTZ,                -- NULL = never expires

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  INDEX idx_credit_customer (customer_id),
  INDEX idx_credit_expires (expires_at) WHERE expires_at IS NOT NULL,
  CHECK (remaining_amount_usd_cents >= 0),
  CHECK (remaining_amount_usd_cents <= original_amount_usd_cents)
);

-- Invoice payments (tracks multi-source payments applied to invoices)
-- Each row = one payment application from one source
CREATE TABLE invoice_payments (
  payment_id SERIAL PRIMARY KEY,
  billing_record_id UUID NOT NULL REFERENCES billing_records(id),

  -- Payment source (MVP: credit or escrow only)
  source_type VARCHAR(20) NOT NULL,      -- 'credit' | 'escrow'

  -- Proper foreign keys instead of generic VARCHAR
  credit_id INTEGER REFERENCES customer_credits(credit_id),
  escrow_transaction_id UUID REFERENCES escrow_transactions(id),
  -- Phase 3: stripe_payment_id VARCHAR(100)

  -- Amount applied
  amount_usd_cents BIGINT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  INDEX idx_payment_billing_record (billing_record_id),
  INDEX idx_payment_credit (credit_id) WHERE credit_id IS NOT NULL,
  INDEX idx_payment_escrow (escrow_transaction_id) WHERE escrow_transaction_id IS NOT NULL,

  -- Ensure only one reference is set based on source_type
  CHECK (
    (source_type = 'credit' AND credit_id IS NOT NULL AND escrow_transaction_id IS NULL) OR
    (source_type = 'escrow' AND escrow_transaction_id IS NOT NULL AND credit_id IS NULL)
  )
);

-- Billing idempotency (prevent duplicate charges)
CREATE TABLE billing_idempotency (
  idempotency_key VARCHAR(100) PRIMARY KEY,
  billing_record_id UUID REFERENCES billing_records(id),
  response JSONB NOT NULL,               -- Cached response
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  INDEX idx_idempotency_created (created_at)  -- For cleanup of old entries
);
```

### Phase 3 Tables (Future)

```sql
-- Stripe webhook events (Phase 3 - when adding fiat payments)
CREATE TABLE stripe_events (
  event_id VARCHAR(50) PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  customer_id INTEGER REFERENCES customers(customer_id),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL
);

-- Tax calculation cache (Post-MVP)
CREATE TABLE tax_calculations (
  id UUID PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  billing_record_id UUID REFERENCES billing_records(id),
  subtotal_cents BIGINT NOT NULL,
  from_address JSONB NOT NULL,
  to_address JSONB NOT NULL,
  product_tax_code VARCHAR(50),
  tax_amount_cents BIGINT NOT NULL,
  tax_rate_percent DECIMAL(5,2) NOT NULL,
  jurisdiction VARCHAR(100),
  breakdown JSONB,
  provider VARCHAR(20) NOT NULL,
  provider_transaction_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Multi-Source Payment Flow (MVP)

```
Invoice: $50.00 (amount_usd_cents = 5000)
Customer has: $15 credit (expires soon), $40 escrow balance

Step 1: Apply credits (oldest expiring first)
  ├─ Find credits: SELECT * FROM customer_credits
  │   WHERE customer_id = ? AND remaining_amount_usd_cents > 0
  │   ORDER BY expires_at ASC NULLS LAST
  │
  ├─ Apply $15 credit:
  │   ├─ UPDATE customer_credits SET remaining_amount_usd_cents = 0
  │   ├─ INSERT invoice_payments (source_type='credit', credit_id=123, amount=1500)
  │   └─ UPDATE billing_records SET amount_paid_usd_cents = 1500
  │
  └─ Remaining: $35.00

Step 2: Charge escrow (on-chain)
  ├─ sui.charge(userAddress, 3500) → tx_digest
  │
  ├─ On success:
  │   ├─ INSERT escrow_transactions (type='charge', amount=-3500, tx_digest)
  │   ├─ INSERT invoice_payments (source_type='escrow', escrow_transaction_id=uuid, amount=3500)
  │   └─ UPDATE billing_records SET amount_paid_usd_cents = 5000, status = 'paid'
  │
  ├─ On failure (insufficient balance):
  │   ├─ Credits stay applied (no rollback)
  │   ├─ billing_records.failure_reason = 'insufficient_escrow_balance'
  │   └─ Remaining $35 retried on next billing run
  │
  └─ Invoice fully paid!

Final state:
  - billing_records.status = 'paid'
  - billing_records.amount_paid_usd_cents = 5000
  - invoice_payments: 2 rows (credit, escrow) with proper FKs
  - customer_credits.remaining_amount_usd_cents = 0
  - escrow_transactions: 1 row (escrow charge with tx_digest)
```

### Credit Application Rules

1. **Order:** Oldest expiring first (`ORDER BY expires_at ASC NULLS LAST`)
2. **Partial use:** Credits can be partially consumed (decrement `remaining_amount_usd_cents`)
3. **No rollback:** Once applied, credits are not rolled back on subsequent payment failures
4. **Expiration:** Expired credits (`expires_at < NOW()`) are skipped, not deleted (audit trail)

---

## Tax Integration

### Strategy

**Post-MVP:** Integrate tax calculation API (TaxJar or Avalara)
**Future:** Add Stripe Tax for fiat path

### Flow

```
1. Before finalizing charge:
   │
   ├─ Get customer billing address
   │
   ├─ Call tax API:
   │   └─ POST /taxes/calculate
   │       {
   │         from: { country: "US", state: "CA", zip: "94025" },
   │         to: { country: "US", state: customer.state, zip: customer.zip },
   │         amount: subtotal_cents / 100,
   │         product_tax_code: "81162100A0001"  // SaaS
   │       }
   │
   ├─ Store tax_calculation record
   │
   ├─ Add tax to billing_record.line_items
   │
   └─ Charge total (subtotal + tax)
```

### Tax Codes

| Service | Tax Code | Description |
|---------|----------|-------------|
| SaaS (general) | 81162100A0001 | Cloud computing services |
| Infrastructure | SW054100 | Platform services |

### Nexus Monitoring

Track revenue by state to detect economic nexus thresholds:

```sql
-- Monthly nexus report
SELECT
  billing_state,
  COUNT(DISTINCT customer_id) as customers,
  SUM(amount_usd_cents) / 100 as revenue_usd
FROM billing_records br
JOIN customers c ON br.customer_id = c.customer_id
WHERE br.status = 'paid'
  AND br.created_at >= DATE_TRUNC('year', NOW())
GROUP BY billing_state
ORDER BY revenue_usd DESC;
```

**Common thresholds (2024):**
- Most states: $100,000 revenue OR 200 transactions
- California: $500,000 revenue (no transaction threshold)

---

## Hybrid Payment Flow

### Unified Billing Service

```typescript
interface ChargeRequest {
  customerId: number;
  amountCents: number;
  taxCents: number;
  lineItems: LineItem[];
  idempotencyKey: string;
}

interface ChargeResult {
  success: boolean;
  paymentMethod: 'crypto' | 'fiat';
  transactionRef: string;        // tx_digest or stripe_invoice_id
  error?: string;
}

async function chargeCustomer(req: ChargeRequest): Promise<ChargeResult> {
  return await db.transaction(async (tx) => {
    // Acquire exclusive lock for this customer
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${req.customerId})`);

    const customer = await getCustomer(req.customerId, tx);
    const total = req.amountCents + req.taxCents;

    // Determine payment order based on preference
    const methods = getPaymentOrder(customer);

    for (const method of methods) {
      const result = await tryCharge(method, customer, total, req, tx);
      if (result.success) return result;
    }

    return { success: false, error: 'All payment methods failed' };
  });
}

function getPaymentOrder(customer: Customer): PaymentMethod[] {
  switch (customer.primary_payment_method) {
    case 'crypto':
      return customer.stripe_customer_id
        ? ['crypto', 'fiat']
        : ['crypto'];
    case 'fiat':
      return customer.escrow_contract_id
        ? ['fiat', 'crypto']
        : ['fiat'];
    case 'both':
      return ['crypto', 'fiat'];  // Prefer crypto (0% fees)
  }
}
```

### Balance Calculation

```typescript
interface CustomerBalance {
  crypto: {
    available: number;       // Escrow balance
    pendingCharges: number;  // Unbilled usage
  };
  fiat: {
    credits: number;         // Prepaid Stripe credits
    hasCard: boolean;        // Can charge card
  };
  total: number;             // Sum available for charges
}
```

---

## Global Manager Tasks

### billing-monthly (Cron: 1st of month, 00:05 UTC)

```typescript
async function billingMonthly() {
  // 1. Get all DRAFT invoices
  const drafts = await db.query(`
    SELECT * FROM billing_records WHERE status = 'draft'
  `);

  // 2. Process each DRAFT (already pre-calculated)
  for (const draft of drafts) {
    await processSubscriptionCharge(draft);
  }

  // 3. Create new DRAFTs for next month
  await createNextMonthDrafts();

  // 4. Reset monthly counters
  await resetMonthlyCounters();

  // 5. Send billing summary emails
  await sendBillingSummaries();
}
```

### billing-usage (Cron: every 5 minutes)

```typescript
async function billingUsage() {
  // Find customers with unbilled usage > threshold
  const threshold = 500;  // $5.00

  const customers = await db.query(`
    SELECT customer_id, SUM(pending_charge_usd_cents) as pending
    FROM pending_charges_view
    GROUP BY customer_id
    HAVING SUM(pending_charge_usd_cents) >= $1
  `, [threshold]);

  for (const { customer_id, pending } of customers) {
    await processUsageCharge(customer_id, pending);
  }
}
```

### billing-retry (Cron: every hour)

```typescript
async function billingRetry() {
  // Retry failed charges (max 3 attempts over 7 days)
  const failed = await db.query(`
    SELECT * FROM billing_records
    WHERE status = 'failed'
      AND retry_count < 3
      AND last_retry_at < NOW() - INTERVAL '24 hours'
  `);

  for (const record of failed) {
    await retryCharge(record);
  }
}
```

### grace-period-check (Cron: daily)

```typescript
async function gracePeriodCheck() {
  // Suspend services after 14-day grace period (only for paid_once = TRUE)
  const expired = await db.query(`
    SELECT * FROM customers
    WHERE grace_period_start IS NOT NULL
      AND grace_period_start < NOW() - INTERVAL '14 days'
      AND status = 'active'
      AND paid_once = TRUE
  `);

  for (const customer of expired) {
    await suspendForNonPayment(customer);
  }
}
```

---

## API Endpoints

### Customer-Facing

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/billing/balance` | GET | Current balance (crypto + fiat) |
| `/billing/pending` | GET | Pending charges breakdown |
| `/billing/invoices` | GET | Paginated invoice history |
| `/billing/invoices/:id` | GET | Invoice detail with line items |
| `/billing/invoices/:id/pdf` | GET | Download invoice PDF |
| `/billing/usage` | GET | Usage breakdown by service/period |
| `/billing/payment-methods` | GET | List payment methods |
| `/billing/payment-methods` | POST | Add payment method (Stripe setup) |
| `/billing/payment-methods/:id` | DELETE | Remove payment method |
| `/billing/credits/purchase` | POST | Buy prepaid credits (Stripe) |

### Webhooks

| Source | Events |
|--------|--------|
| **Stripe** | `invoice.paid`, `invoice.payment_failed`, `customer.subscription.*`, `payment_method.attached` |
| **Sui** | `EscrowDeposit`, `EscrowWithdraw`, `EscrowCharge` (via event listener) |

---

## Error Handling

### Charge Failures

| Error | Crypto Action | Fiat Action |
|-------|---------------|-------------|
| Insufficient balance | Start grace period | Try card, then grace period |
| Spending limit exceeded | Notify user, no retry | N/A |
| Card declined | N/A | Retry with backoff |
| Network error | Retry immediately | Retry immediately |

### Idempotency

All billing operations require idempotency key:

```typescript
// Frontend generates unique key per operation
const idempotencyKey = crypto.randomUUID();

// Backend checks before processing
const existing = await db.query(
  'SELECT * FROM billing_idempotency WHERE key = $1',
  [idempotencyKey]
);

if (existing) return existing.response;

// Process and store result
const result = await processCharge(...);
await db.insert(billing_idempotency, { key: idempotencyKey, response: result });
```

---

## Implementation Phases

### Phase 1A: Foundation & Time Abstraction ✅ COMPLETE
**Goal:** Enable deterministic testing with simulated time
**Status:** Production-ready, all tests passing (48 tests)

- [x] **Time abstraction layer** (`DBClock` interface in `@suiftly/shared/db-clock`)
  - `now()`: Current timestamp for database storage
  - `today()`: Current date with time zeroed (UTC 00:00:00.000)
  - `daysUntil(date)`: Days until a future/past date
  - `addDays(n)`, `addHours(n)`: Add time to current timestamp
  - `addDaysTo(date, n)`: Add days to specific date
  - Real implementation: Uses system clock for production
  - Mock implementation: Controllable time for testing (setTime, advance, timeScale)
  - Billing-specific helpers in `@suiftly/shared/billing/periods`
  - **Scope**: Database timestamps ONLY (not operational timeouts)
  - **Critical Fix**: Uses UTC consistently to avoid timezone issues
- [x] **Database migrations**
  - Add missing fields to `customers` (`paid_once`, `grace_period_start`, `grace_period_notified_at`)
  - Add `draft`, `voided` to `billing_status` enum
  - Create new tables (`customer_credits`, `invoice_payments`, `billing_idempotency`, `invoice_line_items`)
  - Add missing fields to `billing_records` (invoice_number, due_date, amount_paid_usd_cents, retry fields)
- [x] **Comprehensive tests**
  - Time manipulation tests (21 tests in db-clock.test.ts)
  - Billing period tests (27 tests in periods.test.ts)
  - All 48 tests passing

### Phase 1B: Single-Thread Billing Processor ✅ COMPLETE
**Goal:** One function that handles all billing operations sequentially
**Status:** Production-ready, all tests passing (11 tests)
**Location:** `packages/database/src/billing/`

- [x] **`processBilling()` main function** - Processes all customers with customer-level locking
- [x] **Customer-level locking** (`withCustomerLock`) - PostgreSQL advisory locks prevent race conditions
- [x] **Credit application** (oldest expiring first, partial consumption, non-rollback guarantee)
- [x] **Multi-source payments** (credits + escrow with partial payment tracking)
- [x] **Invoice lifecycle state machine** (DRAFT → PENDING → PAID/FAILED → VOIDED)
- [x] **Monthly subscription billing** (1st of month processing with DRAFT transition)
- [x] **Grace period management** (14-day period for paid_once=TRUE customers only)
- [x] **Payment retry logic** (configurable attempts and intervals)
- [x] **Idempotency handling** (prevents double-billing with cached responses)
- [x] **Customer suspension** (account + all services disabled after grace period)
- [x] **Comprehensive tests** (11 tests in billing.test.ts)
  - Credit application ordering and expiration
  - Multi-source payment scenarios (credits + escrow)
  - Non-rollback guarantee (credits stay applied on escrow failure)
  - Monthly billing with DRAFT transitions
  - Grace period start/end transitions (14-day simulation)
  - Payment retry logic with max attempts
  - Idempotency enforcement (prevent double-billing)
  - All tests use MockDBClock for deterministic time manipulation

### Phase 1C: Tier Change & Cancellation ✅ COMPLETE
**Goal:** Implement tier change and cancellation functionality (see R13 for detailed requirements)
**Status:** Production-ready, all tests passing (37 tests in tier-changes.test.ts)
**Location:** `packages/database/src/billing/tier-changes.ts`

- [x] **Database Migration**
  - Added `cancellation_pending` to `service_state` enum
  - Added columns: `scheduled_tier`, `scheduled_tier_effective_date`, `cancellation_scheduled_for`, `cancellation_effective_at`
  - Added `paid_once` field to `service_instances` table
  - Created `service_cancellation_history` table

- [x] **Tier Upgrade Implementation** (`handleTierUpgrade()`)
  - Pro-rated charge calculation with grace period (≤2 days = $0)
  - Immediate payment processing with customer lock
  - DRAFT invoice recalculation
  - Immediate upgrade when `paidOnce = false` (no charge)

- [x] **Tier Downgrade Implementation** (`scheduleTierDowngrade()`)
  - Schedule for 1st of next month
  - Cancel scheduled downgrade (`cancelScheduledTierChange()`)
  - Immediate downgrade when `paidOnce = false`
  - DRAFT invoice updates

- [x] **Cancellation Implementation**
  - `scheduleCancellation()` - sets flag, updates DRAFT
  - `undoCancellation()` - clears flag, restores DRAFT
  - Immediate deletion when `paidOnce = false` (no cooldown)
  - Monthly processor transitions to `cancellation_pending`

- [x] **Cleanup Integration** (`processCancellationCleanup()`)
  - Deletes related records after 7 days in `cancellation_pending`
  - Records in cancellation history for cooldown enforcement
  - Resets service to `not_provisioned`

- [x] **Anti-Abuse Implementation**
  - 7-day cooldown period after cancellation completes
  - `canProvisionService()` checks cooldown before allowing re-subscription

- [x] **Key Operation Blocking** (`canPerformKeyOperation()`)
  - Blocks generate/import Seal keys until `paidOnce = true`
  - Prevents abuse where users use service without paying

- [x] **Comprehensive Tests** (37 tests)
  - Tier upgrades (mid-month, grace period, payment failure)
  - Tier downgrades (scheduling, cancellation, multiple changes)
  - Cancellation flow (schedule, undo, period-end transition)
  - Full cancellation journey with time simulation
  - Unpaid subscription handling (immediate changes, no cooldown)
  - Key operation blocking
  - All tests use MockDBClock for deterministic time manipulation

### Unified Periodic Job ✅ COMPLETE
**Goal:** Single background job that handles ALL billing operations in deterministic order
**Status:** Production-ready
**Location:** `packages/database/src/billing/periodic-job.ts`

**Function:** `runPeriodicBillingJob()` - Called every 5 minutes in production

**Execution Phases (in order):**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PERIODIC BILLING JOB (every 5 minutes)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PHASE 1: Billing Processing (per customer with lock)                       │
│  ├── Monthly Billing (1st of month only)                                    │
│  │   ├── Apply scheduled tier changes                                       │
│  │   ├── Process scheduled cancellations → cancellation_pending             │
│  │   ├── Transition DRAFT → PENDING invoices                                │
│  │   ├── Attempt payments (credits + escrow)                                │
│  │   └── Start grace period on failure (if paid_once = true)                │
│  ├── Payment Retries                                                        │
│  │   └── Retry failed invoices (up to max attempts)                         │
│  └── Grace Period Expiration                                                │
│      └── Suspend accounts after 14-day grace period                         │
│                                                                             │
│  PHASE 2: Cancellation Cleanup                                              │
│  ├── Find services in cancellation_pending for 7+ days                      │
│  ├── Delete related data (API keys, Seal keys, packages)                    │
│  ├── Record cancellation history (for cooldown enforcement)                 │
│  └── Reset service to not_provisioned                                       │
│                                                                             │
│  PHASE 3: Housekeeping                                                      │
│  ├── Clean up old idempotency records (> 90 days)                           │
│  └── Clean up old cancellation history (> 30 days)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Design Principles:**
1. **Determinism**: Order of operations is always the same
2. **Testability**: One function to call, one result to verify
3. **Simplicity**: No race conditions between separate jobs
4. **Debuggability**: Single log stream, easy to trace issues

**Test API Endpoint:** `POST /test/billing/run-periodic-job`
- Triggers the exact same job that runs in production
- Used by API tests to simulate realistic periodic execution
- Disabled in production environment

### Phase 2: Service Integration ⏳ IN PROGRESS
**Status:** Core service billing complete (8 tests), usage metering and dashboard pending
**Location:** `packages/database/src/billing/service-billing.ts`

- [x] **Service lifecycle integration** (8 tests in service-billing.test.ts)
  - Subscribe → generate DRAFT invoice + immediate first-month charge
  - Reconciliation credit for partial month (prepay + reconcile model)
  - DRAFT invoice creation and management
  - Pro-rated tier upgrade calculations with 2-day grace period
  - Add-on billing framework (Seal keys, packages, API keys)
- [ ] **Usage metering integration** (TODO - Phase 15 scope)
  - Aggregate usage records
  - Threshold-based charging ($5 threshold)
- [ ] **Customer dashboard** (TODO - separate phase)
  - View invoices
  - Check pending charges
  - Credit balance display
- [ ] **End-to-end tests** (TODO)
  - Complete customer journey
  - Multiple billing cycles
  - Service state transitions

**Implemented Functions:**
- `handleSubscriptionBilling()` - First-month charge + DRAFT creation + reconciliation credit
- `recalculateDraftInvoice()` - Update DRAFT when services/config changes
- `calculateProRatedUpgradeCharge()` - Mid-cycle tier upgrades
- `getOrCreateDraftInvoice()` - DRAFT lifecycle management
- `generateInvoiceNumber()` - Sequential numbering (INV-YYYY-MM-NNNN)

### Phase 3: Production Readiness
- [ ] **Performance optimization**
  - Batch processing limits
  - Query optimization
- [ ] **Monitoring & alerts**
  - Failed payment alerts
  - Grace period notifications
  - Audit logging
- [ ] **Operational tools**
  - Manual payment application
  - Credit issuance interface
  - Invoice void/correction

### Phase 4: Stripe Integration (Post-MVP)
- [ ] Stripe customer creation
- [ ] Payment method management
- [ ] Webhook handling
- [ ] Fallback logic (crypto → fiat)

### Phase 5: Tax Compliance (Future)
- [ ] Customer address collection
- [ ] Tax API integration
- [ ] Tax calculation per charge
- [ ] Tax reporting exports

---

## R13: Tier Change and Cancellation

This section defines the complete requirements for tier changes (upgrades/downgrades) and subscription cancellation, including anti-abuse measures and state management.

### Overview

| Action | Timing | Billing Impact | Service Impact | Reversible |
|--------|--------|----------------|----------------|------------|
| **Tier Upgrade** | Immediate | Pro-rated charge for remaining days | Immediate new tier | No (charged) |
| **Tier Downgrade** | End of billing period | No immediate charge | Current tier until period end | Yes (until period end) |
| **Cancellation** | End of billing period | Removed from DRAFT invoice | Service continues until period end | Yes (until period end) |
| **Re-enable after Cancel** | Immediate (during period) | Re-added to DRAFT invoice | No change (still active) | N/A |

### R13.1: Tier Upgrade (Immediate Effect)

**Trigger:** Customer selects higher-priced tier from "Change Tier" modal.

**Business Rules:**
1. **Immediate activation:** New tier takes effect immediately upon successful payment
2. **Pro-rated charge:** Customer pays only the difference for remaining days in the billing period
3. **Grace period:** If ≤2 days remaining in billing period, charge is $0 (avoids timezone edge cases)
4. **Payment required:** Upgrade ONLY activates if payment succeeds; failure keeps current tier

**Charge Calculation:**
```
upgrade_charge = (new_tier_price − old_tier_price) × (days_remaining / days_in_month)

Where:
  days_remaining = days from upgrade date to end of month (inclusive)

If days_remaining ≤ 2:
  upgrade_charge = $0 (grace period - new tier still activates)
```

**Examples:**
```
Scenario 1: Mid-month upgrade
- Current: Starter ($9/mo), Upgrading to: Pro ($29/mo)
- Date: Jan 15 (17 days remaining in 31-day month)
- Charge: ($29 - $9) × (17/31) = $20 × 0.548 = $10.97

Scenario 2: Late-month upgrade (grace period)
- Current: Starter ($9/mo), Upgrading to: Pro ($29/mo)
- Date: Jan 30 (2 days remaining)
- Charge: $0 (grace period, new tier active immediately)

Scenario 3: Enterprise upgrade
- Current: Pro ($29/mo), Upgrading to: Enterprise ($185/mo)
- Date: Jan 10 (22 days remaining in 31-day month)
- Charge: ($185 - $29) × (22/31) = $156 × 0.71 = $110.71
```

**State Transitions:**
```
[User clicks "Upgrade to Pro"]
        │
        ├─ Calculate pro-rated charge
        │
        ├─ Validate: balance >= charge AND within spending limit
        │
        ├─ On validation fail:
        │   └─ Show error: "Insufficient balance. Deposit $X to upgrade."
        │      Return (no state change)
        │
        ├─ Attempt immediate charge
        │
        ├─ On charge fail:
        │   └─ Show error: "Payment failed. Please try again."
        │      Return (no state change)
        │
        └─ On success:
            ├─ Update service_instances.tier = new_tier
            ├─ Update DRAFT invoice for next billing cycle
            ├─ Create billing_record (type=upgrade, status=paid)
            └─ Return success + toast: "Upgraded to Pro tier. $10.97 charged."
```

**Database Changes:**
```sql
-- On successful upgrade
UPDATE service_instances
SET tier = 'pro',
    updated_at = NOW()
WHERE instance_id = ?;

-- Recalculate DRAFT for next month (will use new tier price)
-- Handled by recalculateDraftInvoice()
```

### R13.2: Tier Downgrade (Scheduled Effect)

**Trigger:** Customer selects lower-priced tier from "Change Tier" modal.

**Business Rules:**
1. **Scheduled activation:** New tier takes effect at start of next billing period (1st of month)
2. **No immediate charge:** Customer already paid for current tier through end of period
3. **No refund:** Current period is non-refundable (service continues at current tier)
4. **Reversible:** Customer can change their mind before period ends
5. **Multiple changes:** Last scheduled tier before period end wins

**State Management:**
```sql
-- New fields on service_instances
ALTER TABLE service_instances ADD COLUMN
  scheduled_tier service_tier,          -- NULL = no change scheduled
  scheduled_tier_effective_date DATE;   -- When change takes effect (1st of next month)
```

**State Transitions:**
```
[User clicks "Downgrade to Starter"]
        │
        ├─ No immediate charge (already paid for current period)
        │
        ├─ Set scheduled_tier = 'starter'
        │
        ├─ Set scheduled_tier_effective_date = first day of next month
        │
        ├─ Update DRAFT invoice (uses scheduled_tier for projection)
        │
        └─ Return success + toast:
           "Tier change to Starter scheduled for [DATE].
            You'll continue with Pro features until then."
```

**Monthly Billing Process (1st of month):**
```
For each service with scheduled_tier IS NOT NULL:
  │
  ├─ If scheduled_tier_effective_date <= TODAY:
  │   ├─ Update tier = scheduled_tier
  │   ├─ Clear scheduled_tier = NULL
  │   ├─ Clear scheduled_tier_effective_date = NULL
  │   └─ Log: "Tier changed from [old] to [new]"
  │
  └─ Bill at new tier rate
```

**UI Display (when downgrade scheduled):**
```
┌─────────────────────────────────────────────────────────────┐
│ ℹ️ Tier change scheduled                                    │
│    Your service will change from Pro to Starter on Feb 1.   │
│    [Cancel Change] [Keep Pro]                               │
└─────────────────────────────────────────────────────────────┘
```

### R13.3: Subscription Cancellation

**Trigger:** Customer clicks "Cancel Subscription" in "Change Tier" modal.

**Key Principle:** Cancellation is **NOT immediate**. The customer has paid for the billing period and the service continues operating normally until the period ends. The cancellation is simply a flag indicating "do not renew."

**Business Rules:**
1. **Service continues:** Service remains fully operational until end of billing period
2. **No refund:** Current billing period is non-refundable (already paid)
3. **Freely reversible:** Customer can un-cancel anytime before billing period ends
4. **DRAFT impact:** Service removed from next month's DRAFT invoice
5. **End of period:** Service enters `cancellation_pending` state (7-day data retention)
6. **Anti-abuse:** 7-day block on re-provisioning after subscription actually ends

**Database Schema:**
```sql
-- New field on service_instances (tracks scheduled cancellation)
ALTER TABLE service_instances ADD COLUMN
  cancellation_scheduled_for DATE;  -- NULL = not cancelled; DATE = when cancellation takes effect

-- New state value for post-billing-period phase
ALTER TYPE service_state ADD VALUE 'cancellation_pending' AFTER 'suspended_no_payment';

-- Additional fields for cancellation_pending state
ALTER TABLE service_instances ADD COLUMN
  cancellation_effective_at TIMESTAMPTZ;  -- When full cleanup will occur (7 days after period end)
```

**Cancellation Flow (During Billing Period):**
```
[User clicks "Cancel Subscription"]
        │
        ├─ Show confirmation modal:
        │   "Are you sure you want to cancel your Seal subscription?
        │    • Your service will continue working until [END_OF_BILLING_PERIOD]
        │    • You can change your mind anytime before then
        │    • After [END_OF_BILLING_PERIOD], you have 7 days before data is deleted
        │    • No refund for current billing period"
        │
        ├─ User confirms
        │
        ├─ Update service instance:
        │   └─ cancellation_scheduled_for = end of current billing period
        │      (Service state remains 'enabled' or 'disabled' - no change!)
        │
        ├─ Update DRAFT invoice: remove this service (no charge next month)
        │
        └─ Show toast:
           "Subscription cancelled. Your service will remain active until
            [END_DATE]. To keep your service, click 'Keep Subscription'
            in the Change Tier menu anytime before then."
```

**UI Display (Cancellation Scheduled, Service Still Active):**
```
┌─────────────────────────────────────────────────────────────┐
│ ℹ️ Cancellation Scheduled                                   │
│    Your subscription ends on [END_DATE]. Service is still   │
│    fully active until then.                                 │
│                                                              │
│    Changed your mind? [Keep Subscription]                   │
└─────────────────────────────────────────────────────────────┘
```

**Toast Message (on cancellation):**
```
┌─────────────────────────────────────────────────────────────┐
│ ✓ Subscription cancelled                                    │
│                                                              │
│   Your service remains active until [END_DATE].             │
│   To undo: Click "Change Tier" → "Keep Subscription"        │
│                                                    [Dismiss] │
└─────────────────────────────────────────────────────────────┘
```

### R13.4: Re-enabling During Billing Period (Undo Cancellation)

**Trigger:** Customer clicks "Keep Subscription" or selects a tier while cancellation is scheduled.

**Business Rules:**
1. **No charge:** Customer already paid for this period
2. **No impact:** Simply clears the cancellation flag
3. **DRAFT restored:** Service re-added to next month's DRAFT invoice
4. **Tier changes:** If selecting a different tier, apply upgrade/downgrade rules

**Un-Cancel Flow (Same Tier):**
```
[User clicks "Keep Subscription"]
        │
        ├─ Clear cancellation_scheduled_for = NULL
        │
        ├─ Update DRAFT invoice: re-add this service
        │
        └─ Show toast: "Great! Your subscription will continue as normal."
```

**Un-Cancel Flow (Different Tier):**
```
[User selects "Enterprise" while cancellation is scheduled]
        │
        ├─ Clear cancellation_scheduled_for = NULL
        │
        ├─ If new tier > current tier:
        │   └─ Apply upgrade rules (R13.1) - pro-rated charge
        │
        ├─ If new tier < current tier:
        │   └─ Apply downgrade rules (R13.2) - schedule for next period
        │
        ├─ Update DRAFT invoice accordingly
        │
        └─ Show appropriate toast
```

### R13.5: End of Billing Period Transition

**Trigger:** Monthly billing job runs on 1st of month.

**Process for Cancelled Services:**
```
For each service where cancellation_scheduled_for <= TODAY:
  │
  ├─ Transition state: current_state → 'cancellation_pending'
  │
  ├─ Set cancellation_effective_at = NOW() + 7 days
  │
  ├─ Set is_user_enabled = false (service now returns 503)
  │
  ├─ Clear cancellation_scheduled_for = NULL
  │
  └─ Log: "Service entered cancellation_pending state"
```

**State Definition (State 7: Cancellation Pending):**

| Aspect | Description |
|--------|-------------|
| **Meaning** | Billing period ended, 7-day grace before full deletion |
| **Service Status** | Disabled (keys return 503) |
| **Billing** | No charges (subscription has ended) |
| **Configuration** | Read-only (can view, cannot edit) |
| **Keys** | Preserved but inactive (return 503) |
| **Duration** | 7 days from billing period end |
| **Re-subscribe** | Blocked during this period (anti-abuse) |
| **After Period** | State → `not_provisioned`, all service data deleted |

**UI Display (Cancellation Pending - After Billing Period):**
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ Subscription Ended                                       │
│    Your service data will be permanently deleted on [DATE]. │
│                                                              │
│    To resubscribe, please wait until [DATE + 7 days] or     │
│    contact support@mhax.io for immediate assistance.        │
│                                                              │
│    [Contact Support]                                        │
└─────────────────────────────────────────────────────────────┘
```

### R13.6: Anti-Abuse: Re-Provisioning Block

**Problem:** Malicious users could exploit the system by:
- Subscribing to capture promotional credits
- Cancelling at end of period
- Immediately re-subscribing to capture more promos
- Repeat cycle

**Solution:** 7-day block on re-provisioning the SAME service type after subscription ends.

**Business Rules:**
1. **Invisible until needed:** Customer only sees this if they try to re-subscribe
2. **Trigger:** When billing period ends and service enters `cancellation_pending`
3. **Duration:** 7 days from when `cancellation_pending` started
4. **Scope:** Per customer + service type (can subscribe to other services)
5. **Bypass:** Contact support@mhax.io for legitimate cases

**Implementation:**
```typescript
async function canProvisionService(
  customerId: number,
  serviceType: string
): Promise<{ allowed: boolean; reason?: string; availableAt?: Date }> {

  // Check if service is in cancellation_pending state
  const existingService = await db.query.serviceInstances.findFirst({
    where: and(
      eq(serviceInstances.customerId, customerId),
      eq(serviceInstances.serviceType, serviceType)
    )
  });

  if (existingService?.state === 'cancellation_pending') {
    return {
      allowed: false,
      reason: 'cancellation_pending',
      availableAt: existingService.cancellationEffectiveAt
    };
  }

  // Check cancellation history for recent deletions
  const recentCancellation = await db.query.serviceCancellationHistory.findFirst({
    where: and(
      eq(serviceCancellationHistory.customerId, customerId),
      eq(serviceCancellationHistory.serviceType, serviceType),
      gt(serviceCancellationHistory.cooldownExpiresAt, new Date())
    )
  });

  if (recentCancellation) {
    return {
      allowed: false,
      reason: 'cooldown_period',
      availableAt: recentCancellation.cooldownExpiresAt
    };
  }

  return { allowed: true };
}
```

**Database Schema:**
```sql
-- Track cancellation history for anti-abuse
CREATE TABLE service_cancellation_history (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type service_type NOT NULL,
  billing_period_ended_at TIMESTAMPTZ NOT NULL,   -- When subscription actually ended
  deleted_at TIMESTAMPTZ NOT NULL,                -- When service was fully deleted
  cooldown_expires_at TIMESTAMPTZ NOT NULL,       -- When re-provisioning is allowed

  INDEX idx_cancellation_customer_service (customer_id, service_type),
  INDEX idx_cancellation_cooldown (cooldown_expires_at)
);
```

**UI Display (Blocked by Cooldown):**
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠️ Service temporarily unavailable                          │
│                                                              │
│   You recently cancelled your Seal subscription.            │
│   New subscriptions will be available on [DATE].            │
│                                                              │
│   Need immediate access? Contact support@mhax.io            │
│                                                              │
│                                            [Contact Support] │
└─────────────────────────────────────────────────────────────┘
```

### R13.7: Cancellation Cleanup Job

**Purpose:** Delete expired `cancellation_pending` services after 7-day grace period.

**Trigger:** Daily cron job (recommended: run hourly for timely cleanup)

**Process:**
```typescript
async function processCancellationCleanup(clock: DBClock): Promise<void> {
  const now = clock.now();

  // Find all services past their cancellation effective date
  const expiredCancellations = await db.select()
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.state, 'cancellation_pending'),
        lte(serviceInstances.cancellationEffectiveAt, now)
      )
    );

  for (const service of expiredCancellations) {
    await db.transaction(async (tx) => {
      // 1. Record in cancellation history (for cooldown enforcement)
      await tx.insert(serviceCancellationHistory).values({
        customerId: service.customerId,
        serviceType: service.serviceType,
        billingPeriodEndedAt: service.cancellationEffectiveAt, // When period ended
        deletedAt: now,
        cooldownExpiresAt: clock.addDays(7) // 7-day cooldown from deletion
      });

      // 2. Delete related records
      // Delete API keys for this service
      await tx.delete(apiKeys)
        .where(and(
          eq(apiKeys.customerId, service.customerId),
          eq(apiKeys.serviceType, service.serviceType)
        ));

      // Delete Seal keys and packages (if Seal service)
      if (service.serviceType === 'seal') {
        await tx.execute(sql`
          DELETE FROM seal_packages
          WHERE seal_key_id IN (
            SELECT seal_key_id FROM seal_keys
            WHERE customer_id = ${service.customerId}
          )
        `);

        await tx.delete(sealKeys)
          .where(eq(sealKeys.customerId, service.customerId));
      }

      // 3. Reset service instance to not_provisioned
      await tx.update(serviceInstances)
        .set({
          state: 'not_provisioned',
          tier: 'starter',
          isUserEnabled: true,
          subscriptionChargePending: true,
          config: null,
          enabledAt: null,
          disabledAt: null,
          cancellationScheduledFor: null,
          cancellationEffectiveAt: null,
          scheduledTier: null,
          scheduledTierEffectiveDate: null
        })
        .where(eq(serviceInstances.instanceId, service.instanceId));

      // 4. Log the cleanup
      await tx.insert(userActivityLogs).values({
        customerId: service.customerId,
        clientIp: '0.0.0.0',
        message: `Service ${service.serviceType} deleted after cancellation grace period`
      });
    });
  }
}
```

### R13.8: "Change Tier" Modal Design

**Entry Point:** "Change Tier" button on service configuration page.

**Modal Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  Change Your Plan                                      [X]  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Current Plan: Pro ($29/month)                              │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ○ Starter - $9/month                                │    │
│  │   • 10 req/sec guaranteed                           │    │
│  │   • No burst capacity                               │    │
│  │   ⚠️ Takes effect Feb 1 (current tier until then)   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ● Pro - $29/month (Current)                         │    │
│  │   • 100 req/sec guaranteed                          │    │
│  │   • Burst up to 500 req/sec                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ ○ Enterprise - $185/month                           │    │
│  │   • 1000 req/sec guaranteed                         │    │
│  │   • Burst up to 5000 req/sec                        │    │
│  │   💰 Upgrade now: $110.71 (pro-rated)               │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ──────────────────────────────────────────────────────────  │
│                                                              │
│  ○ Cancel Subscription                                      │
│    Service continues until Jan 31. You can undo anytime.    │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│                          [Cancel]  [Confirm Change]         │
└─────────────────────────────────────────────────────────────┘
```

**Dynamic Content:**
- Upgrade tiers show pro-rated charge amount
- Downgrade tiers show effective date ("Takes effect [DATE]")
- Cancel option shows end date and reversibility
- Confirm button text changes based on selection:
  - "Upgrade Now ($X.XX)"
  - "Schedule Downgrade"
  - "Cancel Subscription"
  - "Keep Subscription" (if cancellation was previously scheduled)

### R13.9: State Machine Summary

```
                    ┌──────────────────────────────────────────────────┐
                    │              (1) not_provisioned                  │
                    │                                                   │
                    │  No subscription for this service                │
                    └─────────────────────┬────────────────────────────┘
                                          │
                                          │ Subscribe + payment
                                          │ (blocked if in cooldown)
                                          ▼
                    ┌──────────────────────────────────────────────────┐
                    │              (2) provisioning                     │
                    │              (transient ~50ms)                    │
                    └─────────────────────┬────────────────────────────┘
                                          │
                                          │ Payment success
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                                                                               │
│   ACTIVE SUBSCRIPTION ZONE                                                    │
│   (Service operational, user can toggle enable/disable)                       │
│   (User can schedule cancellation - service keeps working)                    │
│                                                                               │
│   ┌─────────────────────────┐         ┌─────────────────────────┐            │
│   │     (3) disabled        │◄───────►│     (4) enabled         │            │
│   │                         │ toggle  │                         │            │
│   │  Subscribed, OFF        │         │  Serving traffic        │            │
│   └─────────────────────────┘         └─────────────────────────┘            │
│                                                                               │
│   • Cancel: sets cancellation_scheduled_for = end_of_period                  │
│   • Undo cancel: clears cancellation_scheduled_for (no impact)               │
│   • Service continues normally until billing period ends                      │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          │ Billing period ends
                                          │ (if cancellation_scheduled_for is set)
                                          ▼
                    ┌──────────────────────────────────────────────────┐
                    │         (7) cancellation_pending                  │
                    │                                                   │
                    │  7-day grace period before full deletion         │
                    │  Service disabled, data preserved                 │
                    │  Re-subscribe blocked (contact support)          │
                    └─────────────────────┬────────────────────────────┘
                                          │
                                          │ 7 days expire
                                          │ (cleanup job runs)
                                          ▼
                    ┌──────────────────────────────────────────────────┐
                    │              Cleanup Process                      │
                    │                                                   │
                    │  • Delete API keys, Seal keys, packages          │
                    │  • Record in cancellation_history                │
                    │  • Reset to not_provisioned                      │
                    │  • Start 7-day re-provisioning cooldown          │
                    └─────────────────────┬────────────────────────────┘
                                          │
                                          │
                                          ▼
                    ┌──────────────────────────────────────────────────┐
                    │              (1) not_provisioned                  │
                    │              (with 7-day cooldown)                │
                    │                                                   │
                    │  After cooldown expires → can re-subscribe       │
                    └──────────────────────────────────────────────────┘
```

### R13.10: Summary of Database Changes

**New Enum Value:**
```sql
ALTER TYPE service_state ADD VALUE 'cancellation_pending' AFTER 'suspended_no_payment';
```

**Modified `service_instances` Table:**
```sql
ALTER TABLE service_instances ADD COLUMN
  -- Tier change scheduling
  scheduled_tier service_tier,                   -- For scheduled downgrades
  scheduled_tier_effective_date DATE,            -- When downgrade takes effect

  -- Cancellation scheduling (during billing period - service still active)
  cancellation_scheduled_for DATE,               -- End of billing period when cancel takes effect

  -- Cancellation pending state (after billing period ends)
  cancellation_effective_at TIMESTAMPTZ;         -- When full deletion will occur
```

**New Table:**
```sql
CREATE TABLE service_cancellation_history (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(customer_id),
  service_type service_type NOT NULL,
  billing_period_ended_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL,
  cooldown_expires_at TIMESTAMPTZ NOT NULL,

  INDEX idx_cancellation_customer_service (customer_id, service_type),
  INDEX idx_cancellation_cooldown (cooldown_expires_at)
);
```

---

## Missing Requirements to Address

### Critical for MVP
1. **Payment Reconciliation Process** - How to sync on-chain transactions with database records
2. **Retry Strategy** - Exponential backoff, jitter, max attempts
3. **Audit Trail** - What events to log, retention period
4. **Performance Requirements** - Invoices/second, concurrent billing jobs

### Important but Deferrable
5. **Refund Approval Workflow** - Automated vs manual approval
6. **Credit Note Generation** - For accounting compliance
7. **Payment Timeout Handling** - How long to wait for blockchain confirmation?

### Future Considerations
9. **Currency Conversion** - Handling rate fluctuations between charge and settlement
10. **Batch Processing Limits** - How many customers to bill in parallel?

---

## Open Questions

1. ~~**Billing address collection:**~~ **RESOLVED** — Required at first subscription (country + state for US/CA). See R7.
2. ~~**Tax-exempt customers:**~~ **RESOLVED** — B2B reverse charge for EU (VAT ID) and Canada (GST/HST number). MVP requires tax ID for international business customers. See R7.
3. ~~**Credit expiration default:**~~ **RESOLVED** — 1 year default, reconciliation credits never expire, promotional credits configurable. See R9.
4. **Multi-currency:** Support EUR, other stablecoins beyond USDC?
5. **Dispute handling:** Process for Stripe chargebacks? (Auto-suspend service?)
6. **EU B2C sales:** Block EU consumers (require VAT ID) or register for OSS? Recommendation: Block initially.

---

**Document Version:** 2.4
**Last Updated:** 2025-01-27
**Status:** Draft - MVP Implementation Ready

**Summary:**
This billing design supports usage-based infrastructure services with multi-source payment capabilities (credits + escrow for MVP, Stripe deferred to Phase 3). Key features include partial payment tracking, 14-day grace periods for established customers, tier change management (immediate upgrades, scheduled downgrades), and subscription cancellation with anti-abuse protections.

**Key Design Decisions:**
- **MVP Focus:** Credits + Escrow only (Stripe and tax deferred to Phase 3)
- **Tables:** `escrow_transactions` (on-chain), `customer_credits` (off-chain), `billing_records` (invoices), `invoice_payments` (payment tracking), `service_cancellation_history` (anti-abuse)
- **Payment Order:** Credits (oldest expiring first) → Escrow → Stripe (Phase 3)
- **Grace Period:** 14 days for customers with `paid_once = TRUE` only
- **Billing Model:** Prepay + Reconcile (charge full month upfront, credit on next 1st)
- **Tier Upgrade:** Immediate effect with pro-rated charge for remaining days (≤2 days = $0 grace period)
- **Tier Downgrade:** Scheduled for end of billing period (no immediate charge, reversible)
- **Cancellation:** Service continues until billing period ends; 7-day data retention after; 7-day re-provisioning cooldown
- **Concurrency Control:** PostgreSQL advisory locks (`pg_advisory_xact_lock`) on customer_id for all charging operations
- **Overpayment Handling:** Automatically added to customer's withdrawable balance (no manual refund processing)
- **Credit Expiration:** 1 year default, reconciliation credits never expire, promotional credits customizable
