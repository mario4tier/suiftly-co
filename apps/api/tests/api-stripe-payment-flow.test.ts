/**
 * API Test: Stripe Payment Flow
 *
 * Tests the Stripe payment path through tRPC endpoints, verifying:
 * - Stripe as sole payment provider (subscribe, charge, billing records)
 * - Stripe charge failure handling (mock config for declined, retryable errors)
 * - Stripe retry after fixing mock config
 * - Billing record and invoice_payment population after Stripe charge
 * - Provider chain: Stripe fallback when escrow fails
 *
 * All tests use MockStripeService (no real Stripe API calls).
 * Uses /test/stripe/config to control mock behavior.
 * Platform subscription is the billing trigger (starter = $2/month).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import {
  customers,
  serviceInstances,
  customerPaymentMethods,
} from '@suiftly/database/schema';
import { billingRecords } from '@suiftly/database/schema';
import { invoicePayments } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  advanceClock,
  trpcMutation,
  restCall,
  resetTestData,
  ensureTestBalance,
  runPeriodicBillingJob,
  addStripePaymentMethod,
  reconcilePendingPayments,
  waitForGMSyncCustomer,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { clearNotifications, expectNotifications, expectNoNotifications } from './helpers/notifications.js';
import { waitForState } from './helpers/wait-for-state.js';

/**
 * Find a Stripe payment across all paid billing records.
 */
async function findStripePayment(paidRecords: { id: number }[]) {
  for (const pr of paidRecords) {
    const payments = await db.select()
      .from(invoicePayments)
      .where(eq(invoicePayments.billingRecordId, pr.id));
    const found = payments.find(p => p.sourceType === 'stripe');
    if (found) return found;
  }
  return undefined;
}

