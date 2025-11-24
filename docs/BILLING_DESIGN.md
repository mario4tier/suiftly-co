# Billing Design

## Overview

Billing system for Suiftly infrastructure services supporting:
- Subscription-based charges (monthly base fees)
- Usage-based charges (per-request pricing)
- Hybrid payment methods (crypto escrow + fiat)
- Tax compliance (post-MVP)

**Related Documents:**
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
  - Credit application ordering and
  expiration
  - Multi-source payment scenarios (credits + escrow)
  - Non-rollback guarantee (credits stay applied on escrow failure)
  - Monthly billing with DRAFT transitions
  - Grace period start/end transitions (14-day simulation)
  - Payment retry logic with max attempts
  - Idempotency enforcement (prevent double-billing)
  - All tests use MockDBClock for deterministic time manipulation

**Phase 1C merged into 1B** - Credit and payment logic implemented together for coherence

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

**Document Version:** 2.3
**Last Updated:** 2025-01-22
**Status:** Draft - MVP Implementation Ready

**Summary:**
This billing design supports usage-based infrastructure services with multi-source payment capabilities (credits + escrow for MVP, Stripe deferred to Phase 3). Key features include partial payment tracking, 14-day grace periods for established customers, and proper separation between on-chain escrow transactions and off-chain credits.

**Key Design Decisions:**
- **MVP Focus:** Credits + Escrow only (Stripe and tax deferred to Phase 3)
- **Tables:** `escrow_transactions` (on-chain), `customer_credits` (off-chain), `billing_records` (invoices), `invoice_payments` (payment tracking)
- **Payment Order:** Credits (oldest expiring first) → Escrow → Stripe (Phase 3)
- **Grace Period:** 14 days for customers with `paid_once = TRUE` only
- **Billing Model:** Prepay + Reconcile (charge full month upfront, credit on next 1st)
- **Concurrency Control:** PostgreSQL advisory locks (`pg_advisory_xact_lock`) on customer_id for all charging operations
- **Overpayment Handling:** Automatically added to customer's withdrawable balance (no manual refund processing)
- **Credit Expiration:** 1 year default, reconciliation credits never expire, promotional credits customizable
