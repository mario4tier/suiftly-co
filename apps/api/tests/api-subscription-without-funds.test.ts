/**
 * API Test: Subscription Without Funds
 *
 * Tests the flow where a user subscribes without sufficient funds,
 * then deposits money to complete the subscription.
 *
 * Uses platform subscription as the billing trigger ($2 Starter / $39 Pro).
 * All tests use manual setup (no pre-subscribed platform) to test the
 * payment-pending billing path.
 *
 * This test reproduces bugs where the billing record stays as 'failed'
 * instead of being updated to 'paid' after the deposit triggers reconciliation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import {
  billingRecords,
  invoicePayments,
  invoiceLineItems,
  customers,
} from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  trpcQuery,
  restCall,
  ensureTestBalance,
  reconcilePendingPayments,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { clearNotifications, expectNoNotifications } from './helpers/notifications.js';
import { waitForState } from './helpers/wait-for-state.js';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

describe('API: Subscription Without Funds', () => {
  const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter;
  const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro;


  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Manual setup: no platform subscription — we test the billing-pending path
    await resetClock();
    await restCall('POST', '/test/data/reset', { walletAddress: TEST_WALLET });

    accessToken = await login(TEST_WALLET);

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found');
    customerId = customer.customerId;

    await clearNotifications(customerId);
  });

  afterEach(async () => {
    // Reset clock
    await resetClock();
    // Clean up via HTTP
    await restCall('POST', '/test/data/reset', { walletAddress: TEST_WALLET });
  });

  it('should update billing record from failed to paid after deposit (BUG REPRODUCTION)', async () => {
    await setClockTime('2025-01-15T00:00:00Z');

    // ============================================================================
    // Setup: Create escrow account with $0 (not enough for $2 platform subscription)
    // This ensures the payment will be ATTEMPTED but will FAIL (status = 'failed')
    // ============================================================================
    console.log('[TEST] Creating escrow account with $0 (insufficient for $2 subscription)...');
    await ensureTestBalance(0, { walletAddress: TEST_WALLET });
    await trpcMutation<any>('billing.addPaymentMethod', { providerType: 'escrow' }, accessToken);

    console.log(`[TEST] Customer ${customerId} has $0 balance`);

    // Accept TOS (required for platform subscribe)
    await trpcMutation<any>('billing.acceptTos', {}, accessToken);

    // ============================================================================
    // Step 1: Subscribe without funds (should create service with pending charge)
    // ============================================================================
    console.log('[TEST] Step 1: Subscribing without funds...');

    const subscribeResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'platform', tier: 'starter' },
      accessToken
    );

    // Subscription should succeed (creates service with subscriptionChargePending=true)
    expect(subscribeResult.result?.data).toBeDefined();
    expect(subscribeResult.result?.data.serviceType).toBe('platform');
    expect(subscribeResult.result?.data.tier).toBe('starter');

    // Verify customer has pending charge
    const customerBeforeDeposit = await db.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });
    expect(customerBeforeDeposit).toBeDefined();
    expect(customerBeforeDeposit?.pendingInvoiceId).not.toBeNull(); // Should have pending invoice reference
    expect(customerBeforeDeposit?.paidOnce).toBe(false);

    console.log('[TEST] Customer created with pendingInvoiceId set');

    // Check billing record was created (should be 'pending' or 'failed')
    const billingRecordsBefore = await db.query.billingRecords.findMany({
      where: and(
        eq(billingRecords.customerId, customerId),
        eq(billingRecords.billingType, 'immediate')
      ),
    });
    expect(billingRecordsBefore.length).toBeGreaterThanOrEqual(1);

    const firstMonthInvoice = billingRecordsBefore.find(br => br.amountUsdCents === STARTER_PRICE); // $2 starter
    expect(firstMonthInvoice).toBeDefined();
    console.log(`[TEST] Billing record status before deposit: ${firstMonthInvoice?.status}`);

    // ============================================================================
    // Step 2: Deposit funds (should trigger reconciliation)
    // ============================================================================
    console.log('[TEST] Step 2: Depositing $100...');

    const depositResult = await trpcMutation<any>(
      'billing.deposit',
      { amountUsd: 100 },
      accessToken
    );

    expect(depositResult.result?.data).toBeDefined();
    expect(depositResult.result?.data.success).toBe(true);

    console.log('[TEST] Deposit successful');

    // Trigger reconciliation (in production, this is done asynchronously by GM)
    await reconcilePendingPayments(customerId);

    // ============================================================================
    // Step 3: Verify service is now paid
    // ============================================================================
    // Poll — customer state commits on a GM tick after reconcile returns.
    // Once this converges, the downstream billing_records / invoice_payments
    // reads below are stable (written in the same GM transaction).
    const customerAfterDeposit = await waitForState(
      () => db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      }),
      (c) => c?.pendingInvoiceId === null && c?.paidOnce === true,
      `pendingInvoiceId cleared & paidOnce=true after reconcile`,
    );
    expect(customerAfterDeposit?.pendingInvoiceId).toBeNull(); // Pending invoice cleared
    expect(customerAfterDeposit?.paidOnce).toBe(true);

    console.log('[TEST] Customer now has paidOnce=true and pendingInvoiceId=null');

    // ============================================================================
    // Step 4: Verify billing record was updated to 'paid' (THIS IS THE BUG!)
    // ============================================================================
    const billingRecordsAfter = await db.query.billingRecords.findMany({
      where: and(
        eq(billingRecords.customerId, customerId),
        eq(billingRecords.billingType, 'immediate')
      ),
    });

    const firstMonthInvoiceAfter = billingRecordsAfter.find(br => br.amountUsdCents === STARTER_PRICE); // $2 starter
    expect(firstMonthInvoiceAfter).toBeDefined();

    console.log(`[TEST] Billing record status after deposit: ${firstMonthInvoiceAfter?.status}`);

    // BUG: The billing record should be 'paid', but it might still be 'failed'
    expect(firstMonthInvoiceAfter?.status).toBe('paid');

    // ============================================================================
    // Step 5: Verify invoice_payment was created
    // ============================================================================
    const payments = await db.query.invoicePayments.findMany({
      where: eq(invoicePayments.billingRecordId, firstMonthInvoiceAfter!.id),
    });

    console.log(`[TEST] Invoice payments for first month: ${payments.length}`);

    // BUG: There should be at least one invoice_payment record
    expect(payments.length).toBeGreaterThan(0);

    // ============================================================================
    // Step 6: Verify billing history shows the entry
    // ============================================================================
    const billingHistoryResult = await trpcQuery<any>(
      'billing.getTransactions',
      {},
      accessToken
    );

    expect(billingHistoryResult.result?.data).toBeDefined();
    const historyData = billingHistoryResult.result?.data;
    const transactions = historyData?.transactions;

    console.log(`[TEST] Billing history entries: ${transactions?.length}`);
    console.log('[TEST] Billing history:', JSON.stringify(historyData, null, 2));

    // Should have at least one entry for the first month subscription
    const firstMonthEntry = transactions?.find((entry: any) =>
      entry.type === 'charge' &&
      entry.status === 'paid' &&
      entry.amountUsd === STARTER_PRICE / 100 // $2 platform starter tier
    );

    // BUG: The billing history should show this entry
    expect(firstMonthEntry).toBeDefined();
    expect(firstMonthEntry?.status).toBe('paid');

    await expectNoNotifications(customerId);
  });

  it('should delete pending invoice when cancelling unpaid subscription (BUG: subscribe→cancel→subscribe leaves orphaned invoice)', async () => {
    await setClockTime('2025-01-15T00:00:00Z');

    // ============================================================================
    // Setup: No escrow account (payment will fail immediately)
    // ============================================================================
    console.log('[TEST] Step 1: Subscribe to Starter without funds...');

    // Accept TOS (required for platform subscribe)
    await trpcMutation<any>('billing.acceptTos', {}, accessToken);

    const subscribeStarterResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'platform', tier: 'starter' },
      accessToken
    );

    // Subscription should succeed (creates service with pending payment)
    expect(subscribeStarterResult.result?.data).toBeDefined();
    expect(subscribeStarterResult.result?.data.serviceType).toBe('platform');
    expect(subscribeStarterResult.result?.data.tier).toBe('starter');
    expect(subscribeStarterResult.result?.data.paymentPending).toBe(true);

    // Verify customer has pending invoice
    const customerAfterStarter = await db.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });
    expect(customerAfterStarter).toBeDefined();
    expect(customerAfterStarter?.pendingInvoiceId).not.toBeNull();
    const starterInvoiceId = customerAfterStarter!.pendingInvoiceId;
    console.log(`[TEST] Starter subscription created with pending invoice ID: ${starterInvoiceId}`);

    // Verify the Starter invoice exists
    const starterInvoice = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, starterInvoiceId!),
    });
    expect(starterInvoice).toBeDefined();
    expect(['pending', 'failed']).toContain(starterInvoice?.status);
    expect(starterInvoice?.amountUsdCents).toBe(STARTER_PRICE); // $2 Starter
    console.log(`[TEST] Starter invoice exists with status: ${starterInvoice?.status}`);

    // ============================================================================
    // Step 2: Cancel the subscription (should delete invoice AND service)
    // ============================================================================
    console.log('[TEST] Step 2: Cancelling unpaid subscription...');

    const cancelResult = await trpcMutation<any>(
      'services.scheduleCancellation',
      { serviceType: 'platform' },
      accessToken
    );

    expect(cancelResult.result?.data).toBeDefined();
    expect(cancelResult.result?.data.success).toBe(true);
    console.log('[TEST] Cancel result:', cancelResult.result?.data);

    // Verify platform subscription was cleared
    const customerAfterCancel = await db.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });
    expect(customerAfterCancel?.platformTier).toBeNull(); // Platform sub should be cleared
    console.log('[TEST] Platform subscription cleared: OK');

    // Verify the Starter invoice was DELETED (not just voided)
    const starterInvoiceAfterCancel = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, starterInvoiceId!),
    });
    console.log('[TEST] Starter invoice after cancel:', starterInvoiceAfterCancel);
    expect(starterInvoiceAfterCancel).toBeUndefined(); // Invoice should be deleted
    console.log('[TEST] Starter invoice deleted: OK');

    // ============================================================================
    // Step 3: Subscribe to Pro (should create NEW pending invoice)
    // ============================================================================
    console.log('[TEST] Step 3: Subscribe to Pro without funds...');

    const subscribeProResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'platform', tier: 'pro' },
      accessToken
    );

    expect(subscribeProResult.result?.data).toBeDefined();
    expect(subscribeProResult.result?.data.serviceType).toBe('platform');
    expect(subscribeProResult.result?.data.tier).toBe('pro');
    expect(subscribeProResult.result?.data.paymentPending).toBe(true);

    // Verify customer has new pending invoice for Pro
    const customerAfterPro = await db.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });
    expect(customerAfterPro).toBeDefined();
    expect(customerAfterPro?.pendingInvoiceId).not.toBeNull();
    const proInvoiceId = customerAfterPro!.pendingInvoiceId;
    console.log(`[TEST] Pro subscription created with pending invoice ID: ${proInvoiceId}`);

    // Verify the Pro invoice exists
    const proInvoice = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, proInvoiceId!),
    });
    expect(proInvoice).toBeDefined();
    expect(['pending', 'failed']).toContain(proInvoice?.status);
    expect(proInvoice?.amountUsdCents).toBe(PRO_PRICE); // $39 Pro
    console.log(`[TEST] Pro invoice exists with status: ${proInvoice?.status}`);

    // ============================================================================
    // Step 4: Verify database state - Pro invoice exists, Starter was deleted
    // ============================================================================
    console.log('[TEST] Step 4: Verify final database state...');

    const allInvoices = await db.query.billingRecords.findMany({
      where: eq(billingRecords.customerId, customerId),
    });

    console.log('[TEST] All invoices in DB:', allInvoices.map(inv => ({
      id: inv.id,
      amount: inv.amountUsdCents,
      status: inv.status,
      type: inv.billingType,
    })));

    // Should have exactly ONE invoice (the Pro one)
    const unpaidInvoices = allInvoices.filter(inv =>
      inv.status === 'pending' || inv.status === 'failed'
    );
    console.log(`[TEST] Unpaid invoices in DB: ${unpaidInvoices.length}`);

    expect(unpaidInvoices.length).toBe(1);
    expect(unpaidInvoices[0].amountUsdCents).toBe(PRO_PRICE); // $39 Pro
    console.log('[TEST] Only Pro invoice exists: OK');

    // Verify NO $2 Starter invoice exists (it was deleted)
    const starterInvoiceInDb = allInvoices.find(inv => inv.amountUsdCents === STARTER_PRICE);
    expect(starterInvoiceInDb).toBeUndefined();
    console.log('[TEST] Starter invoice properly deleted: OK');

    await expectNoNotifications(customerId);
  });

  it('should show correct tier in billing history after subscribe→upgrade→deposit (BUG: shows old tier)', async () => {
    /**
     * BUG REPRODUCTION: When user subscribes to Starter, upgrades to Pro (before paying),
     * then deposits, the billing history incorrectly shows "Platform Starter tier" for the -$39 charge.
     *
     * Root cause: handleTierUpgradeLocked in tier-changes.ts only updates:
     * - service.tier (to 'pro')
     * - billingRecords.amountUsdCents (to 3900)
     * But does NOT update invoice_line_items.itemType (still 'subscription_starter')
     *
     * The billing history reads itemType from invoice_line_items to generate description,
     * so it shows "Platform Starter tier" instead of "Platform Pro tier".
     */
    await setClockTime('2025-01-15T00:00:00Z');

    // Accept TOS (required for platform subscribe)
    await trpcMutation<any>('billing.acceptTos', {}, accessToken);

    // ============================================================================
    // Step 1: Subscribe to Starter without funds
    // ============================================================================
    console.log('[TEST] Step 1: Subscribe to Starter without funds...');

    const subscribeResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'platform', tier: 'starter' },
      accessToken
    );

    expect(subscribeResult.result?.data).toBeDefined();
    expect(subscribeResult.result?.data.tier).toBe('starter');
    expect(subscribeResult.result?.data.paymentPending).toBe(true);

    // Verify customer has pending invoice
    let customerRec = await db.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });
    expect(customerRec).toBeDefined();
    expect(customerRec?.pendingInvoiceId).not.toBeNull();
    expect(customerRec?.paidOnce).toBe(false);
    const pendingInvoiceId = customerRec!.pendingInvoiceId!;
    console.log(`[TEST] Starter subscription created with pending invoice ID: ${pendingInvoiceId}`);

    // Check invoice line item shows Starter
    const starterLineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, pendingInvoiceId),
    });
    console.log('[TEST] Line items after Starter subscribe:', starterLineItems.map(li => ({
      itemType: li.itemType,
      amountUsdCents: li.amountUsdCents,
    })));
    expect(starterLineItems.length).toBe(1);
    expect(starterLineItems[0].itemType).toBe('subscription_starter');
    expect(starterLineItems[0].amountUsdCents).toBe(STARTER_PRICE); // $2

    // ============================================================================
    // Step 2: Upgrade to Pro (while paidOnce=false)
    // ============================================================================
    console.log('[TEST] Step 2: Upgrade to Pro without funds...');

    const upgradeResult = await trpcMutation<any>(
      'services.upgradeTier',
      { serviceType: 'platform', newTier: 'pro' },
      accessToken
    );

    expect(upgradeResult.result?.data).toBeDefined();
    expect(upgradeResult.result?.data.success).toBe(true);
    expect(upgradeResult.result?.data.newTier).toBe('pro');
    // Should be no charge for upgrade when paidOnce=false
    expect(upgradeResult.result?.data.chargeAmountUsdCents).toBe(0);
    console.log('[TEST] Upgrade successful (no charge)');

    // Verify customer tier is now Pro
    customerRec = await db.query.customers.findFirst({
      where: eq(customers.customerId, customerId),
    });
    expect(customerRec?.platformTier).toBe('pro');
    expect(customerRec?.paidOnce).toBe(false);

    // Check that pending invoice amount was updated to Pro price
    const invoiceAfterUpgrade = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, pendingInvoiceId),
    });
    expect(invoiceAfterUpgrade).toBeDefined();
    expect(invoiceAfterUpgrade?.amountUsdCents).toBe(PRO_PRICE); // $39 Pro
    console.log('[TEST] Invoice amount updated to Pro price: $39');

    // BUG CHECK: Line items should be updated to Pro
    const lineItemsAfterUpgrade = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, pendingInvoiceId),
    });
    console.log('[TEST] Line items after upgrade:', lineItemsAfterUpgrade.map(li => ({
      itemType: li.itemType,
      amountUsdCents: li.amountUsdCents,
    })));

    // BUG: This is where the bug manifests - line item still shows 'subscription_starter'
    // FIX: Line item should be 'subscription_pro' with $39
    expect(lineItemsAfterUpgrade.length).toBe(1);
    expect(lineItemsAfterUpgrade[0].itemType).toBe('subscription_pro'); // BUG: was 'subscription_starter'
    expect(lineItemsAfterUpgrade[0].amountUsdCents).toBe(PRO_PRICE); // BUG: was STARTER_PRICE

    // ============================================================================
    // Step 3: Deposit funds (triggers reconciliation)
    // ============================================================================
    console.log('[TEST] Step 3: Deposit $50...');

    await ensureTestBalance(50, { walletAddress: TEST_WALLET });
    await trpcMutation<any>('billing.addPaymentMethod', { providerType: 'escrow' }, accessToken);

    const depositResult = await trpcMutation<any>(
      'billing.deposit',
      { amountUsd: 50 },
      accessToken
    );

    expect(depositResult.result?.data).toBeDefined();
    expect(depositResult.result?.data.success).toBe(true);
    console.log('[TEST] Deposit successful');

    // Trigger reconciliation (in production, this is done asynchronously by GM)
    await reconcilePendingPayments(customerId);

    // Verify customer is now paid. Poll for GM-async commit.
    customerRec = await waitForState(
      () => db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      }),
      (c) => c?.paidOnce === true && c?.pendingInvoiceId === null,
      `paidOnce=true & pendingInvoiceId=null after reconcile`,
    );
    expect(customerRec?.paidOnce).toBe(true);
    expect(customerRec?.pendingInvoiceId).toBeNull();

    // ============================================================================
    // Step 4: Verify billing history shows correct tier name
    // ============================================================================
    console.log('[TEST] Step 4: Check billing history...');

    const billingHistoryResult = await trpcQuery<any>(
      'billing.getTransactions',
      {},
      accessToken
    );

    expect(billingHistoryResult.result?.data).toBeDefined();
    const transactions = billingHistoryResult.result?.data?.transactions || [];
    console.log('[TEST] Billing history:', JSON.stringify(transactions, null, 2));

    // Find the $39 Pro charge
    const proCharge = transactions.find((tx: any) =>
      tx.source === 'invoice' &&
      tx.type === 'charge' &&
      tx.amountUsd === PRO_PRICE / 100
    );

    expect(proCharge).toBeDefined();
    expect(proCharge?.status).toBe('paid');

    // Description should show the Pro plan label
    expect(proCharge?.description).toBe('Platform Pro plan');
    console.log(`[TEST] Billing history description: ${proCharge?.description}`);

    await expectNoNotifications(customerId);
  });
});