describe('API: Stripe Payment Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);

    accessToken = await login(TEST_WALLET);

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found');
    customerId = customer.customerId;

    // Small balance — insufficient for platform Pro ($39) so Stripe handles it.
    // Note: ensureTestBalance auto-adds escrow as a payment method, but $2 is
    // insufficient for Pro ($39), so Stripe handles payment in tests using Pro tier.
    await ensureTestBalance(2, { walletAddress: TEST_WALLET });
    await clearNotifications(customerId);

    // Force mock Stripe service (even if STRIPE_SECRET_KEY is configured)
    await restCall('POST', '/test/stripe/force-mock', { enabled: true });
    // Clear stripe mock config
    await restCall('POST', '/test/stripe/config/clear');
  });

  afterEach(async () => {
    await resetClock();
    await restCall('POST', '/test/stripe/config/clear');
    await restCall('POST', '/test/stripe/force-mock', { enabled: false });
    await resetTestData(TEST_WALLET);
  });

  // =========================================================================
  // Stripe as sole provider — successful subscription charge
  // =========================================================================
  describe('Stripe as sole provider', () => {
    it('should charge via Stripe when it is the only payment method', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Add stripe as only payment method (setup + webhook)
      await addStripePaymentMethod(accessToken);

      // Subscribe to platform pro ($39/month) — Stripe handles the charge (escrow has only $2)
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(false);
      expect(result.result?.data.tier).toBe('pro');

      // Verify billing record was created and marked as paid
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      const stripePayment = await findStripePayment(paidRecords);
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBeDefined();
      expect(stripePayment!.amountUsdCents).toBeGreaterThan(0);

      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Stripe charge declined — retryable vs non-retryable
  // =========================================================================
  describe('Stripe charge failure', () => {
    it('should leave payment pending when Stripe charge is declined', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Add stripe as only payment method (setup + webhook)
      await addStripePaymentMethod(accessToken);

      // Subscribe — Stripe declines, payment should be pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(true);

      // Verify customer has pending invoice
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.pendingInvoiceId).not.toBeNull();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should leave payment pending when Stripe charge fails with generic error', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to fail with generic error
      await restCall('POST', '/test/stripe/config', {
        forceChargeFailure: true,
        forceChargeFailureMessage: 'Processing error',
      });

      await addStripePaymentMethod(accessToken);

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(true);
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Stripe retry (subscribe without payment → add Stripe → reconcile)
  // =========================================================================
  describe('Stripe retry after adding payment method', () => {
    it('should pay pending invoice via Stripe when reconciled after adding Stripe', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe without any payment methods → payment pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Add Stripe as payment method (setup + webhook)
      await addStripePaymentMethod(accessToken);

      // Reconcile pending payments → retries platform pending invoice via Stripe
      await reconcilePendingPayments(customerId);

      // Verify pending invoice was cleared. Poll — GM-async commit.
      const customer = await waitForState(
        () => db.query.customers.findFirst({
          where: eq(customers.customerId, customerId),
        }),
        (c) => c?.pendingInvoiceId === null,
        `customer.pendingInvoiceId cleared after reconcile`,
      );
      expect(customer?.pendingInvoiceId).toBeNull();

      // Verify billing record is now paid with Stripe source
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      const stripePayment = await findStripePayment(paidRecords);
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBeDefined();

      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Provider chain: escrow insufficient → Stripe fallback
  // =========================================================================
  describe('Escrow to Stripe fallback', () => {
    it('should use Stripe when escrow has insufficient funds and verify billing record', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Create escrow with $0 (insufficient for $2 platform starter)
      await ensureTestBalance(0, { walletAddress: TEST_WALLET });

      // Add escrow (priority 1) + stripe (priority 2)
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await addStripePaymentMethod(accessToken);

      // Subscribe — escrow fails (insufficient), stripe succeeds
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(false);

      // Verify the invoice_payment source is stripe (not escrow)
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      const stripePayment = await findStripePayment(paidRecords);
      expect(stripePayment).toBeDefined();
      expect(stripePayment!.providerReferenceId).toBeDefined();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // 3DS requires_action — Stripe requires authentication
  // =========================================================================
  describe('Stripe 3DS (requires_action)', () => {
    it('should leave payment pending and set paymentActionUrl when Stripe requires 3DS', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add stripe as only payment method (setup + webhook)
      await addStripePaymentMethod(accessToken);

      // Subscribe — Stripe requires 3DS, payment should be pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(true);

      // Verify paymentActionUrl was set on the billing record.
      // 3DS invoices stay 'pending' (not 'failed') — the customer can complete
      // verification, and the invoice.paid webhook will reconcile.
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const pendingRecords = records.filter(r => r.status === 'pending' && r.paymentActionUrl);
      expect(pendingRecords.length).toBeGreaterThanOrEqual(1);
      expect(pendingRecords[0].paymentActionUrl).toContain('https://invoice.stripe.com/');
      await expectNoNotifications(customerId, { tolerateGM: true });
    });

    it('should NOT auto-resolve 3DS pending invoice when reconciled (requires manual authentication)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add Stripe BEFORE subscribing. This triggers a GM async sync, but there are
      // no pending invoices yet, so GM is a no-op. If we subscribed first, the initial
      // subscribe would fail (escrow only has $2, pro is $39) → 'failed' billing record.
      // Then addStripePaymentMethod would trigger GM, which resolves it using GM's own
      // Stripe mock (separate process, doesn't have forceChargeRequiresAction configured).
      await addStripePaymentMethod(accessToken);

      // Wait for GM to finish processing the sync-customer (it's a no-op but needs to complete
      // before subscribe, so GM doesn't interfere with the subscribe's 3DS billing record)
      await waitForGMSyncCustomer(customerId);

      // Subscribe — escrow ($2) insufficient for Pro ($39), Stripe requires 3DS → pending
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Reconcile — Stripe still requires 3DS, so invoice stays pending
      await reconcilePendingPayments(customerId);

      // Verify: customer still has pending invoice (3DS can't be done server-side)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.pendingInvoiceId).not.toBeNull();

      // Verify: billing record still has paymentActionUrl (not auto-resolved)
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const pendingRecord = records.find(r => r.status === 'pending' && r.paymentActionUrl);
      expect(pendingRecord).toBeDefined();

      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Stripe card declined is non-retryable
  // =========================================================================
  describe('Card declined retryable behavior', () => {
    it('should treat card_declined as non-retryable (billing record has failed status)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      await addStripePaymentMethod(accessToken);

      // Subscribe — Stripe declines
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      // Verify billing record is failed (not retryable = not retried automatically)
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecord = records.find(r => r.status === 'failed');
      expect(failedRecord).toBeDefined();
      expect(failedRecord!.failureReason).toContain('declined');

      // Customer should have pending invoice (needs manual retry after fixing card)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.pendingInvoiceId).not.toBeNull();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Stripe customer ID persistence
  // =========================================================================
  describe('Stripe customer management', () => {
    it('should create Stripe customer on first addPaymentMethod and persist it', async () => {
      // addPaymentMethod creates the Stripe customer; complete-setup creates the DB row
      await addStripePaymentMethod(accessToken);

      // Verify stripeCustomerId was saved to customers table
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.stripeCustomerId).toBeDefined();
      expect(customer?.stripeCustomerId).toContain('cus_mock_');

      // Verify payment method was created by the webhook handler
      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methods).toHaveLength(1);
      expect(methods[0].providerRef).toContain('pm_mock_');
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Error code propagation
  // =========================================================================
  describe('Error code propagation', () => {
    it('should have card_declined errorCode when Stripe mock declines', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Add stripe as only payment method (setup + webhook)
      await addStripePaymentMethod(accessToken);

      // Subscribe — Stripe declines
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );

      expect(result.result?.data?.paymentPending).toBe(true);

      // Verify billing record has failed status with card_declined-related failure
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));

      const failedRecord = records.find(r => r.status === 'failed');
      expect(failedRecord).toBeDefined();
      expect(failedRecord!.failureReason).toContain('declined');
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // 3DS → Clear config → Retry succeeds (Bug fix validation)
  // =========================================================================
  describe('3DS recovery: clear 3DS config and retry', () => {
    it('should charge after 3DS by using fresh idempotency key when 3DS config cleared', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add Stripe (setup + webhook) + subscribe → 3DS pending
      await addStripePaymentMethod(accessToken);

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify billing record is pending with paymentActionUrl
      let records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const pendingRecord = records.find(r => r.status === 'pending' && r.paymentActionUrl);
      expect(pendingRecord).toBeDefined();

      // Simulate: customer adds a new non-3DS card — clear 3DS config
      await restCall('POST', '/test/stripe/config/clear');

      // Reconcile → retryPendingInvoice → processInvoicePayment with fresh
      // idempotency key (retryCount incremented in 3DS path) → succeeds
      await reconcilePendingPayments(customerId);

      // Poll for GM-async reconcile commit; once customer settles the
      // billing_records read below is stable (same GM transaction).
      const customer = await waitForState(
        () => db.query.customers.findFirst({
          where: eq(customers.customerId, customerId),
        }),
        (c) => c?.pendingInvoiceId === null,
        `customer.pendingInvoiceId cleared after reconcile`,
      );

      // Verify billing record is now paid
      records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      expect(customer?.pendingInvoiceId).toBeNull();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Card declined → Fix card → Retry succeeds
  // =========================================================================
  describe('Card declined recovery: fix card and retry', () => {
    it('should succeed after clearing declined config and retrying via reconcile', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to decline
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Add Stripe (setup + webhook) + subscribe → declined, billing record failed
      await addStripePaymentMethod(accessToken);

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify billing record is failed
      let records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      expect(records.find(r => r.status === 'failed')).toBeDefined();

      // Simulate: customer fixes their card — clear declined config
      await restCall('POST', '/test/stripe/config/clear');

      // Reconcile → retries the failed invoice → succeeds
      await reconcilePendingPayments(customerId);

      // Poll for GM-async reconcile commit.
      const customer = await waitForState(
        () => db.query.customers.findFirst({
          where: eq(customers.customerId, customerId),
        }),
        (c) => c?.pendingInvoiceId === null,
        `customer.pendingInvoiceId cleared after reconcile`,
      );

      // Verify billing record is now paid
      records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      expect(customer?.pendingInvoiceId).toBeNull();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Monthly billing clears pendingInvoiceId gate
  // =========================================================================
  describe('Monthly billing clears pending invoice gate', () => {
    it('should allow platform gate clear after monthly billing pays and reconcile retries initial invoice', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Subscribe WITHOUT a payment method → initial payment fails
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify pendingInvoiceId is set on customer
      let customerRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerRec?.pendingInvoiceId).not.toBeNull();
      const pendingInvoiceId = customerRec!.pendingInvoiceId;

      // Add a Stripe card (after the failed initial payment)
      await addStripePaymentMethod(accessToken);

      // Advance to 1st of Feb → monthly billing runs and pays the DRAFT
      await setClockTime('2025-02-01T00:05:00Z');
      await runPeriodicBillingJob(customerId);

      // Verify: monthly DRAFT was paid
      const paidRecords = await db.select()
        .from(billingRecords)
        .where(
          and(
            eq(billingRecords.customerId, customerId),
            eq(billingRecords.status, 'paid'),
          )
        );
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      // Monthly billing does NOT blanket-clear pendingInvoiceId — the initial
      // subscription invoice is a separate debt. The gate clears only when that
      // specific invoice is paid, preserving reconciliation credit correctness.
      customerRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      // pendingInvoiceId may or may not be cleared depending on whether the
      // periodic retry picked up the initial invoice already. Either way,
      // reconcilePendingPayments will retry it.

      // Reconcile → triggers retryPendingInvoice → pays initial invoice
      // via Stripe (API mock, forceMock=true) → clears gate
      await reconcilePendingPayments(customerId);

      // Verify: gate is now cleared
      customerRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerRec?.pendingInvoiceId).toBeNull();
      expect(customerRec?.paidOnce).toBe(true);

      // The initial invoice was paid via reconcile's retryPendingInvoice
      const [oldInvoice] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, pendingInvoiceId!));
      expect(oldInvoice.status).toBe('paid');

      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // reconcileStuckInvoices skips 3DS pending invoices
  // =========================================================================
  describe('Reconciliation skips 3DS pending', () => {
    it('should NOT void a pending invoice that has paymentActionUrl (3DS)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add Stripe (setup + webhook) + subscribe → 3DS pending with paymentActionUrl
      await addStripePaymentMethod(accessToken);

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify 3DS pending invoice exists with paymentActionUrl
      let records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const pendingRecord = records.find(r => r.status === 'pending' && r.paymentActionUrl);
      expect(pendingRecord).toBeDefined();
      const invoiceId = pendingRecord!.id;

      // Advance clock past stuck threshold (>10 minutes)
      await advanceClock({ minutes: 15 });

      // Run periodic billing job (includes reconcileStuckInvoices)
      await runPeriodicBillingJob(customerId);

      // Verify the 3DS invoice was NOT voided — still pending
      records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, invoiceId));

      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('pending');
      expect(records[0].paymentActionUrl).not.toBeNull();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // 3DS invoice timeout after 48h
  // =========================================================================
  describe('3DS invoice timeout', () => {
    it('should mark 3DS-pending invoice as failed after 48h and notify admin', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Configure mock to require 3DS
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add Stripe + subscribe → 3DS pending
      await addStripePaymentMethod(accessToken);

      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(true);

      // Verify billing record is pending with paymentActionUrl
      let records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const pendingRecord = records.find(r => r.status === 'pending' && r.paymentActionUrl);
      expect(pendingRecord).toBeDefined();
      const invoiceId = pendingRecord!.id;

      // Clear 3DS config before advancing clock
      await restCall('POST', '/test/stripe/config/clear');

      // Advance clock 49 hours (past 48h timeout)
      await advanceClock({ hours: 49 });

      // Run periodic billing job (includes reconcileStuckInvoices which handles 3DS timeout)
      await runPeriodicBillingJob(customerId);

      // Verify: billing record is now 'failed'
      const [record] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, invoiceId));
      expect(record.status).toBe('failed');

      // Verify: paymentActionUrl is cleared
      expect(record.paymentActionUrl).toBeNull();

      // Verify: THREEDS_TIMEOUT on this specific invoice
      await expectNotifications(customerId, ['warning:THREEDS_TIMEOUT'], { forInvoice: invoiceId, tolerateGM: true });
      // Verify: no unexpected notifications on other invoices (customer-wide check)
      await expectNotifications(customerId, ['warning:THREEDS_TIMEOUT'], { tolerateGM: true });
    });
  });

  // =========================================================================
  // Void-on-fallthrough: escrow pays after Stripe 3DS
  // =========================================================================
  describe('Escrow fallback after Stripe 3DS', () => {
    it('should pay via escrow when Stripe requires 3DS and clear paymentActionUrl', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Fund escrow with sufficient balance ($50 for $2 platform starter)
      await ensureTestBalance(50, { walletAddress: TEST_WALLET });

      // Configure mock to require 3DS on Stripe
      await restCall('POST', '/test/stripe/config', {
        forceChargeRequiresAction: true,
      });

      // Add escrow (priority 1) + Stripe (priority 2)
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await addStripePaymentMethod(accessToken);

      // Subscribe — escrow is tried first (priority 1) and succeeds
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'starter' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(false);

      // Verify: billing record is paid
      const records = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.customerId, customerId));
      const paidRecords = records.filter(r => r.status === 'paid');
      expect(paidRecords.length).toBeGreaterThanOrEqual(1);

      // Verify: paymentActionUrl is null (no stale 3DS URL)
      expect(paidRecords[0].paymentActionUrl).toBeNull();

      // Verify: invoice_payments has escrow source type
      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, paidRecords[0].id));
      const escrowPayment = payments.find(p => p.sourceType === 'escrow');
      expect(escrowPayment).toBeDefined();
      await expectNoNotifications(customerId, { tolerateGM: true });
    });
  });

  // =========================================================================
  // Grace period + suspension notifications
  // =========================================================================
  describe('Grace period and suspension notifications', () => {
    it('should notify on grace period start and customer suspension after expiry', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Add Stripe as payment method and subscribe to platform successfully (sets paidOnce=true)
      await addStripePaymentMethod(accessToken);
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(false);

      // Enable the auto-provisioned seal service (gives suspension something to disable)
      const toggleResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );
      expect(toggleResult.result?.data?.isUserEnabled).toBe(true);

      // Verify paidOnce is set at customer level
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.paidOnce).toBe(true);

      // Configure Stripe to decline all charges (simulates card expired/revoked)
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Wait for any in-flight GM async webhooks (triggered by addStripePaymentMethod)
      // to complete before advancing the clock. Without this, GM's sync-customer
      // could fire after the clock change and process billing with GM's own mock
      // Stripe (which doesn't have forceCardDeclined), paying the DRAFT before
      // our periodic job runs.
      await waitForGMSyncCustomer(customerId);

      // Advance to 1st of next month to trigger monthly billing → payment fails
      await setClockTime('2025-02-01T00:05:00Z');
      await runPeriodicBillingJob(customerId);

      // Verify: GRACE_PERIOD_STARTED notification exists (and nothing unexpected)
      await expectNotifications(customerId, ['warning:GRACE_PERIOD_STARTED'], { tolerateGM: true });

      // Advance 15 days past grace period (14-day grace)
      await advanceClock({ days: 15 });

      // Run periodic billing again — grace period has expired
      await runPeriodicBillingJob(customerId);

      // Verify: both grace period and suspension notifications
      await expectNotifications(customerId, [
        'warning:GRACE_PERIOD_STARTED',
        'error:CUSTOMER_SUSPENDED',
      ], { tolerateGM: true });
    });

    it('should resume suspended customer when payment retry succeeds after adding new card', async () => {
      // === PHASE 1: Set up a suspended customer ===
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe with Stripe and pay successfully (sets paidOnce=true)
      await addStripePaymentMethod(accessToken);
      await trpcMutation<any>('billing.acceptTos', {}, accessToken);
      const subscribeResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'platform', tier: 'pro' },
        accessToken
      );
      expect(subscribeResult.result?.data?.paymentPending).toBe(false);

      // Enable the auto-provisioned seal service
      await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      // Configure Stripe to decline all charges
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: true,
      });

      // Wait for any in-flight GM async webhooks to complete before advancing clock
      await waitForGMSyncCustomer(customerId);

      // Advance to 1st of Feb → monthly billing fails → grace period starts
      await setClockTime('2025-02-01T00:05:00Z');
      await runPeriodicBillingJob(customerId);

      // Advance 15 days → grace period expires → customer suspended
      await advanceClock({ days: 15 });
      await runPeriodicBillingJob(customerId);

      // Verify customer is suspended
      const suspendedCustomer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(suspendedCustomer?.status).toBe('suspended');

      // Verify seal service is disabled (suspended)
      const suspendedService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal'),
        ),
      });
      expect(suspendedService?.isUserEnabled).toBe(false);

      // === PHASE 2: Customer fixes their payment method ===

      // Clear the card decline config (simulates card issuer lifting a hold)
      await restCall('POST', '/test/stripe/config', {
        forceCardDeclined: false,
      });

      // Simulate what the setup_intent.succeeded webhook does when a new card is
      // added: clear failureReason on failed invoices so the periodic retry picks
      // them up. We do this directly in the DB rather than calling
      // addStripePaymentMethod, because the webhook fires a GM sync-customer call
      // and the GM process has its own mock Stripe service that can't charge.
      await db.update(billingRecords)
        .set({ failureReason: null, lastRetryAt: null })
        .where(
          and(
            eq(billingRecords.customerId, customerId),
            eq(billingRecords.status, 'failed'),
          )
        );

      // Run periodic billing — should retry the failed invoice and succeed
      await runPeriodicBillingJob(customerId);

      // === PHASE 3: Verify customer is resumed ===

      const resumedCustomer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      // Status should be back to 'active' (BUG FIX: clearGracePeriod now sets status='active')
      expect(resumedCustomer?.status).toBe('active');
      // Grace period should be cleared
      expect(resumedCustomer?.gracePeriodStart).toBeNull();

      // Services remain disabled — user must manually re-enable (per BILLING_DESIGN.md R6)
      const resumedService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal'),
        ),
      });
      expect(resumedService?.isUserEnabled).toBe(false);

      // Verify the failed invoice was paid
      const paidInvoices = await db.select()
        .from(billingRecords)
        .where(
          and(
            eq(billingRecords.customerId, customerId),
            eq(billingRecords.status, 'paid'),
          )
        );
      // Should have at least 2 paid invoices: original subscription + retried monthly billing
      expect(paidInvoices.length).toBeGreaterThanOrEqual(2);

      // Both grace period and suspension notifications remain from the suspend phase
      await expectNotifications(customerId, [
        'warning:GRACE_PERIOD_STARTED',
        'error:CUSTOMER_SUSPENDED',
      ], { tolerateGM: true });
    });
  });
});
