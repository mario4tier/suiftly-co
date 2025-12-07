/**
 * API Test: Subscription Without Funds
 *
 * Tests the flow where a user subscribes without sufficient funds,
 * then deposits money to complete the subscription.
 *
 * This test reproduces a bug where the billing record stays as 'failed'
 * instead of being updated to 'paid' after the deposit triggers reconciliation.
 *
 * BUG: In reconcilePayments(), the code looks for billing records with status='pending',
 * but when the initial payment fails, the status is 'failed'. So the billing record
 * is never updated to 'paid' even though the charge succeeds on retry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers, billingRecords, invoicePayments, invoiceLineItems } from '@suiftly/database/schema';
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

describe('API: Subscription Without Funds', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset clock to real time first
    await resetClock();

    // Reset test customer data
    await restCall('POST', '/test/data/reset', {
      walletAddress: TEST_WALLET,
    });

    // Login - this creates the customer
    accessToken = await login(TEST_WALLET);

    // Get customer ID for DB assertions
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;
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
    // Setup: Create escrow account with $1 (not enough for $9 subscription)
    // This ensures the payment will be ATTEMPTED but will FAIL (status = 'failed')
    // ============================================================================
    console.log('[TEST] Creating escrow account with $1 (insufficient for $9 subscription)...');
    await ensureTestBalance(1, { walletAddress: TEST_WALLET });

    console.log(`[TEST] Customer ${customerId} has $1 balance`);

    // ============================================================================
    // Step 1: Subscribe without funds (should create service with pending charge)
    // ============================================================================
    console.log('[TEST] Step 1: Subscribing without funds...');

    const subscribeResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'seal', tier: 'starter' },
      accessToken
    );

    // Subscription should succeed (creates service with subscriptionChargePending=true)
    expect(subscribeResult.result?.data).toBeDefined();
    expect(subscribeResult.result?.data.serviceType).toBe('seal');
    expect(subscribeResult.result?.data.tier).toBe('starter');

    // Verify service was created with pending charge
    const serviceBeforeDeposit = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(serviceBeforeDeposit).toBeDefined();
    expect(serviceBeforeDeposit?.subPendingInvoiceId).not.toBeNull(); // Should have pending invoice reference
    expect(serviceBeforeDeposit?.paidOnce).toBe(false);

    console.log('[TEST] Service created with subPendingInvoiceId set');

    // Check billing record was created (should be 'pending' or 'failed')
    const billingRecordsBefore = await db.query.billingRecords.findMany({
      where: and(
        eq(billingRecords.customerId, customerId),
        eq(billingRecords.billingType, 'immediate')
      ),
    });
    expect(billingRecordsBefore.length).toBeGreaterThanOrEqual(1);

    const firstMonthInvoice = billingRecordsBefore.find(br => br.amountUsdCents === 900);
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
    const serviceAfterDeposit = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(serviceAfterDeposit?.subPendingInvoiceId).toBeNull(); // Pending invoice cleared
    expect(serviceAfterDeposit?.paidOnce).toBe(true);

    console.log('[TEST] Service now has paidOnce=true and subPendingInvoiceId=null');

    // ============================================================================
    // Step 4: Verify billing record was updated to 'paid' (THIS IS THE BUG!)
    // ============================================================================
    const billingRecordsAfter = await db.query.billingRecords.findMany({
      where: and(
        eq(billingRecords.customerId, customerId),
        eq(billingRecords.billingType, 'immediate')
      ),
    });

    const firstMonthInvoiceAfter = billingRecordsAfter.find(br => br.amountUsdCents === 900);
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
      entry.amountUsd === 9 // $9 starter tier
    );

    // BUG: The billing history should show this entry
    expect(firstMonthEntry).toBeDefined();
    expect(firstMonthEntry?.status).toBe('paid');
  });

  it('should delete pending invoice when cancelling unpaid subscription (BUG: subscribe→cancel→subscribe leaves orphaned invoice)', async () => {
    await setClockTime('2025-01-15T00:00:00Z');

    // ============================================================================
    // Setup: No escrow account (payment will fail immediately)
    // ============================================================================
    console.log('[TEST] Step 1: Subscribe to Starter without funds...');

    const subscribeStarterResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'seal', tier: 'starter' },
      accessToken
    );

    // Subscription should succeed (creates service with pending payment)
    expect(subscribeStarterResult.result?.data).toBeDefined();
    expect(subscribeStarterResult.result?.data.serviceType).toBe('seal');
    expect(subscribeStarterResult.result?.data.tier).toBe('starter');
    expect(subscribeStarterResult.result?.data.paymentPending).toBe(true);

    // Verify service was created with pending invoice
    const serviceAfterStarter = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(serviceAfterStarter).toBeDefined();
    expect(serviceAfterStarter?.subPendingInvoiceId).not.toBeNull();
    const starterInvoiceId = serviceAfterStarter!.subPendingInvoiceId;
    console.log(`[TEST] Starter subscription created with pending invoice ID: ${starterInvoiceId}`);

    // Verify the Starter invoice exists (may be 'pending' or 'failed' depending on payment status)
    const starterInvoice = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, starterInvoiceId!),
    });
    expect(starterInvoice).toBeDefined();
    expect(['pending', 'failed']).toContain(starterInvoice?.status); // Either pending or failed
    expect(starterInvoice?.amountUsdCents).toBe(900); // $9 Starter
    console.log(`[TEST] Starter invoice exists with status: ${starterInvoice?.status}`);

    // ============================================================================
    // Step 2: Cancel the subscription (should delete invoice AND service)
    // ============================================================================
    console.log('[TEST] Step 2: Cancelling unpaid subscription...');

    const cancelResult = await trpcMutation<any>(
      'services.scheduleCancellation',
      { serviceType: 'seal' },
      accessToken
    );

    expect(cancelResult.result?.data).toBeDefined();
    expect(cancelResult.result?.data.success).toBe(true);
    console.log('[TEST] Cancel result:', cancelResult.result?.data);

    // Verify service was deleted
    const serviceAfterCancel = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(serviceAfterCancel).toBeUndefined(); // Service should be deleted
    console.log('[TEST] Service deleted: OK');

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
      { serviceType: 'seal', tier: 'pro' },
      accessToken
    );

    expect(subscribeProResult.result?.data).toBeDefined();
    expect(subscribeProResult.result?.data.serviceType).toBe('seal');
    expect(subscribeProResult.result?.data.tier).toBe('pro');
    expect(subscribeProResult.result?.data.paymentPending).toBe(true);

    // Verify new service was created with pending invoice
    const serviceAfterPro = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(serviceAfterPro).toBeDefined();
    expect(serviceAfterPro?.subPendingInvoiceId).not.toBeNull();
    const proInvoiceId = serviceAfterPro!.subPendingInvoiceId;
    console.log(`[TEST] Pro subscription created with pending invoice ID: ${proInvoiceId}`);

    // Verify the Pro invoice exists (may be 'pending' or 'failed' depending on payment status)
    const proInvoice = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, proInvoiceId!),
    });
    expect(proInvoice).toBeDefined();
    expect(['pending', 'failed']).toContain(proInvoice?.status); // Either pending or failed
    expect(proInvoice?.amountUsdCents).toBe(2900); // $29 Pro
    console.log(`[TEST] Pro invoice exists with status: ${proInvoice?.status}`);

    // ============================================================================
    // Step 4: Verify database state - Pro invoice exists, Starter was deleted
    // ============================================================================
    console.log('[TEST] Step 4: Verify final database state...');

    // Query ALL invoices for this customer directly from DB
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
    // The Starter invoice should have been deleted
    const unpaidInvoices = allInvoices.filter(inv =>
      inv.status === 'pending' || inv.status === 'failed'
    );
    console.log(`[TEST] Unpaid invoices in DB: ${unpaidInvoices.length}`);

    expect(unpaidInvoices.length).toBe(1);
    expect(unpaidInvoices[0].amountUsdCents).toBe(2900); // $29 Pro
    console.log('[TEST] Only Pro invoice exists: OK');

    // Verify NO $9 Starter invoice exists (it was deleted)
    const starterInvoiceInDb = allInvoices.find(inv => inv.amountUsdCents === 900);
    expect(starterInvoiceInDb).toBeUndefined();
    console.log('[TEST] Starter invoice properly deleted: OK');
  });

  it('should show correct tier in billing history after subscribe→upgrade→deposit (BUG: shows old tier)', async () => {
    /**
     * BUG REPRODUCTION: When user subscribes to Starter, upgrades to Enterprise (before paying),
     * then deposits, the billing history incorrectly shows "Seal Starter tier" for the -$185 charge.
     *
     * Root cause: handleTierUpgradeLocked in tier-changes.ts only updates:
     * - service.tier (to 'enterprise')
     * - billingRecords.amountUsdCents (to 18500)
     * But does NOT update invoice_line_items.itemType (still 'subscription_starter')
     *
     * The billing history reads itemType from invoice_line_items to generate description,
     * so it shows "Seal Starter tier" instead of "Seal Enterprise tier".
     */
    await setClockTime('2025-01-15T00:00:00Z');

    // ============================================================================
    // Step 1: Subscribe to Starter without funds
    // ============================================================================
    console.log('[TEST] Step 1: Subscribe to Starter without funds...');

    const subscribeResult = await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'seal', tier: 'starter' },
      accessToken
    );

    expect(subscribeResult.result?.data).toBeDefined();
    expect(subscribeResult.result?.data.tier).toBe('starter');
    expect(subscribeResult.result?.data.paymentPending).toBe(true);

    // Verify service was created with pending invoice
    let service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(service).toBeDefined();
    expect(service?.subPendingInvoiceId).not.toBeNull();
    expect(service?.paidOnce).toBe(false);
    const pendingInvoiceId = service!.subPendingInvoiceId!;
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
    expect(starterLineItems[0].amountUsdCents).toBe(900); // $9

    // ============================================================================
    // Step 2: Upgrade to Enterprise (while paidOnce=false)
    // ============================================================================
    console.log('[TEST] Step 2: Upgrade to Enterprise without funds...');

    const upgradeResult = await trpcMutation<any>(
      'services.upgradeTier',
      { serviceType: 'seal', newTier: 'enterprise' },
      accessToken
    );

    expect(upgradeResult.result?.data).toBeDefined();
    expect(upgradeResult.result?.data.success).toBe(true);
    expect(upgradeResult.result?.data.newTier).toBe('enterprise');
    // Should be no charge for upgrade when paidOnce=false
    expect(upgradeResult.result?.data.chargeAmountUsdCents).toBe(0);
    console.log('[TEST] Upgrade successful (no charge)');

    // Verify service tier is now Enterprise
    service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(service?.tier).toBe('enterprise');
    expect(service?.paidOnce).toBe(false);

    // Check that pending invoice amount was updated to Enterprise price
    const invoiceAfterUpgrade = await db.query.billingRecords.findFirst({
      where: eq(billingRecords.id, pendingInvoiceId),
    });
    expect(invoiceAfterUpgrade).toBeDefined();
    expect(invoiceAfterUpgrade?.amountUsdCents).toBe(18500); // $185 Enterprise
    console.log('[TEST] Invoice amount updated to Enterprise price: $185');

    // BUG CHECK: Line items should be updated to Enterprise
    const lineItemsAfterUpgrade = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, pendingInvoiceId),
    });
    console.log('[TEST] Line items after upgrade:', lineItemsAfterUpgrade.map(li => ({
      itemType: li.itemType,
      amountUsdCents: li.amountUsdCents,
    })));

    // BUG: This is where the bug manifests - line item still shows 'subscription_starter'
    // FIX: Line item should be 'subscription_enterprise' with $185
    expect(lineItemsAfterUpgrade.length).toBe(1);
    expect(lineItemsAfterUpgrade[0].itemType).toBe('subscription_enterprise'); // BUG: was 'subscription_starter'
    expect(lineItemsAfterUpgrade[0].amountUsdCents).toBe(18500); // BUG: was 900

    // ============================================================================
    // Step 3: Deposit funds (triggers reconciliation)
    // ============================================================================
    console.log('[TEST] Step 3: Deposit $200...');

    await ensureTestBalance(200, { walletAddress: TEST_WALLET });

    const depositResult = await trpcMutation<any>(
      'billing.deposit',
      { amountUsd: 200 },
      accessToken
    );

    expect(depositResult.result?.data).toBeDefined();
    expect(depositResult.result?.data.success).toBe(true);
    console.log('[TEST] Deposit successful');

    // Trigger reconciliation (in production, this is done asynchronously by GM)
    await reconcilePendingPayments(customerId);

    // Verify service is now paid
    service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, 'seal')
      ),
    });
    expect(service?.paidOnce).toBe(true);
    expect(service?.subPendingInvoiceId).toBeNull();

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

    // Find the $185 Enterprise charge
    const enterpriseCharge = transactions.find((tx: any) =>
      tx.source === 'invoice' &&
      tx.type === 'charge' &&
      tx.amountUsd === 185
    );

    expect(enterpriseCharge).toBeDefined();
    expect(enterpriseCharge?.status).toBe('paid');

    // Description should show "Seal Enterprise tier subscription" for the correct tier
    expect(enterpriseCharge?.description).toBe('Seal Enterprise tier subscription');
    console.log(`[TEST] Billing history description: ${enterpriseCharge?.description}`);
  });
});
