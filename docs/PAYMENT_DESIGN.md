# Multi-Provider Payment System

Add payment provider abstraction supporting multiple payment methods with user-defined priority ordering and automatic fallback.

**Related:** [BILLING_DESIGN.md](./BILLING_DESIGN.md), [ESCROW_DESIGN.md](./ESCROW_DESIGN.md), [CUSTOMER_SERVICE_SCHEMA.md](./CUSTOMER_SERVICE_SCHEMA.md)

---

## Overview

The billing system currently hard-codes escrow as the only charge method in `processInvoicePayment()` (`packages/database/src/billing/payments.ts`). This design adds a payment provider abstraction supporting multiple payment methods as equals, with customer credits retaining highest precedence (already implemented).

### Payment Methods

All payment methods are equal at the priority/ordering layer — none gets hardcoded priority. However, each provider has different setup flows and runtime characteristics (see [Design Decisions](#13-design-decisions)):

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
}

export interface ProviderChargeResult {
  success: boolean;
  /** Reference ID for invoice_payments (escrow tx ID, Stripe payment intent ID, PayPal order ID) */
  referenceId?: string;
  /**
   * Provider-specific transaction digest (escrow only).
   * Used to set billing_records.txDigest for on-chain traceability.
   * NULL for Stripe/PayPal — billing_records.txDigest stays NULL for those.
   */
  txDigest?: Buffer;
  error?: string;
  retryable: boolean;
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

Uses Stripe Payment Intents API with `off_session` for background charges:

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
    // 2. Create PaymentIntent with off_session: true, confirm: true
    // 3. Handle 'requires_action' → return { success: false, retryable: false }
    //    (see 3DS/SCA section below)
    // 4. Return { referenceId: paymentIntentId }
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
// Step 1: Apply credits (unchanged - applyCreditsToInvoice())
const creditResult = await applyCreditsToInvoice(tx, customerId, billingRecordId, remainingAmount, clock);
// ... record credit payment sources in invoice_payments (unchanged) ...

// Step 2: For remaining amount, iterate providers in user's priority order
if (creditResult.remainingInvoiceAmountCents > 0) {
  let charged = false;
  let lastError: BillingError | undefined;

  for (const provider of providers) {
    if (!await provider.canPay(customerId, creditResult.remainingInvoiceAmountCents)) {
      continue;
    }

    const chargeResult = await provider.charge({
      customerId,
      amountUsdCents: creditResult.remainingInvoiceAmountCents,
      invoiceId: billingRecordId,
      description: `Invoice ${billingRecordId}`,
    });

    if (chargeResult.success) {
      // Create invoice_payments row (processInvoicePayment's responsibility)
      await tx.insert(invoicePayments).values({
        billingRecordId,
        sourceType: provider.type,
        // For escrow: set escrowTransactionId from referenceId
        // For stripe/paypal: set providerReferenceId from referenceId
        ...(provider.type === 'credit'
          ? { creditId: Number(chargeResult.referenceId) }
          : provider.type === 'escrow'
            ? { escrowTransactionId: Number(chargeResult.referenceId) }
            : { providerReferenceId: chargeResult.referenceId }),
        amountUsdCents: creditResult.remainingInvoiceAmountCents,
      });

      result.paymentSources.push({
        type: provider.type,
        amountCents: creditResult.remainingInvoiceAmountCents,
        referenceId: chargeResult.referenceId!,
      });
      result.amountPaidCents += creditResult.remainingInvoiceAmountCents;
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
      customerId,
      invoiceId: billingRecordId,
      retryable: chargeResult.retryable,
    };
  }

  if (!charged) {
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

// NOTE: The unique constraint (one active method per provider type per customer) must be
// created as a partial unique INDEX in the migration SQL, because Drizzle ORM's unique()
// does not support WHERE clauses:
//
//   CREATE UNIQUE INDEX uniq_customer_provider_active
//   ON customer_payment_methods (customer_id, provider_type)
//   WHERE status = 'active';
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

  // Generic reference for external providers (Stripe payment intent ID, PayPal order ID)
  // External system is the source of record — no local FK needed
  providerReferenceId: varchar('provider_reference_id', { length: 200 }),

  amountUsdCents: bigint('amount_usd_cents', { mode: 'number' }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxPaymentBillingRecord: index('idx_payment_billing_record').on(table.billingRecordId),
  idxPaymentCredit: index('idx_payment_credit').on(table.creditId).where(sql`${table.creditId} IS NOT NULL`),
  idxPaymentEscrow: index('idx_payment_escrow').on(table.escrowTransactionId).where(sql`${table.escrowTransactionId} IS NOT NULL`),
  idxPaymentProvider: index('idx_payment_provider').on(table.providerReferenceId).where(sql`${table.providerReferenceId} IS NOT NULL`),

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

### billing_records.txDigest

**No change.** The `txDigest` column (`bytea`) on `billing_records` remains. It stores the on-chain transaction digest for escrow payments. For Stripe/PayPal payments, it stays `NULL`. The Stripe payment intent ID and PayPal order ID are stored in `invoice_payments.providerReferenceId`.

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
- **API:** Payment Intents API (not Checkout Sessions) — keeps UX in-app
- **Card storage:** SetupIntent to save card -> PaymentIntent with `off_session: true, confirm: true` for charges
- **Currency:** USD cents (matches existing billing system)

### 3DS / SCA Handling

**Problem:** European cards (and increasingly others) require 3D Secure (3DS) authentication under SCA regulation. Server-side charges with `confirm: true` will return `requires_action` instead of completing.

**Approach:** Use `off_session: true` to indicate the charge is merchant-initiated:

1. During card setup (SetupIntent), Stripe collects 3DS consent for future charges
2. Background charges use `off_session: true` — Stripe applies exemptions where possible
3. If 3DS is still required (exemption denied), the charge fails with `requires_action`

**When `requires_action` occurs:**
- `StripePaymentProvider.charge()` returns `{ success: false, retryable: false, error: 'Card requires authentication' }`
- The provider chain falls through to the next provider (if any)
- If no provider succeeds, the invoice enters the normal retry/grace period flow
- The dashboard shows a "Complete payment" prompt linking to a Stripe-hosted 3DS page
- After the user completes 3DS, the webhook confirms payment and updates the invoice

**This is acceptable because:**
- `off_session` with prior SetupIntent consent succeeds for most charges
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
   * Returns client_secret for frontend confirmation.
   */
  createSetupIntent(stripeCustomerId: string): Promise<{
    clientSecret: string;
    setupIntentId: string;
  }>;

  /**
   * Charge a saved payment method (off_session, merchant-initiated).
   * May return requires_action if 3DS exemption is denied.
   */
  charge(params: {
    stripeCustomerId: string;
    amountUsdCents: number;
    description: string;
    idempotencyKey: string;
  }): Promise<{
    success: boolean;
    paymentIntentId?: string;
    error?: string;
    requiresAction?: boolean; // True if 3DS needed — card authentication required
    clientSecret?: string;    // For frontend 3DS completion (if requiresAction)
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
  // Generates deterministic IDs: pi_mock_xxx, cus_mock_xxx, seti_mock_xxx
  // Configurable delays and failure scenarios (matching suiMockConfig pattern)
  // Can simulate requires_action for 3DS testing
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
    // 1. Verify webhook signature
    // 2. Check payment_webhook_events table for idempotency
    // 3. Handle event types:
    //    - payment_intent.succeeded: Update invoice status to PAID
    //    - payment_intent.payment_failed: Mark invoice failed, trigger retry
    //    - setup_intent.succeeded: Update customer_payment_methods.providerConfig with card details
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
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Payment failed. Check your payment methods via Billing page.',
    });
  }

  // Payment succeeded — clear pending invoice
  await tx.update(serviceInstances)
    .set({ subPendingInvoiceId: null })
    .where(eq(serviceInstances.instanceId, service.instanceId));
}
```

**Key points:**
- `subPendingInvoiceId` logic is PRESERVED — this was missing in v2.0
- The gate now retries payment using the provider chain instead of just checking escrow balance
- If the retry succeeds (via any provider), the pending invoice is cleared
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
}
// NOTE: With multiple providers, balance warnings are less useful.
// A user with $0 escrow but a valid Stripe card is fine.
// Only warn if there are NO methods at all.
```

**Behavior change note:** The current gate blocks enabling when escrow balance is insufficient. The new gate allows enabling as long as ANY payment method exists — even if escrow has $0 — because the user may intend to pay via Stripe/PayPal. The actual payment validation happens at charge time via `canPay()`.

---

## 6. Config & Secrets

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

**Storage:** `~/.suiftly.env` (same pattern as existing secrets)

```bash
# Add to ~/.suiftly.env
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
PAYPAL_CLIENT_ID=xxx
PAYPAL_CLIENT_SECRET=xxx
PAYPAL_WEBHOOK_ID=xxx
```

**Production safety** (add to `validateSecretSafety()`):

```typescript
if (isProd || isProduction) {
  if (config.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('FATAL: Production using Stripe TEST key! Use sk_live_xxx.');
  }
  if (config.PAYPAL_CLIENT_ID.startsWith('sb-')) {
    throw new Error('FATAL: Production using PayPal SANDBOX key!');
  }
}
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
| `packages/database/src/billing/providers/stripe-provider.ts` | Stripe Payment Intents |
| `packages/database/src/billing/providers/paypal-provider.ts` | PayPal Orders |
| `packages/database/src/billing/providers/index.ts` | Provider resolution (reads customer priority) |
| `packages/database/src/stripe/index.ts` | `IStripeService` interface |
| `packages/database/src/stripe/mock.ts` | `MockStripeService` |
| `apps/api/src/routes/stripe-webhook.ts` | Stripe webhook handler (raw REST) |
| `apps/api/src/routes/paypal-webhook.ts` | PayPal webhook handler (raw REST) |

---

## 10. Testing

### MockStripeService

Follows the `MockSuiService` pattern (`packages/database/src/sui-mock/mock.ts`):
- In-memory state with deterministic IDs (`cus_mock_1`, `pi_mock_1`, etc.)
- Configurable failure injection via `stripeMockConfig` (same API as `suiMockConfig`)
- Configurable delays for UI testing
- Can simulate `requires_action` for 3DS testing
- Records transactions for audit trail assertions

### Test Coverage

| Test | What it verifies |
|------|-----------------|
| Provider chain — credits only | Full payment with credits, no provider called |
| Provider chain — credits + first provider | Partial credits, remainder charged to first-priority provider |
| Provider chain — first provider fails, fallback | First provider fails, falls through to second |
| Provider chain — all fail | Credits applied, all providers fail, invoice FAILED |
| Provider chain — priority order respected | Providers called in customer's priority order |
| Stripe charge — success | PaymentIntent created, invoice_payment recorded |
| Stripe charge — card declined | Retryable error, correct error message |
| Stripe charge — requires_action (3DS) | Non-retryable, falls through to next provider |
| Stripe charge — idempotency | Same idempotency key returns cached result |
| Webhook — payment_intent.succeeded | Invoice updated to PAID |
| Webhook — duplicate event | payment_webhook_events idempotency prevents double-processing |
| Webhook — invalid signature | Rejected with 400 |
| Payment methods — add/remove/reorder | customer_payment_methods CRUD |
| Service gate — no methods, pending invoice | Enabling blocked |
| Service gate — method exists, pending invoice | Retries payment via provider chain |
| Service gate — no pending invoice | Normal enable flow |

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

- **Stripe Checkout Sessions** — We use Payment Intents to keep UX in-app
- **Stripe Subscriptions** — We manage subscriptions ourselves (billing processor)
- **Multi-currency** — USD only (matches existing billing system)
- **Partial charges across providers** — One provider pays the full remaining amount
- **Multiple methods per provider type** — One Stripe card, one escrow, one PayPal per customer (see Design Decisions)
- **Frontend changes** — Covered in a separate UI design doc
- **Tax compliance** — Post-MVP (see BILLING_DESIGN.md)
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

### One payment method per provider type

Intentional constraint for MVP simplicity:
- **Escrow:** One escrow contract per customer (enforced by `findOrCreateCustomerWithEscrow()`)
- **Stripe:** One default card per customer. Stripe itself supports multiple cards under one Customer, but we use the Stripe-side default. Users can replace their card (remove + re-add) via the Billing page.
- **PayPal:** One billing agreement per customer

This avoids complexity in the priority ordering UI and the charge flow. If needed later, the schema supports multiple entries per provider type by removing the partial unique index.

### `displayLabel` for escrow is computed live

Escrow balance changes with every deposit/withdrawal/charge. Caching it in `customer_payment_methods.providerConfig` would show stale data. Instead:
- `EscrowPaymentProvider.getInfo()` reads `customers.currentBalanceUsdCents` directly
- The `billing.getPaymentMethods` API endpoint computes escrow display info at query time
- Stripe/PayPal display data (card brand, email) is cached in `providerConfig` because it rarely changes

### `invoice_payments` uses hybrid FK + generic reference

Local payment sources (credits, escrow) keep typed foreign keys for referential integrity. External providers (Stripe, PayPal) use a generic `providerReferenceId` varchar — the external system is the source of record. This scales to new providers without schema changes.

### Service gate preserves `subPendingInvoiceId`

The `subPendingInvoiceId` mechanism on `service_instances` is preserved. The gate logic is:
1. If `subPendingInvoiceId` is NULL → normal enable flow (no payment gate)
2. If `subPendingInvoiceId` is set → must have at least one active payment method → retry payment via provider chain → clear on success

This prevents the scenario where a user bypasses a pending invoice just by adding any payment method.

---

**Version:** 3.0
**Last Updated:** 2026-02-13
