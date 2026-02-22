# Multi-Provider Payment System

Add payment provider abstraction supporting multiple payment methods with user-defined priority ordering and automatic fallback.

**Related:** [BILLING_DESIGN.md](./BILLING_DESIGN.md), [ESCROW_DESIGN.md](./ESCROW_DESIGN.md), [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md)

---

## Overview

The billing system currently hard-codes escrow as the only charge method in `processInvoicePayment()` (`packages/database/src/billing/payments.ts`). This design adds a payment provider abstraction supporting multiple payment methods as equals, with customer credits retaining highest precedence (already implemented).

### Payment Methods

All payment methods are equal at the priority/ordering layer — none gets hardcoded priority over another; the customer controls the order. However, MVP enforces **one active method per provider type** (one card, one escrow, one PayPal) as an app-level simplification. The DB schema supports multiple rows per type — relaxing this limit requires only an app-code change, no migration. See [Design Decisions](#13-design-decisions) for rationale.

**Implication for fallback:** Cross-provider fallback (e.g., card fails → escrow pays) works at MVP. Within-provider fallback (e.g., card A fails → card B) requires the multi-card relaxation. Each provider has different setup flows and runtime characteristics:

| Method | Label | Setup Step | Charge Model |
|--------|-------|------------|--------------|
| **Crypto** (escrow) | "Pay with Crypto" | Create escrow on-chain + fund it | Synchronous (on-chain) |
| **Credit/Debit Card** (Stripe) | "Credit/Debit Card" | Enter card details (SetupIntent) | Async possible (3DS) |
| **PayPal** | "PayPal" | Link PayPal account (billing agreement) | Synchronous (server-to-server) |

### Charge Order

1. **Credits** (existing, always first) — off-chain, non-withdrawable
2. **User's payment methods** in their preferred order — auto-fallback to next if one fails

### UX Model

- **New users start with zero payment methods** — must add at least one before enabling services
- Users add payment methods explicitly via "Add payment method" on the Billing page
- Users **set priority order** — drag-to-reorder or up/down arrows
- System **auto-falls back** to next method if preferred fails
- **Service gate** (already implemented for escrow): tier selection and configuration are always allowed, but **enabling** a service or adding keys is blocked until:
  1. A payment method is configured, AND
  2. Any pending subscription invoice (`subPendingInvoiceId`) is resolved
  3. `paidOnce` is set on the service (proven ability to pay — see [BILLING_DESIGN.md](./BILLING_DESIGN.md) for how `paidOnce` controls tier change semantics, cancellation policy, key operations, and grace period eligibility)

---

## 1. Payment Provider Abstraction

### IPaymentProvider Interface

New file: `packages/shared/src/payment-provider/types.ts`

```typescript
/**
 * Payment Provider Interface
 *
 * Abstraction over payment methods (Crypto, Stripe, PayPal).
 * Credits are NOT a provider — they are always applied first
 * in processInvoicePayment() before providers are tried.
 *
 * All providers are equal. Priority is determined by user preference,
 * not by provider type.
 */
export interface IPaymentProvider {
  /** Provider identifier */
  readonly type: PaymentProviderType;

  /**
   * Is this provider configured AND able to charge?
   * - Crypto: has escrowContractId AND balance >= amount
   * - Stripe: has stripeCustomerId AND has saved payment method
   * - PayPal: has linked PayPal account
   */
  canPay(customerId: number, amountUsdCents: number): Promise<boolean>;

  /**
   * Is the payment method set up? (not necessarily funded)
   * - Crypto: has escrowContractId
   * - Stripe: has stripeCustomerId with saved card
   * - PayPal: has linked account
   */
  isConfigured(customerId: number): Promise<boolean>;

  /**
   * Execute a charge.
   *
   * The provider is responsible for:
   * 1. Creating provider-specific records (e.g., escrow_transactions)
   * 2. Returning a referenceId for the invoice_payments record
   *
   * The CALLER (processInvoicePayment) is responsible for:
   * 1. Creating the invoice_payments row using the returned referenceId
   * 2. Updating the billing_records status
   */
  charge(params: ProviderChargeParams): Promise<ProviderChargeResult>;

  /**
   * Display info for the billing UI.
   *
   * NOTE: For escrow, this should be computed live (balance changes
   * with every deposit/withdrawal/charge). For Stripe/PayPal, cached
   * data from customer_payment_methods.providerConfig is fine.
   */
  getInfo(customerId: number): Promise<ProviderInfo | null>;
}

export type PaymentProviderType = 'escrow' | 'stripe' | 'paypal';

export interface ProviderChargeParams {
  customerId: number;
  amountUsdCents: number;
  invoiceId: number;
  description: string;
  /** Idempotency key — prevents duplicate charges on retry.
   *  Constructed by caller as `invoice-${billingRecordId}-${providerType}`.
   *  Escrow: used for local dedup. Stripe: passed as Stripe-Idempotency-Key header.
   *  PayPal: passed as PayPal-Request-Id header. */
  idempotencyKey: string;
}

export interface ProviderChargeResult {
  success: boolean;
  /** Reference ID for invoice_payments (escrow tx ID, Stripe invoice ID, PayPal order ID) */
  referenceId?: string;
  /**
   * Provider-specific transaction digest (escrow only).
   * Used to set billing_records.txDigest for on-chain traceability.
   * NULL for Stripe/PayPal — billing_records.txDigest stays NULL for those.
   */
  txDigest?: Buffer;
  error?: string;
  /** Provider-specific error code for targeted UI guidance (see Service Gate section) */
  errorCode?: 'insufficient_escrow' | 'card_declined' | 'requires_action' | 'account_not_configured';
  retryable: boolean;
  /**
   * Stripe-hosted invoice URL for 3DS completion (Stripe only).
   * Set when charge returns requires_action — the user must visit this URL
   * to complete authentication. Stored on billing_records.paymentActionUrl
   * so the dashboard can render a "Complete payment" prompt.
   */
  hostedInvoiceUrl?: string;
}

export interface ProviderInfo {
  type: PaymentProviderType;
  /** e.g. "Visa ending in 4242", "Escrow: $12.50 USDC", "PayPal: user@email.com" */
  displayLabel: string;
  details: Record<string, unknown>;
}
```

### Implementations

#### EscrowPaymentProvider ("Pay with Crypto")

File: `packages/database/src/billing/providers/escrow-provider.ts`

Thin wrapper around the existing `ISuiService.charge()`. Extracts the escrow-specific logic currently in `processInvoicePayment()` lines 107-212 into a provider.

**Important:** Escrow reads `escrowContractId` and `currentBalanceUsdCents` from the `customers` table (not from `customer_payment_methods`). These fields remain on customers because they're deeply integrated with blockchain sync, balance tracking, and the immutable escrow address model. See [Design Decisions](#13-design-decisions).

```typescript
export class EscrowPaymentProvider implements IPaymentProvider {
  readonly type = 'escrow' as const;

  constructor(
    private suiService: ISuiService,
    private db: DatabaseOrTransaction
  ) {}

  async canPay(customerId: number, amountUsdCents: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    if (!customer?.escrowContractId) return false;
    return (customer.currentBalanceUsdCents ?? 0) >= amountUsdCents;
  }

  async isConfigured(customerId: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    return !!customer?.escrowContractId;
  }

  async charge(params: ProviderChargeParams): Promise<ProviderChargeResult> {
    // 1. Get customer + wallet address from customers table
    // 2. Validate escrowContractId exists
    // 3. Call suiService.charge({ escrowAddress: customer.escrowContractId, ... })
    // 4. Create escrow_transactions row (txDigest, amount in DOLLARS, assetType: 'USDC')
    // 5. Return { referenceId: escrowTx.txId, txDigest: buffer }
    //    NOTE: Does NOT create invoice_payments — caller does that
  }

  async getInfo(customerId: number): Promise<ProviderInfo | null> {
    // Computed LIVE from customers.currentBalanceUsdCents (not cached)
    // Escrow balance changes with every deposit/withdrawal/charge
    const customer = await this.getCustomer(customerId);
    if (!customer?.escrowContractId) return null;
    return {
      type: 'escrow',
      displayLabel: `Escrow: $${((customer.currentBalanceUsdCents ?? 0) / 100).toFixed(2)} USDC`,
      details: { balance: customer.currentBalanceUsdCents, walletAddress: customer.walletAddress },
    };
  }
}
```

**Key:** `ISuiService` stays unchanged. `EscrowPaymentProvider` is a thin wrapper.

#### StripePaymentProvider

File: `packages/database/src/billing/providers/stripe-provider.ts`

Uses Stripe Invoices API for background charges (Stripe creates PaymentIntents internally):

```typescript
export class StripePaymentProvider implements IPaymentProvider {
  readonly type = 'stripe' as const;

  constructor(
    private stripeService: IStripeService,
    private db: DatabaseOrTransaction
  ) {}

  async canPay(customerId: number, amountUsdCents: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    if (!customer?.stripeCustomerId) return false;
    // Stripe handles actual card validation at charge time
    return true;
  }

  async isConfigured(customerId: number): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
    return !!customer?.stripeCustomerId;
  }

  async charge(params: ProviderChargeParams): Promise<ProviderChargeResult> {
    // 1. Get customer's stripeCustomerId from customers table
    // 2. Create Stripe Invoice with:
    //    - metadata: { billing_record_id: params.invoiceId } (for webhook→billing record correlation)
    //    - auto_advance: false (we control finalization; prevents Stripe auto-collecting on its own schedule)
    //    - payment_settings: { payment_method_types: ['card'] } (prevent Stripe offering bank transfers etc.)
    // 3. Add InvoiceItem with amount and description
    // 4. Finalize and pay the invoice (Stripe creates PaymentIntent internally)
    //    - Pass params.idempotencyKey as Stripe-Idempotency-Key header
    // 5. Handle 'requires_action':
    //    return { success: false, retryable: false,
    //             errorCode: 'requires_action',
    //             hostedInvoiceUrl: stripeInvoice.hosted_invoice_url }
    //    (see 3DS/SCA section below — caller persists URL on billing_records)
    // 6. Handle decline:
    //    return { success: false, retryable: true, errorCode: 'card_declined' }
    // 7. Return { referenceId: stripeInvoiceId }
    //    NOTE: Does NOT create invoice_payments — caller does that
  }

  async getInfo(customerId: number): Promise<ProviderInfo | null> {
    // Read cached data from customer_payment_methods.providerConfig
    // Card details (brand, last4) rarely change — cache is fine
  }
}
```

#### PayPalPaymentProvider

File: `packages/database/src/billing/providers/paypal-provider.ts`

```typescript
export class PayPalPaymentProvider implements IPaymentProvider {
  readonly type = 'paypal' as const;

  constructor(
    private paypalService: IPayPalService,
    private db: DatabaseOrTransaction
  ) {}

  async canPay(customerId: number, amountUsdCents: number): Promise<boolean> {
    const method = await this.getPaymentMethod(customerId);
    return !!method;
  }

  async isConfigured(customerId: number): Promise<boolean> {
    const method = await this.getPaymentMethod(customerId);
    return !!method;
  }

  async charge(params: ProviderChargeParams): Promise<ProviderChargeResult> {
    // 1. Get customer's PayPal billing agreement from customer_payment_methods.providerRef
    // 2. Create and capture PayPal order (server-to-server, no user interaction)
    // 3. Return { referenceId: paypalOrderId }
    //    NOTE: Does NOT create invoice_payments — caller does that
  }
}
```

#### Provider Resolution

File: `packages/database/src/billing/providers/index.ts`

```typescript
/**
 * Get a customer's payment providers in their preferred order.
 *
 * Reads customer_payment_methods table ordered by priority,
 * instantiates the corresponding provider for each active method.
 *
 * IMPORTANT: Call this within the customer lock transaction to prevent
 * race conditions with concurrent reordering.
 */
export async function getCustomerProviders(
  customerId: number,
  services: PaymentServices,
  db: DatabaseOrTransaction
): Promise<IPaymentProvider[]> {
  const methods = await db.select()
    .from(customerPaymentMethods)
    .where(and(
      eq(customerPaymentMethods.customerId, customerId),
      eq(customerPaymentMethods.status, 'active')
    ))
    .orderBy(asc(customerPaymentMethods.priority));

  return methods.map(m => createProvider(m.providerType, services, db));
}

function createProvider(
  type: PaymentProviderType,
  services: PaymentServices,
  db: DatabaseOrTransaction
): IPaymentProvider {
  switch (type) {
    case 'escrow': return new EscrowPaymentProvider(services.suiService, db);
    case 'stripe': return new StripePaymentProvider(services.stripeService, db);
    case 'paypal': return new PayPalPaymentProvider(services.paypalService, db);
  }
}
```

---

## 2. Core Refactor: processInvoicePayment()

**File:** `packages/database/src/billing/payments.ts`

### Current Signature

```typescript
export async function processInvoicePayment(
  tx: LockedTransaction,
  billingRecordId: number,
  suiService: ISuiService,   // <-- hard-coded to escrow
  clock: DBClock
): Promise<InvoicePaymentResult>
```

### New Signature

```typescript
export async function processInvoicePayment(
  tx: LockedTransaction,
  billingRecordId: number,
  providers: IPaymentProvider[],   // <-- provider chain in user's priority order
  clock: DBClock
): Promise<InvoicePaymentResult>
```

### Responsibility Split

| Responsibility | Who |
|---|---|
| Create provider-specific record (e.g., `escrow_transactions`) | Provider's `charge()` |
| Return `referenceId` + optional `txDigest` | Provider's `charge()` |
| Create `invoice_payments` row | `processInvoicePayment()` |
| Update `billing_records` status/txDigest | `processInvoicePayment()` |

This keeps providers focused on their own domain while `processInvoicePayment()` handles the cross-cutting invoice tracking.

### New Body (pseudocode)

```typescript
// Guard: If already paid (e.g., concurrent retry from API + periodic job), return immediately.
// This is the primary double-charge protection — checked under customer advisory lock.
const billingRecord = await tx.select().from(billingRecords)
  .where(eq(billingRecords.id, billingRecordId)).limit(1);
if (billingRecord[0].status === 'paid') {
  return { fullyPaid: true, amountPaidCents: billingRecord[0].amountPaidUsdCents, paymentSources: [] };
}

// Compute remaining amount from what's already been paid (handles retry after partial credit application).
// On first attempt: amountPaidUsdCents = 0.
// On retry after credits-only partial payment: amountPaidUsdCents = credits already applied.
const totalAmountCents = billingRecord[0].amountUsdCents;
let remainingAmount = totalAmountCents - (billingRecord[0].amountPaidUsdCents ?? 0);

// Step 1: Apply credits ONLY if not already applied (prevents double credit application on retry).
// Check existing invoice_payments for this billing record — if credits are already recorded, skip.
const existingCreditPayments = await tx.select().from(invoicePayments)
  .where(and(
    eq(invoicePayments.billingRecordId, billingRecordId),
    eq(invoicePayments.sourceType, 'credit')
  ));

if (existingCreditPayments.length === 0 && remainingAmount > 0) {
  const creditResult = await applyCreditsToInvoice(tx, customerId, billingRecordId, remainingAmount, clock);
  // ... record credit payment sources in invoice_payments (unchanged) ...
  remainingAmount = creditResult.remainingInvoiceAmountCents;
  result.amountPaidCents += (totalAmountCents - remainingAmount);
} else {
  // Credits already applied in a previous attempt — skip, use remaining from billing record
}

// Step 2: For remaining amount, iterate providers in user's priority order
if (remainingAmount > 0) {
  let charged = false;
  let lastError: BillingError | undefined;

  for (const provider of providers) {
    if (!await provider.canPay(customerId, remainingAmount)) {
      // Track skipped providers for targeted error messages
      // e.g., escrow skipped due to insufficient balance → errorCode: 'insufficient_escrow'
      if (provider.type === 'escrow' && await provider.isConfigured(customerId)) {
        lastError = {
          type: 'payment_failed',
          message: 'Insufficient escrow balance',
          errorCode: 'insufficient_escrow',
          customerId,
          invoiceId: billingRecordId,
          retryable: false,
        };
      }
      continue;
    }

    const chargeResult = await provider.charge({
      customerId,
      amountUsdCents: remainingAmount,
      invoiceId: billingRecordId,
      description: `Invoice ${billingRecordId}`,
      idempotencyKey: `invoice-${billingRecordId}-${provider.type}`,
    });

    if (chargeResult.success) {
      // Create invoice_payments row (processInvoicePayment's responsibility)
      await tx.insert(invoicePayments).values({
        billingRecordId,
        sourceType: provider.type,
        // For escrow: set escrowTransactionId from referenceId
        // For stripe/paypal: set providerReferenceId from referenceId
        ...(provider.type === 'escrow'
            ? { escrowTransactionId: Number(chargeResult.referenceId) }
            : { providerReferenceId: chargeResult.referenceId }),
        amountUsdCents: remainingAmount,
      });

      result.paymentSources.push({
        type: provider.type,
        amountCents: remainingAmount,
        referenceId: chargeResult.referenceId!,
      });
      result.amountPaidCents += remainingAmount;
      result.fullyPaid = true;
      charged = true;

      // Update billing_records with status + txDigest (escrow-only, NULL for others)
      await tx.update(billingRecords).set({
        amountPaidUsdCents: result.amountPaidCents,
        status: 'paid',
        txDigest: chargeResult.txDigest ?? null, // Only escrow sets this
      }).where(eq(billingRecords.id, billingRecordId));

      break;
    }

    // Provider failed - record error, try next
    lastError = {
      type: 'payment_failed',
      message: chargeResult.error ?? `${provider.type} charge failed`,
      errorCode: chargeResult.errorCode,
      customerId,
      invoiceId: billingRecordId,
      retryable: chargeResult.retryable,
    };

    // Persist Stripe-hosted URL for 3DS completion (if returned)
    if (chargeResult.hostedInvoiceUrl) {
      await tx.update(billingRecords).set({
        paymentActionUrl: chargeResult.hostedInvoiceUrl,
      }).where(eq(billingRecords.id, billingRecordId));
    }
  }

  if (!charged) {
    // Update billing_records to failed status (enables periodic job retry)
    await tx.update(billingRecords).set({
      amountPaidUsdCents: result.amountPaidCents, // May include credit portion
      status: 'failed',
    }).where(eq(billingRecords.id, billingRecordId));

    result.error = lastError ?? {
      type: 'payment_failed',
      message: 'No payment method available',
      customerId,
      invoiceId: billingRecordId,
      retryable: false,
    };
  }
}
```

### Type Changes

**File:** `packages/database/src/billing/types.ts`

```typescript
// Update InvoicePaymentResult.paymentSources type
export interface InvoicePaymentResult {
  // ... existing fields ...
  paymentSources: Array<{
    type: 'credit' | 'escrow' | 'stripe' | 'paypal';
    amountCents: number;
    referenceId: string;
  }>;
}

// Update BillingOperation type
export interface BillingOperation {
  type: 'monthly_billing' | 'credit_application' | 'escrow_charge' | 'stripe_charge' | 'paypal_charge'
       | 'grace_period_start' | 'grace_period_end' | 'payment_retry' | 'reconciliation';
  // ... rest unchanged ...
}
```

### Call Sites to Update

All callers of `processInvoicePayment()` must pass `providers` instead of `suiService`:

| Caller | File |
|--------|------|
| `handleSubscriptionBilling()` | `service-billing.ts` |
| `processBilling()` | `processor.ts` |
| `runPeriodicBillingJob()` | `periodic-job.ts` |

Each already receives `suiService` as a parameter. The change is to also accept/construct `IPaymentProvider[]` using `getCustomerProviders()`.

---

## 3. Database Schema Changes

**Not yet deployed** — update schema and initial migration directly (no backward compatibility concerns).

### customers table changes

**File:** `packages/database/src/schema/customers.ts`

Add `stripeCustomerId` column. Keep `escrowContractId` unchanged.

```typescript
export const customers = pgTable('customers', {
  // ... existing columns unchanged ...
  escrowContractId: varchar('escrow_contract_id', { length: FIELD_LIMITS.SUI_ADDRESS }), // KEEP — deeply integrated
  currentBalanceUsdCents: bigint('current_balance_usd_cents', { mode: 'number' }).default(0), // KEEP — escrow balance synced from blockchain

  // New: Stripe account (similar to escrowContractId — one per customer, set once)
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }),
});
```

**Why provider account IDs live on `customers`, not `customer_payment_methods`:**
- `escrowContractId` is immutable, set by `findOrCreateCustomerWithEscrow()` with conflict detection
- `stripeCustomerId` is created once per customer (Stripe Customer object), used for ALL Stripe API calls
- `currentBalanceUsdCents` is synced from blockchain using `escrowContractId`
- These are customer-level account setup, not method-level configuration
- `customer_payment_methods` tracks which methods are enabled and in what priority order

### New: customer_payment_methods table

**File:** `packages/database/src/schema/billing.ts` (add to existing file)

Stores which payment methods a customer has configured and their preferred order.

**One method per provider type per customer** (intentional — see [Design Decisions](#13-design-decisions)).

```typescript
export const customerPaymentMethods = pgTable('customer_payment_methods', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  providerType: varchar('provider_type', { length: 20 }).notNull(), // 'escrow' | 'stripe' | 'paypal'
  status: varchar('status', { length: 20 }).notNull().default('active'), // 'active' | 'suspended' | 'removed'
  priority: integer('priority').notNull(), // User-defined order (1 = first tried, 2 = fallback, etc.)

  // Provider-specific reference for method-level data (nullable)
  // - Escrow: NULL (uses customers.escrowContractId)
  // - Stripe: default payment method ID (e.g. 'pm_xxx')
  // - PayPal: billing agreement ID
  providerRef: varchar('provider_ref', { length: 200 }),

  // Provider-specific display/config data (JSONB)
  // - Escrow: NULL (display info computed live from customers.currentBalanceUsdCents)
  // - Stripe: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 }
  // - PayPal: { email: 'user@example.com' }
  providerConfig: jsonb('provider_config'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxCustomerPriority: index('idx_cpm_customer_priority').on(table.customerId, table.priority),
}));

// NOTE: Partial unique index (prevent duplicate provider_ref per customer) must be
// created in migration SQL because Drizzle ORM's unique() does not support WHERE clauses:
//
//   CREATE UNIQUE INDEX uniq_customer_provider_ref_active
//   ON customer_payment_methods (customer_id, provider_ref)
//   WHERE status = 'active' AND provider_ref IS NOT NULL;
// This allows multiple cards per provider type in the future. Escrow uniqueness
// (providerRef=NULL) is enforced by application-level pre-check.
```

### invoicePayments table

**File:** `packages/database/src/schema/billing.ts`

Add a generic `providerReferenceId` for external providers (Stripe, PayPal). Keep existing FKs for local tables (credits, escrow):

```typescript
export const invoicePayments = pgTable('invoice_payments', {
  // ... existing columns ...
  sourceType: varchar('source_type', { length: 20 }).notNull(), // 'credit' | 'escrow' | 'stripe' | 'paypal'

  // Local DB foreign keys (for sources with local tables)
  creditId: integer('credit_id').references(() => customerCredits.creditId),
  escrowTransactionId: bigint('escrow_transaction_id', { mode: 'number' }).references(() => escrowTransactions.txId),

  // Generic reference for external providers (Stripe invoice ID, PayPal order ID)
  // External system is the source of record — no local FK needed
  providerReferenceId: varchar('provider_reference_id', { length: 200 }),

  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxPaymentBillingRecord: index('idx_payment_billing_record').on(table.billingRecordId),
  idxPaymentCredit: index('idx_payment_credit').on(table.creditId).where(sql`${table.creditId} IS NOT NULL`),
  idxPaymentEscrow: index('idx_payment_escrow').on(table.escrowTransactionId).where(sql`${table.escrowTransactionId} IS NOT NULL`),
  idxPaymentProvider: index('idx_payment_provider').on(table.providerReferenceId).where(sql`${table.providerReferenceId} IS NOT NULL`),

  // NOTE: Unique constraint on providerReferenceId must be created in migration SQL
  // because Drizzle ORM's unique() does not support WHERE clauses:
  //
  //   CREATE UNIQUE INDEX uniq_provider_reference_id
  //   ON invoice_payments (provider_reference_id)
  //   WHERE provider_reference_id IS NOT NULL;
  //
  // This prevents the same Stripe Invoice ID or PayPal Order ID from being recorded
  // twice (e.g., race between synchronous charge path and async webhook).

  // Constraint: sourceType must match exactly one reference column
  // credit → creditId, escrow → escrowTransactionId, stripe/paypal → providerReferenceId
  checkSourceTypeMatch: check('check_source_type_match', sql`
    (${table.sourceType} = 'credit'
      AND ${table.creditId} IS NOT NULL
      AND ${table.escrowTransactionId} IS NULL
      AND ${table.providerReferenceId} IS NULL) OR
    (${table.sourceType} = 'escrow'
      AND ${table.escrowTransactionId} IS NOT NULL
      AND ${table.creditId} IS NULL
      AND ${table.providerReferenceId} IS NULL) OR
    (${table.sourceType} IN ('stripe', 'paypal')
      AND ${table.providerReferenceId} IS NOT NULL
      AND ${table.creditId} IS NULL
      AND ${table.escrowTransactionId} IS NULL)
  `),
}));
```

**Why this hybrid approach:**
- `creditId` and `escrowTransactionId` remain as typed FKs — they reference local tables with referential integrity
- `providerReferenceId` is a generic varchar for external providers — the external system (Stripe, PayPal) is the source of record
- Adding a new external provider only requires adding its name to the `IN ('stripe', 'paypal', ...)` list — no new column needed

### billing_records changes

**`txDigest`** — No change. Stores on-chain transaction digest for escrow payments. `NULL` for Stripe/PayPal. The Stripe invoice ID and PayPal order ID are stored in `invoice_payments.providerReferenceId`.

**`paymentActionUrl`** — New nullable `varchar(500)` column. Stores the Stripe-hosted invoice URL when a charge returns `requires_action` (3DS authentication needed). The dashboard reads this to render a "Complete payment" prompt. Cleared when:
- The `invoice.paid` webhook confirms payment (user completed 3DS)
- The invoice is voided or superseded
- The user replaces their card (new charge attempt will set a new URL if needed)

```typescript
// Add to billingRecords in schema/escrow.ts:
paymentActionUrl: varchar('payment_action_url', { length: 500 }),
```

### New: payment_webhook_events table

**File:** `packages/database/src/schema/billing.ts` (add to existing file)

Webhook idempotency — prevents processing the same event twice. Shared across webhook-based providers (Stripe, PayPal). **Not used for escrow** — escrow charges are synchronous on-chain.

```typescript
export const paymentWebhookEvents = pgTable('payment_webhook_events', {
  eventId: varchar('event_id', { length: 200 }).primaryKey(), // Provider's event ID
  providerType: varchar('provider_type', { length: 20 }).notNull(), // 'stripe' | 'paypal' (not escrow — synchronous)
  eventType: varchar('event_type', { length: 100 }).notNull(),
  processed: boolean('processed').notNull().default(false),
  customerId: integer('customer_id').references(() => customers.customerId),
  data: text('data'),  // JSON-encoded event payload (for debugging/audit)

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
}, (table) => ({
  idxWebhookProvider: index('idx_webhook_provider').on(table.providerType, table.eventType),
  idxWebhookCustomer: index('idx_webhook_customer')
    .on(table.customerId)
    .where(sql`${table.customerId} IS NOT NULL`),
}));
```

---

## 4. Stripe Integration

### SDK & Approach

- **Package:** `stripe` npm (server-side only)
- **API:** Invoices API (not Checkout Sessions or raw Payment Intents) — server-side billing with tax-ready path
- **Card storage:** SetupIntent (`usage: 'off_session'`) to save card with 3DS consent for future merchant-initiated charges, then Invoices for charges (Stripe creates PaymentIntents internally)
- **Invoice settings:** `auto_advance: false` (we control finalization and payment timing — prevents Stripe auto-collecting on its own schedule, which would conflict with our retry logic), `payment_settings: { payment_method_types: ['card'] }` (prevents Stripe from offering alternate payment methods on the hosted invoice page, which would bypass our provider priority logic)
- **Tax:** `automatic_tax: { enabled: false }` from day one — flip to `true` when nexus is reached (no code/schema changes)
- **Metadata:** Every Stripe Invoice carries `metadata: { billing_record_id: <id> }` so webhooks can correlate back to our `billing_records` table
- **Idempotency:** Every Stripe API call that creates or pays an invoice passes an idempotency key (`invoice-{billingRecordId}-stripe`) via the `Stripe-Idempotency-Key` header — prevents duplicate charges on network retries
- **Currency:** USD cents (matches existing billing system)

### 3DS / SCA Handling

**Problem:** European cards (and increasingly others) require 3D Secure (3DS) authentication under SCA regulation. Invoice payment may fail with `requires_action` if the underlying PaymentIntent needs authentication.

**Approach:** SetupIntent collects 3DS consent upfront; Invoices leverage this for merchant-initiated charges:

1. During card setup (SetupIntent), Stripe collects 3DS consent for future charges
2. Invoice payment uses the saved payment method — Stripe applies SCA exemptions where possible
3. If 3DS is still required (exemption denied), the invoice remains `open` with `requires_action`

**When `requires_action` occurs — full propagation path:**
1. `StripePaymentProvider.charge()` returns `{ success: false, retryable: false, errorCode: 'requires_action', hostedInvoiceUrl: '...' }`
2. `processInvoicePayment()` persists `hostedInvoiceUrl` on `billing_records.paymentActionUrl`
3. The provider chain falls through to the next provider (if any)
4. If no provider succeeds, the billing invoice enters `failed` status (periodic job retry)
5. **API surface:** The service gate throws a structured error with `cause: { errorCode: 'requires_action', paymentActionUrl }` so the frontend can render a "Complete payment" button
6. **Validation warnings:** `validateSubscription()` checks for `paymentActionUrl` on pending invoices and returns a `REQUIRES_ACTION` warning with the URL
7. The dashboard renders a "Complete payment" prompt linking to the Stripe-hosted 3DS page
8. After the user completes 3DS, the `invoice.paid` webhook confirms payment and clears `paymentActionUrl`

**This is acceptable because:**
- SetupIntent consent succeeds for most merchant-initiated charges
- The fallback to other providers handles the common case
- The manual completion path handles the edge case
- This matches how AWS/DigitalOcean handle 3DS failures

### IStripeService Interface

File: `packages/database/src/stripe/index.ts`

Follows the same pattern as `ISuiService` / `MockSuiService`:

```typescript
export interface IStripeService {
  /**
   * Create a Stripe Customer (called when user adds card as payment method)
   */
  createCustomer(params: {
    customerId: number;
    walletAddress: string;
    email?: string;
  }): Promise<{ stripeCustomerId: string }>;

  /**
   * Create a SetupIntent for saving a card.
   * The SetupIntent collects 3DS consent for future off_session charges.
   * Must set: usage: 'off_session' (enables merchant-initiated transactions).
   * Returns client_secret for frontend confirmation.
   */
  createSetupIntent(stripeCustomerId: string): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }>;

  /**
   * Charge via Stripe Invoice (merchant-initiated).
   * Creates Invoice + InvoiceItem, finalizes, and pays.
   * automatic_tax: { enabled: false } for now — flip to true when nexus reached.
   * May return requires_action if 3DS exemption is denied.
   */
  charge(params: {
    stripeCustomerId: string;
    amountUsdCents: number;
    description: string;
    idempotencyKey: string;
  }): Promise<{
    success: boolean;
    stripeInvoiceId?: string;
    error?: string;
    requiresAction?: boolean; // True if 3DS needed — card authentication required
    hostedInvoiceUrl?: string; // Stripe-hosted page for 3DS completion (if requiresAction)
    retryable: boolean;
  }>;

  /**
   * Get saved payment methods for a customer
   */
  getPaymentMethods(stripeCustomerId: string): Promise<Array<{
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
  }>>;

  /**
   * Delete a saved payment method
   */
  deletePaymentMethod(paymentMethodId: string): Promise<void>;

  /** Is this the mock implementation? */
  isMock(): boolean;
}
```

### MockStripeService

File: `packages/database/src/stripe/mock.ts`

Same pattern as `MockSuiService` — stores state in DB, supports failure injection:

```typescript
export class MockStripeService implements IStripeService {
  // In-memory storage (or new mock_stripe table)
  // Generates deterministic IDs: in_mock_xxx, cus_mock_xxx, seti_mock_xxx
  // Configurable delays and failure scenarios (matching suiMockConfig pattern)
  // Can simulate requires_action for 3DS testing
  // Creates mock invoices (not real Stripe Invoices) for unit test assertions
}

export const mockStripeService = new MockStripeService();
```

### Webhook Handler

File: `apps/api/src/routes/stripe-webhook.ts`

**Raw REST endpoint** (not tRPC) — Stripe sends raw POST body that must be verified with webhook secret before parsing:

```typescript
/**
 * POST /stripe/webhook
 *
 * Raw body required for Stripe signature verification.
 * Mounted as a Fastify route (not tRPC) because:
 * 1. Stripe sends raw JSON body (not tRPC envelope)
 * 2. Signature verification requires raw body bytes
 * 3. No auth required (verified via webhook secret)
 */
export async function stripeWebhookRoute(server: FastifyInstance) {
  server.post('/stripe/webhook', {
    config: {
      rawBody: true,  // Fastify raw body for signature verification
    },
  }, async (request, reply) => {
    // 1. Verify webhook signature (reject with 400 if invalid)
    // 2. Check payment_webhook_events table for idempotency (skip if already processed)
    // 3. Handle event types:
    //
    //    invoice.paid:
    //      a. Extract billing_record_id from invoice.metadata.billing_record_id
    //         (set by StripePaymentProvider.charge() at invoice creation time)
    //      b. Acquire customer advisory lock (withCustomerLock) — prevents race
    //         with concurrent processInvoicePayment() or periodic job
    //      c. Check billing_records.status — if already 'paid', acknowledge and skip
    //         (the synchronous charge() path already marked it paid; this is the
    //         normal case — webhook arrives after charge() returned success)
    //      d. If still 'pending'/'failed': update to 'paid', create invoice_payments
    //         row with providerReferenceId = stripeInvoiceId,
    //         clear paymentActionUrl (3DS completed)
    //         (this handles the async 3DS completion case where charge() returned
    //         requires_action and the user later completed authentication)
    //
    //    invoice.payment_failed:
    //      a. Extract billing_record_id from metadata
    //      b. Mark billing invoice failed (if not already), trigger retry
    //
    //    setup_intent.succeeded:
    //      a. Update customer_payment_methods.providerConfig with card details
    //      b. No customer lock needed (no billing state mutation)
    //
    // 4. Mark event as processed in payment_webhook_events
    // 5. Return 200 (always — Stripe retries on non-2xx)
  });
}
```

**Mount in server.ts:**

```typescript
// Mount BEFORE tRPC routes (raw body handling)
await stripeWebhookRoute(server);

// tRPC API routes
await server.register(fastifyTRPCPlugin, { ... });
```

---

## 5. Service Gate / Payment Gate Changes

The service gate currently checks `subPendingInvoiceId` + escrow balance. The new gate checks `subPendingInvoiceId` + payment method existence.

### Current Logic (services.ts toggleService, seal.ts createKey)

```typescript
if (service.subPendingInvoiceId !== null && input.enabled) {
  if (!customer.escrowContractId) { throw ... 'No escrow account' }
  if ((customer.currentBalanceUsdCents ?? 0) < tierPrice) { throw ... 'Insufficient funds' }
  // Retry payment ...
}
```

### New Logic

```typescript
if (service.subPendingInvoiceId !== null && input.enabled) {
  // Pending invoice exists — check if customer can potentially pay
  const activePaymentMethods = await tx.select()
    .from(customerPaymentMethods)
    .where(and(
      eq(customerPaymentMethods.customerId, customer.customerId),
      eq(customerPaymentMethods.status, 'active')
    ));

  if (activePaymentMethods.length === 0) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No payment method configured. Add a payment method via Billing page.',
    });
  }

  // Has methods — retry payment using provider chain
  const providers = await getCustomerProviders(customer.customerId, services, tx);
  const paymentResult = await processInvoicePayment(
    tx, service.subPendingInvoiceId, providers, clock
  );

  if (!paymentResult.fullyPaid) {
    // Provider-specific error guidance so users know exactly what to do
    const err = paymentResult.error;
    let message = 'Payment failed. Check your payment methods via Billing page.';
    let actionUrl: string | undefined;

    if (err?.errorCode === 'insufficient_escrow') {
      message = 'Insufficient escrow balance. Deposit USDC to your escrow account via the Billing page.';
    } else if (err?.errorCode === 'card_declined') {
      message = 'Your card was declined. Update your card on the Billing page.';
    } else if (err?.errorCode === 'requires_action') {
      // 3DS authentication needed — read the persisted URL
      const record = await tx.select({ paymentActionUrl: billingRecords.paymentActionUrl })
        .from(billingRecords)
        .where(eq(billingRecords.id, service.subPendingInvoiceId))
        .limit(1);
      actionUrl = record[0]?.paymentActionUrl ?? undefined;
      message = 'Your card requires authentication. Complete payment to continue.';
    }

    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message,
      // Structured cause so the frontend can render targeted UI
      cause: { errorCode: err?.errorCode, paymentActionUrl: actionUrl },
    });
  }

  // Payment succeeded — clear pending invoice + set paidOnce
  await tx.update(serviceInstances)
    .set({ subPendingInvoiceId: null, paidOnce: true })
    .where(eq(serviceInstances.instanceId, service.instanceId));
  await tx.update(customers)
    .set({ paidOnce: true })
    .where(eq(customers.customerId, customer.customerId));
}
```

**Key points:**
- `subPendingInvoiceId` logic is PRESERVED — this was missing in v2.0
- The gate now retries payment using the provider chain instead of just checking escrow balance
- If the retry succeeds (via any provider), the pending invoice is cleared and `paidOnce` is set
- `paidOnce` is set at both service and customer level (see [BILLING_DESIGN.md](./BILLING_DESIGN.md) for how it controls tier change semantics, cancellation policy, key operations, and grace period eligibility)
- If it fails, the user gets a clear error message

### Subscription validation warnings (services.ts validateSubscription)

```typescript
const activePaymentMethods = await db.select()
  .from(customerPaymentMethods)
  .where(and(
    eq(customerPaymentMethods.customerId, customer.customerId),
    eq(customerPaymentMethods.status, 'active')
  ));

if (activePaymentMethods.length === 0) {
  warnings.push({
    code: 'NO_PAYMENT_METHOD',
    message: 'No payment method configured. Add a payment method via Billing page.',
  });
} else {
  // Provider-specific warnings for escrow-only customers
  const hasNonEscrow = activePaymentMethods.some(m => m.providerType !== 'escrow');
  if (!hasNonEscrow) {
    // Escrow-only — check balance against upcoming charge
    const tierPrice = getTierPriceUsdCents(service.tier);
    if ((customer.currentBalanceUsdCents ?? 0) < tierPrice) {
      warnings.push({
        code: 'INSUFFICIENT_ESCROW',
        message: `Escrow balance ($${((customer.currentBalanceUsdCents ?? 0) / 100).toFixed(2)}) is below the tier price ($${(tierPrice / 100).toFixed(2)}). Deposit USDC or add another payment method.`,
      });
    }
  }

  // Warn if a pending invoice has a 3DS action URL (user needs to complete authentication)
  if (service.subPendingInvoiceId) {
    const record = await db.select({ paymentActionUrl: billingRecords.paymentActionUrl })
      .from(billingRecords)
      .where(eq(billingRecords.id, service.subPendingInvoiceId))
      .limit(1);
    if (record[0]?.paymentActionUrl) {
      warnings.push({
        code: 'REQUIRES_ACTION',
        message: 'Your card requires authentication. Complete payment to continue.',
        paymentActionUrl: record[0].paymentActionUrl,
      });
    }
  }
}
```

**Behavior change note:** The current gate blocks enabling when escrow balance is insufficient. The new gate allows enabling as long as ANY payment method exists — because the user may intend to pay via Stripe/PayPal. However, for **escrow-only** customers, the validator still warns about low balance so they get targeted guidance ("deposit USDC") rather than waiting for a generic charge failure.

---

## 6. Config & Secrets

**Secrets:** Stored in `~/.suiftly.env` — see [APP_SECURITY_DESIGN.md](./APP_SECURITY_DESIGN.md) for storage, format, and production safety validation.

**File:** `apps/api/src/lib/config.ts`

Add to Zod schema:

```typescript
const envSchema = z.object({
  // ... existing fields ...

  // Stripe (optional — not required if not offering card payments)
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().default(''),

  // PayPal (optional — not required if not offering PayPal)
  PAYPAL_CLIENT_ID: z.string().default(''),
  PAYPAL_CLIENT_SECRET: z.string().default(''),
  PAYPAL_WEBHOOK_ID: z.string().default(''),
});
```

---

## 7. API Endpoints

### New billing routes

**File:** `apps/api/src/routes/billing.ts`

Add to the existing tRPC billing router:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `billing.getPaymentMethods` | query | List customer's active payment methods (in priority order) |
| `billing.addPaymentMethod` | mutation | Add a new payment method (provider-specific flow) |
| `billing.removePaymentMethod` | mutation | Remove a payment method |
| `billing.reorderPaymentMethods` | mutation | Update priority ordering |
| `billing.createStripeSetupIntent` | mutation | Create Stripe SetupIntent, return clientSecret |
| `billing.getStripeCards` | query | List saved Stripe cards |

### "Add payment method" flows per provider

Each provider has a different setup flow:

**Escrow ("Pay with Crypto"):**
1. User clicks "Add Pay with Crypto"
2. If `customer.escrowContractId` is NULL → guide user to create escrow (on-chain tx via wallet)
3. Existing `findOrCreateCustomerWithEscrow()` handles this — escrowContractId set on customers table
4. Once escrowContractId exists → insert `customer_payment_methods` row with providerType='escrow'
5. User must fund escrow (deposit) before it can charge

**Stripe ("Credit/Debit Card"):**
1. User clicks "Add Credit/Debit Card"
2. Backend creates Stripe Customer if `customer.stripeCustomerId` is NULL
3. Backend creates SetupIntent → returns `clientSecret` to frontend
4. Frontend uses Stripe.js to collect card details + handle 3DS
5. On success → webhook fires `setup_intent.succeeded`
6. Backend inserts `customer_payment_methods` row with providerType='stripe', providerRef=paymentMethodId, providerConfig={ brand, last4, ... }

**PayPal:**
1. User clicks "Add PayPal"
2. Backend creates PayPal billing agreement → returns approval URL
3. User redirected to PayPal → authorizes
4. PayPal redirects back → backend captures agreement ID
5. Backend inserts `customer_payment_methods` row with providerType='paypal', providerRef=billingAgreementId, providerConfig={ email }

```typescript
// Example: addPaymentMethod
addPaymentMethod: protectedProcedure
  .input(z.object({
    providerType: z.enum(['escrow', 'stripe', 'paypal']),
  }))
  .mutation(async ({ ctx, input }) => {
    const customer = await getCustomerByWallet(ctx.db, ctx.walletAddress);

    // Check if already has this provider type active
    const existing = await ctx.db.select()
      .from(customerPaymentMethods)
      .where(and(
        eq(customerPaymentMethods.customerId, customer.customerId),
        eq(customerPaymentMethods.providerType, input.providerType),
        eq(customerPaymentMethods.status, 'active')
      ))
      .limit(1);

    if (existing.length > 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Payment method already added' });
    }

    // Provider-specific setup (see flows above)
    switch (input.providerType) {
      case 'escrow':
        if (!customer.escrowContractId) {
          // Guide user to create escrow first
          return { needsSetup: true, setupType: 'create_escrow' };
        }
        // Escrow exists — just register as payment method
        break;

      case 'stripe':
        // Create Stripe customer + SetupIntent
        // Return clientSecret for frontend card collection
        return { needsSetup: true, setupType: 'stripe_setup_intent', clientSecret: '...' };

      case 'paypal':
        // Create billing agreement
        return { needsSetup: true, setupType: 'paypal_approval', approvalUrl: '...' };
    }

    // ... insert customer_payment_methods row ...
  }),
```

---

## 8. Files to Modify

| File | Change |
|------|--------|
| `packages/database/src/billing/payments.ts` | Refactor to use provider chain |
| `packages/database/src/billing/types.ts` | Add `'stripe'` and `'paypal'` to payment source types |
| `packages/database/src/billing/service-billing.ts` | Pass providers instead of suiService |
| `packages/database/src/billing/processor.ts` | Pass providers instead of suiService |
| `packages/database/src/billing/periodic-job.ts` | Pass providers instead of suiService |
| `packages/database/src/schema/billing.ts` | Add `customer_payment_methods`, `payment_webhook_events`, update `invoice_payments` |
| `packages/database/src/schema/escrow.ts` | Add `paymentActionUrl` to `billing_records` |
| `packages/database/src/schema/customers.ts` | Add `stripeCustomerId` column |
| `packages/database/src/schema/index.ts` | Export new tables |
| `apps/api/src/routes/billing.ts` | Add payment method management endpoints |
| `apps/api/src/routes/services.ts` | Update gate to check `customer_payment_methods` + preserve `subPendingInvoiceId` |
| `apps/api/src/routes/seal.ts` | Update gate to check `customer_payment_methods` + preserve `subPendingInvoiceId` |
| `apps/api/src/lib/config.ts` | Add Stripe + PayPal env vars + safety checks |
| `apps/api/src/server.ts` | Mount webhook routes before tRPC |

## 9. New Files

| File | Purpose |
|------|---------|
| `packages/shared/src/payment-provider/types.ts` | `IPaymentProvider` interface |
| `packages/database/src/billing/providers/escrow-provider.ts` | Wraps `ISuiService` |
| `packages/database/src/billing/providers/stripe-provider.ts` | Stripe Invoices |
| `packages/database/src/billing/providers/paypal-provider.ts` | PayPal Orders |
| `packages/database/src/billing/providers/index.ts` | Provider resolution (reads customer priority) |
| `packages/database/src/stripe/index.ts` | `IStripeService` interface |
| `packages/database/src/stripe/mock.ts` | `MockStripeService` |
| `apps/api/src/routes/stripe-webhook.ts` | Stripe webhook handler (raw REST) |
| `apps/api/src/routes/paypal-webhook.ts` | PayPal webhook handler (raw REST) |

---

## 10. Testing

### MockStripeService (Unit/Integration Tests)

Follows the `MockSuiService` pattern (`packages/database/src/sui-mock/mock.ts`):
- In-memory state with deterministic IDs (`cus_mock_1`, `in_mock_1`, etc.)
- Configurable failure injection via `stripeMockConfig` (same API as `suiMockConfig`)
- Configurable delays for UI testing
- Can simulate `requires_action` for 3DS testing
- Records invoices for audit trail assertions

**Used for:** TDD, unit tests, CI pipeline — fast, deterministic, no external dependency.

### Stripe Sandbox (Integration Tests)

Use Stripe's test mode (`sk_test_...`) for integration tests that verify actual API behavior:

- **Test cards:** `4242 4242 4242 4242` (success), `4000 0000 0000 0002` (decline), `4000 0027 6000 3184` (3DS required)
- **Test clocks:** Advance time to simulate monthly billing cycles without waiting 30 days
- **Invoice lifecycle:** Create → Finalize → Pay → `invoice.paid` webhook — verified end-to-end
- **Webhook testing:** Use `stripe listen --forward-to localhost:PORT/stripe/webhook` (Stripe CLI) during development
- **Tax dry run:** Test `automatic_tax: { enabled: true }` with test-mode tax calculations (no 0.5% fee in test mode)

**CI strategy:**
| Suite | Runs on | Uses | Speed |
|-------|---------|------|-------|
| Unit tests (MockStripeService) | Every commit | Mock | Fast (~seconds) |
| Sandbox integration tests | Nightly + pre-release | Stripe test mode | Slower (~30s) |

Sandbox tests are safe for CI — Stripe's test mode is rate-limited at 25 req/s (sufficient for testing), has no costs, and is highly available. The nightly cadence catches API changes or regressions without slowing down the main CI pipeline. For pre-release, sandbox tests provide confidence that the actual Stripe integration works before deploying.

**Sandbox test keys:** Stored as CI secrets (`STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`). These are test-mode keys — no risk of real charges.

### Test Coverage

| Test | What it verifies | Suite |
|------|-----------------|-------|
| Provider chain — credits only | Full payment with credits, no provider called | Unit |
| Provider chain — credits + first provider | Partial credits, remainder charged to first-priority provider | Unit |
| Provider chain — first provider fails, fallback | First provider fails, falls through to second | Unit |
| Provider chain — all fail | Credits applied, all providers fail, invoice FAILED | Unit |
| Provider chain — priority order respected | Providers called in customer's priority order | Unit |
| Stripe charge — success | Invoice created + paid, invoice_payment recorded | Unit |
| Stripe charge — card declined | Retryable error, correct error message | Unit |
| Stripe charge — requires_action (3DS) | Non-retryable, falls through to next provider, persists paymentActionUrl | Unit |
| 3DS — service gate returns structured error | Gate error includes errorCode + paymentActionUrl in cause | Unit |
| 3DS — webhook clears paymentActionUrl | invoice.paid webhook clears billing_records.paymentActionUrl | Unit |
| 3DS — validation warning | validateSubscription returns REQUIRES_ACTION with URL | Unit |
| Stripe charge — idempotency | Same idempotency key returns cached result | Unit |
| Webhook — invoice.paid | Billing invoice updated to PAID | Unit |
| Webhook — duplicate event | payment_webhook_events idempotency prevents double-processing | Unit |
| Webhook — invalid signature | Rejected with 400 | Unit |
| Payment methods — add/remove/reorder | customer_payment_methods CRUD | Unit |
| Service gate — no methods, pending invoice | Enabling blocked | Unit |
| Service gate — method exists, pending invoice | Retries payment via provider chain | Unit |
| Service gate — no pending invoice | Normal enable flow | Unit |
| Service gate — escrow-only, $0 balance | Returns 'insufficient_escrow' errorCode with targeted message | Unit |
| Validation — escrow-only, low balance | INSUFFICIENT_ESCROW warning with amounts | Unit |
| SetupIntent → Invoice → paid webhook | Full lifecycle with real Stripe API | Sandbox |
| Invoice with automatic_tax | Tax calculation returns valid amounts | Sandbox |
| Card decline + retry with new card | Full recovery flow | Sandbox |
| Test clock — monthly billing cycle | Simulated 30-day cycle, invoice auto-created | Sandbox |

### Update existing tests

All existing billing tests pass `suiService: ISuiService` to `processInvoicePayment()`. Update to pass `providers: IPaymentProvider[]`:

```typescript
// Before
const result = await processInvoicePayment(tx, invoiceId, mockSuiService, clock);

// After
const providers = await getCustomerProviders(customerId, services, tx);
const result = await processInvoicePayment(tx, invoiceId, providers, clock);
```

### sudob reset-all

Update the sudob `/api/test/reset-all` endpoint to also clear payment-related data:
- Truncate `payment_webhook_events` table
- Truncate `customer_payment_methods` table
- Clear `stripeCustomerId` from `customers`

---

## 11. Implementation Order

| Step | Description | Dependencies |
|------|-------------|-------------|
| 1 | Schema changes (customers, customer_payment_methods, payment_webhook_events, invoice_payments) | None |
| 2 | `IPaymentProvider` interface + types | None |
| 3 | `IStripeService` interface + `MockStripeService` | None |
| 4 | `EscrowPaymentProvider` (extract from payments.ts) | Steps 1-2 |
| 5 | `StripePaymentProvider` | Steps 1-3 |
| 6 | Provider resolution (reads customer priority) | Steps 4-5 |
| 7 | Refactor `processInvoicePayment()` | Step 6 |
| 8 | Update all callers (processor, service-billing, periodic-job) | Step 7 |
| 9 | Config changes (Stripe + PayPal env vars) | None |
| 10 | Webhook routes (Stripe, PayPal stubs) | Steps 1, 3 |
| 11 | Billing API endpoints (add/remove/reorder payment methods) | Steps 1, 6 |
| 12 | Service gate updates (services.ts, seal.ts) — preserve `subPendingInvoiceId` | Steps 1, 7 |
| 13 | Update existing tests | Steps 7-8 |
| 14 | New provider-specific tests | Steps 5, 10-11 |
| 15 | Update sudob reset-all | Step 1 |
| 16 | PayPal provider (can be deferred) | Steps 1-2 |

---

## 12. Non-Goals (Out of Scope)

- **Stripe Checkout Sessions** — We use Invoices API to keep UX in-app and control billing ourselves
- **Stripe Subscriptions** — We manage subscriptions ourselves (billing processor); Stripe Invoices are used only as the charge mechanism
- **Raw Payment Intents** — Invoices API creates PaymentIntents internally; we don't use the PaymentIntents API directly. This gives us tax-ready invoices and compliant invoice documents from day one
- **Multi-currency** — USD only (matches existing billing system)
- **Partial charges across providers** — One provider pays the full remaining amount
- **Multiple methods per provider type (MVP)** — One Stripe card, one escrow, one PayPal per customer. DB supports multiples; app-level check is the only constraint. Relaxing this (e.g., multi-card with within-provider fallback) is a near-term enhancement requiring only app-code changes (see Design Decisions)
- **Frontend changes** — Covered in a separate UI design doc
- **Tax collection (for now)** — `automatic_tax: { enabled: false }` ships day one. When nexus is reached, flip to `true` — no code or schema changes needed. Stripe Tax handles calculation, collection, and reporting at 0.5% per transaction
- **Stripe Connect** — Not needed (we're the merchant)
- **Refunds / chargebacks** — Handled via existing credits system for now; Stripe/PayPal dispute handling is post-MVP

---

## 13. Design Decisions

### `escrowContractId` stays on `customers` table

The escrow contract address and balance are deeply integrated with:
- `findOrCreateCustomerWithEscrow()` — immutability + conflict detection
- `ISuiService.charge()` — needs `escrowAddress` parameter
- `customers.currentBalanceUsdCents` — blockchain-synced balance
- Service gate checks reading `customer.escrowContractId` directly

Moving these to `customer_payment_methods` would require refactoring the entire escrow/blockchain sync layer for no benefit. Similarly, `stripeCustomerId` is added to `customers` because it's a customer-level account identifier used across all Stripe API calls.

`customer_payment_methods` tracks **which methods are enabled and in what order**, not the provider account data.

### Payment method limits per provider type

Current application-level limits (can be relaxed without DB migration):
- **Escrow:** One per customer (enforced by app-level pre-check; DB index skips NULL providerRef)
- **Stripe:** One card per customer (enforced by app-level pre-check; DB index prevents duplicate `provider_ref` / same card added twice). Multiple cards supported at DB level — relax the app check when ready.
- **PayPal:** One billing agreement per customer (app-level pre-check)

The DB unique index is on `(customer_id, provider_ref) WHERE active AND NOT NULL`, so adding multi-card support later only requires changing the application code — no schema migration.

**Lost/expired card handling:** When a card charge fails with `card_declined`, the payment method remains `active` (the user may want to retry after updating with their bank). The dashboard shows a targeted "Update your card" prompt via the structured error payload. The user can remove the card and add a new one — or, once multi-card support is added, add a second card as fallback. The system does NOT auto-demote or auto-remove failed cards, since declines can be transient (e.g., fraud hold that the user resolves with their bank).

### `displayLabel` for escrow is computed live

Escrow balance changes with every deposit/withdrawal/charge. Caching it in `customer_payment_methods.providerConfig` would show stale data. Instead:
- `EscrowPaymentProvider.getInfo()` reads `customers.currentBalanceUsdCents` directly
- The `billing.getPaymentMethods` API endpoint computes escrow display info at query time
- Stripe/PayPal display data (card brand, email) is cached in `providerConfig` because it rarely changes

### `invoice_payments` uses hybrid FK + generic reference

Local payment sources (credits, escrow) keep typed foreign keys for referential integrity. External providers (Stripe, PayPal) use a generic `providerReferenceId` varchar — the external system is the source of record. This scales to new providers without schema changes.

### Service gate preserves `subPendingInvoiceId` and sets `paidOnce`

The `subPendingInvoiceId` mechanism on `service_instances` is preserved. The gate logic is:
1. If `subPendingInvoiceId` is NULL → normal enable flow (no payment gate)
2. If `subPendingInvoiceId` is set → must have at least one active payment method → retry payment via provider chain → clear on success → set `paidOnce` on both service and customer

This prevents the scenario where a user bypasses a pending invoice just by adding any payment method.

**`paidOnce` is set by the payment gate and `handleSubscriptionBilling()`** — not by payment method setup. It proves the customer can actually pay (not just that they configured a method). See [BILLING_DESIGN.md](./BILLING_DESIGN.md) for how `paidOnce` controls tier change semantics (immediate vs. scheduled), cancellation policy (immediate delete vs. end-of-period), key operations (blocked until paid), and grace period eligibility.

### Webhook–charge race protection

When a Stripe Invoice is paid synchronously (no 3DS), two paths converge:
1. `StripePaymentProvider.charge()` returns success → `processInvoicePayment()` marks billing record `paid`
2. Stripe fires `invoice.paid` webhook → webhook handler also tries to mark it `paid`

**Protection (three layers):**
1. **Billing record status check:** The webhook handler checks `billing_records.status` under customer advisory lock. If already `paid`, it acknowledges the webhook but skips processing (no-op).
2. **`providerReferenceId` UNIQUE constraint:** The `invoice_payments` table has a unique index on `provider_reference_id WHERE NOT NULL`. If both paths try to insert the same Stripe Invoice ID, the second insert fails at the DB level.
3. **`payment_webhook_events` idempotency:** The webhook event ID is recorded before processing. Duplicate webhook deliveries from Stripe are rejected.

The webhook handler is essential for the **async 3DS case**: when `charge()` returned `requires_action` and the user later completes authentication on the Stripe-hosted page, the `invoice.paid` webhook is the only signal that payment succeeded.

---

**Version:** 4.2
**Last Updated:** 2026-02-19
