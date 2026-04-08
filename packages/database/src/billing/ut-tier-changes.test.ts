/**
 * Tier Change and Cancellation Tests (Phase 1C)
 *
 * Comprehensive tests for tier upgrades, downgrades, and subscription cancellation.
 * Uses MockDBClock for deterministic time-based testing.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingRecords,
  customerCredits,
  invoicePayments,
  invoiceLineItems,
  escrowTransactions,
  billingIdempotency,
  serviceCancellationHistory,
  serviceInstances,
  apiKeys,
  sealKeys,
  sealPackages,
  userActivityLogs,
  mockSuiTransactions,
  customerPaymentMethods,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, TransactionResult, ChargeParams } from '@suiftly/shared/sui-service';
import {
  handleTierUpgrade,
  scheduleTierDowngrade,
  cancelScheduledTierChange,
  scheduleCancellation,
  undoCancellation,
  canProvisionService,
  canPerformKeyOperation,
  getTierChangeOptions,
  applyScheduledTierChanges,
  processScheduledCancellations,
} from './tier-changes';
import { unsafeAsLockedTransaction, toPaymentServices, ensureEscrowPaymentMethod, cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';
import { processCancellationCleanup } from './cancellation-cleanup';
import { processCustomerBilling } from './processor';
import { processInvoicePayment } from './payments';
import { issueCredit } from './credits';
import { getCustomerProviders } from './providers';
import type { BillingProcessorConfig } from './types';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';
import { eq, and, sql } from 'drizzle-orm';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Mock Sui service for testing escrow charges
 */
class TestMockSuiService implements ISuiService {
  private shouldFail: boolean = false;
  private failureMessage: string = 'Payment failed';

  setFailure(fail: boolean, message: string = 'Payment failed') {
    this.shouldFail = fail;
    this.failureMessage = message;
  }

  private generateMockDigest(): string {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return '0x' + bytes.toString('hex');
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
    if (this.shouldFail) {
      return { digest: this.generateMockDigest(), success: false, error: this.failureMessage };
    }

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, params.userAddress),
    });

    if (!customer) {
      return { digest: this.generateMockDigest(), success: false, error: 'Customer not found' };
    }

    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (currentBalance < params.amountUsdCents) {
      return { digest: this.generateMockDigest(), success: false, error: 'Insufficient balance' };
    }

    await db.update(customers)
      .set({ currentBalanceUsdCents: currentBalance - params.amountUsdCents })
      .where(eq(customers.customerId, customer.customerId));

    return { digest: this.generateMockDigest(), success: true, checkpoint: Date.now() };
  }

  async getAccount() { return null; }
  async syncAccount() { return null; }
  async deposit() { return { digest: '0x', success: true }; }
  async withdraw() { return { digest: '0x', success: true }; }
  async credit() { return { digest: '0x', success: true }; }
  async updateSpendingLimit() { return { digest: '0x', success: true }; }
  async buildTransaction() { return null; }
  isMock() { return true; }
  async getTransactionHistory() { return []; }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Tier Change and Cancellation (Phase 1C)', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const paymentServices = toPaymentServices(suiService);

  const testWalletAddress = '0xTIER3000567890abcdefABCDEF1234567890abcdefABCDEF1234567890abc';
  let testCustomerId: number;

  beforeAll(async () => {
    await resetTestState(db);
  });

  beforeEach(async () => {
    await suspendGMProcessing();

    // Reset mock service
    suiService.setFailure(false);

    // Set time to Jan 15, 2025 (mid-month)
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

    // Defensive cleanup: remove stale data from previous crashed runs.
    // Without this, a plain INSERT fails on duplicate key if a previous
    // test run left orphaned customer 3000 in the database.
    await cleanupCustomerData(db, 3000);

    // Create test customer with balance
    const [customer] = await db.insert(customers).values({
      customerId: 3000,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW3000',
      status: 'active',
      currentBalanceUsdCents: 50000, // $500.00 - plenty for upgrades
      spendingLimitUsdCents: 100000, // $1000.00
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-01-01',
      paidOnce: true,
      platformTier: 'starter',
      pendingInvoiceId: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;

    // Ensure escrow payment method exists for provider chain
    await ensureEscrowPaymentMethod(db, testCustomerId);
  });

  afterEach(async () => {
    await cleanupCustomerData(db, testCustomerId);
  });

  // ==========================================================================
  // Tier Upgrade Tests
  // ==========================================================================

  describe('Tier Upgrade (Immediate Effect)', () => {
    it('should upgrade tier with pro-rated charge', async () => {
      // Upgrade from Starter ($1) to Pro ($29) on Jan 15
      // 17 days remaining in 31-day month
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(true);
      expect(result.newTier).toBe('pro');

      // Expected charge: ($29 - $1) × (17/31) = $28 × 0.548 = $15.35
      const expectedCharge = Math.floor((2800 * 17) / 31);
      expect(result.chargeAmountUsdCents).toBe(expectedCharge);

      // Verify tier was updated immediately
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('pro');
    });

    it('should charge $0 and upgrade immediately when ≤2 days remaining (grace period)', async () => {
      // Upgrade on Jan 30 (2 days remaining)
      clock.setTime(new Date('2025-01-30T00:00:00Z'));

      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(true);
      expect(result.chargeAmountUsdCents).toBe(0);
      expect(result.newTier).toBe('pro');

      // Verify tier was updated
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('pro');
    });

    it('should fail upgrade if payment fails', async () => {
      suiService.setFailure(true, 'Insufficient balance');

      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');

      // Verify tier was NOT updated
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('starter'); // Still Starter
    });

    it('should void upgrade invoice on payment failure to prevent orphan retry', async () => {
      // BUG: When upgrade payment fails, the FAILED invoice was left in the DB.
      // The periodic retry job would later charge the customer for the pro-rated
      // upgrade WITHOUT actually applying the tier change — customer pays for
      // an upgrade they never receive.
      // FIX: Void the invoice on failure so it's never retried.

      suiService.setFailure(true, 'Insufficient balance');

      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.invoiceId).toBeDefined();

      // The upgrade invoice should be VOIDED, not left as FAILED
      const invoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, result.invoiceId!),
      });
      expect(invoice?.status).toBe('voided');

      // Tier should still be Starter (not upgraded)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('starter');

      // Verify: no FAILED invoices remain that could be retried
      const failedInvoices = await db
        .select()
        .from(billingRecords)
        .where(and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'failed'),
        ));
      expect(failedInvoices).toHaveLength(0);
    });

    it('should restore credits when voiding upgrade invoice after payment failure (single-phase)', async () => {
      // BUG: When upgrade payment fails, the invoice is voided (correct) but
      // any credits that processInvoicePayment applied are NOT restored.
      // The customer loses credit value attached to a voided invoice.
      // FIX: Issue a reconciliation credit for consumed credits before voiding.

      const CREDIT_AMOUNT_CENTS = 500; // $5 credit — less than the 1535¢ upgrade charge, so escrow is still needed

      // 1. Issue a credit
      const creditId = await issueCredit(
        db,
        testCustomerId,
        CREDIT_AMOUNT_CENTS,
        'promo',
        'Test credit for upgrade failure'
      );
      expect(creditId).toBeGreaterThan(0);

      // 2. Ensure escrow payment method exists (so provider chain has escrow)
      await ensureEscrowPaymentMethod(db, testCustomerId);

      // 3. Force escrow to fail — credits will be applied but payment won't complete
      suiService.setFailure(true, 'Insufficient balance');

      // 4. Attempt upgrade Starter → Pro (will partially pay with credits, then fail)
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.invoiceId).toBeDefined();

      // 5. Invoice should be voided
      const invoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, result.invoiceId!),
      });
      expect(invoice?.status).toBe('voided');

      // 6. Verify: original credit was consumed (remainingAmountUsdCents = 0)
      const originalCredit = await db.query.customerCredits.findFirst({
        where: eq(customerCredits.creditId, creditId),
      });
      expect(Number(originalCredit?.remainingAmountUsdCents)).toBe(0);

      // 7. Verify: reconciliation credit was issued to restore the consumed amount
      const reconciliationCredits = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });

      const restoredCredit = reconciliationCredits.find(c =>
        Number(c.originalAmountUsdCents) === CREDIT_AMOUNT_CENTS
      );
      expect(restoredCredit).toBeDefined();
      expect(Number(restoredCredit!.remainingAmountUsdCents)).toBe(CREDIT_AMOUNT_CENTS);
    });

    it('should restore credits when voiding upgrade invoice after payment failure (two-phase)', async () => {
      // BUG: Two-phase upgrade path uses deleteUnpaidInvoice after payment failure,
      // which hits FK violation from invoicePayments (credits applied) or silently
      // burns credits. Should void + restore credits instead.

      const CREDIT_AMOUNT_CENTS = 500; // $5 credit — less than the 1535¢ upgrade charge, so escrow is still needed

      // Need to import the two-phase functions
      const { prepareTierUpgradePhase1Locked, createUpgradeInvoiceCommitted, executeTierUpgradePhase2Locked } = await import('./tier-changes');

      // 1. Issue a credit
      const creditId = await issueCredit(
        db,
        testCustomerId,
        CREDIT_AMOUNT_CENTS,
        'promo',
        'Test credit for two-phase upgrade failure'
      );

      // 2. Ensure escrow payment method
      await ensureEscrowPaymentMethod(db, testCustomerId);

      // 3. Phase 1: Prepare (with lock)
      const tx = unsafeAsLockedTransaction(db);
      const phase1 = await prepareTierUpgradePhase1Locked(
        tx,
        testCustomerId,
        'platform',
        'pro',
        clock
      );
      expect(phase1.canProceed).toBe(true);

      // Phase 1.5: Create invoice (outside lock, commits immediately)
      const invoiceId = await createUpgradeInvoiceCommitted(
        testCustomerId,
        phase1,
        clock
      );

      // 4. Force escrow to fail
      suiService.setFailure(true, 'Insufficient balance');

      // 5. Phase 2: Execute (with lock) — payment will fail
      const result = await executeTierUpgradePhase2Locked(
        tx,
        testCustomerId,
        'platform',
        'pro',
        'starter',
        invoiceId,
        paymentServices,
        clock
      );

      expect(result.success).toBe(false);

      // 6. Invoice should be voided (not deleted, not left as failed)
      const invoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoiceId),
      });
      expect(invoice?.status).toBe('voided');

      // 7. Original credit was consumed
      const originalCredit = await db.query.customerCredits.findFirst({
        where: eq(customerCredits.creditId, creditId),
      });
      expect(Number(originalCredit?.remainingAmountUsdCents)).toBe(0);

      // 8. Reconciliation credit restores the consumed amount
      const reconciliationCredits = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });

      const restoredCredit = reconciliationCredits.find(c =>
        Number(c.originalAmountUsdCents) === CREDIT_AMOUNT_CENTS
      );
      expect(restoredCredit).toBeDefined();
      expect(Number(restoredCredit!.remainingAmountUsdCents)).toBe(CREDIT_AMOUNT_CENTS);
    });

    it('should reject downgrade attempt as upgrade', async () => {
      // First upgrade to pro so we can attempt to downgrade via upgrade path
      await db.update(customers)
        .set({ platformTier: 'pro' })
        .where(eq(customers.customerId, testCustomerId));

      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'starter', // Lower tier
        paymentServices,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Use downgrade for lower tiers');
    });

    it('should clear scheduled downgrade when upgrading', async () => {
      // First schedule a downgrade (service is at starter, schedule starter — just set fields)
      await db.update(customers)
        .set({
          scheduledPlatformTier: 'starter',
          scheduledPlatformTierEffectiveDate: '2025-02-01',
        })
        .where(eq(customers.customerId, testCustomerId));

      // Now upgrade (should clear the scheduled downgrade)
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(true);

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('pro');
      expect(customer?.scheduledPlatformTier).toBeNull();
      expect(customer?.scheduledPlatformTierEffectiveDate).toBeNull();
    });

    it('should reject upgrade when cancellation is scheduled', async () => {
      // First schedule cancellation
      await db.update(customers)
        .set({
          platformCancellationScheduledFor: '2025-01-31',
        })
        .where(eq(customers.customerId, testCustomerId));

      // Attempt upgrade (should be blocked - user must undo cancellation first)
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'platform',
        'pro',
        paymentServices,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot change tier while cancellation is scheduled');

      // Cancellation should still be scheduled
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBe('2025-01-31');
      expect(customer?.platformTier).toBe('starter'); // Tier unchanged
    });
  });

  // ==========================================================================
  // Tier Downgrade Tests
  // ==========================================================================

  describe('Tier Downgrade (Scheduled Effect)', () => {
    beforeEach(async () => {
      // Start downgrade tests from pro tier (so there's somewhere to downgrade to)
      await db.update(customers)
        .set({ platformTier: 'pro' })
        .where(eq(customers.customerId, testCustomerId));
    });

    it('should schedule downgrade for end of billing period', async () => {
      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'platform',
        'starter',
        clock
      );

      expect(result.success).toBe(true);
      expect(result.scheduledTier).toBe('starter');

      // Effective date should be Feb 1, 2025
      expect(result.effectiveDate).toBeDefined();
      expect(result.effectiveDate!.getUTCFullYear()).toBe(2025);
      expect(result.effectiveDate!.getUTCMonth()).toBe(1); // February
      expect(result.effectiveDate!.getUTCDate()).toBe(1);

      // Verify scheduled in database
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('pro'); // Still Pro until effective date
      expect(customer?.scheduledPlatformTier).toBe('starter');
    });

    it('should reject upgrade attempt as downgrade', async () => {
      // pro is the highest tier, so any upgrade via downgrade path is invalid
      // (there is no higher tier to reject; this tests the guard for going "up" via downgrade)
      // Since 'pro' is already the top tier, we test with a fabricated higher name to trigger the guard.
      // Actually, the guard checks if the requested tier price > current tier price.
      // With platform, 'pro' > 'starter', so calling scheduleTierDowngrade to 'pro' from 'pro' is same-tier.
      // The test intent: calling scheduleTierDowngrade with a HIGHER tier is rejected.
      // Since service is at 'pro' (highest), we downgrade to 'starter' first, then test going back up via downgrade.
      await db.update(customers)
        .set({ platformTier: 'starter' })
        .where(eq(customers.customerId, testCustomerId));

      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'platform',
        'pro', // Higher tier — rejected as downgrade
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Use upgrade for higher tiers');
    });

    it('should reject downgrade when cancellation is scheduled', async () => {
      // First schedule cancellation
      await db.update(customers)
        .set({
          platformCancellationScheduledFor: '2025-01-31',
        })
        .where(eq(customers.customerId, testCustomerId));

      // Attempt downgrade (should be blocked - user must undo cancellation first)
      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'platform',
        'starter',
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot change tier while cancellation is scheduled');

      // Cancellation should still be scheduled
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBe('2025-01-31');
      expect(customer?.platformTier).toBe('pro'); // Tier unchanged
      expect(customer?.scheduledPlatformTier).toBeNull(); // No tier change scheduled
    });

    it('should allow canceling scheduled tier change', async () => {
      // Schedule downgrade
      await scheduleTierDowngrade(
        db,
        testCustomerId,
        'platform',
        'starter',
        clock
      );

      // Cancel it
      const result = await cancelScheduledTierChange(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.success).toBe(true);

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.scheduledPlatformTier).toBeNull();
    });

    it('should apply scheduled tier change on 1st of month', async () => {
      // Schedule downgrade to starter
      await db.update(customers)
        .set({
          scheduledPlatformTier: 'starter',
          scheduledPlatformTierEffectiveDate: '2025-02-01',
        })
        .where(eq(customers.customerId, testCustomerId));

      // Advance to Feb 1
      clock.setTime(new Date('2025-02-01T00:00:00Z'));

      // Apply tier changes
      await db.transaction(async (tx) => {
        const count = await applyScheduledTierChanges(unsafeAsLockedTransaction(tx), testCustomerId, clock);
        expect(count).toBe(1);
      });

      // Verify tier was changed
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBe('starter');
      expect(customer?.scheduledPlatformTier).toBeNull();
      expect(customer?.scheduledPlatformTierEffectiveDate).toBeNull();
    });
  });

  // ==========================================================================
  // Cancellation Tests
  // ==========================================================================

  describe('Cancellation (Scheduled Effect)', () => {
    it('should schedule cancellation for end of billing period', async () => {
      const result = await scheduleCancellation(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.success).toBe(true);

      // Effective date should be Jan 31, 2025 (end of month)
      expect(result.effectiveDate).toBeDefined();
      expect(result.effectiveDate!.getUTCDate()).toBe(31);

      // Verify scheduled in database (customer still active)
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.status).toBe('active'); // Still active
      expect(customer?.platformCancellationScheduledFor).toBeTruthy();
    });

    it('should allow undoing scheduled cancellation', async () => {
      // Schedule cancellation
      await scheduleCancellation(
        db,
        testCustomerId,
        'platform',
        clock
      );

      // Undo it
      const result = await undoCancellation(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.success).toBe(true);

      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBeNull();
    });

    it('should transition to cancellation_pending on 1st of month', async () => {
      // Schedule cancellation for end of January
      await db.update(customers)
        .set({
          platformCancellationScheduledFor: '2025-01-31',
        })
        .where(eq(customers.customerId, testCustomerId));

      // Advance to Feb 1
      clock.setTime(new Date('2025-02-01T00:00:00Z'));

      // Process cancellations
      await db.transaction(async (tx) => {
        const count = await processScheduledCancellations(unsafeAsLockedTransaction(tx), testCustomerId, clock);
        expect(count).toBe(1);
      });

      // Verify state changed to cancellation_pending
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformCancellationScheduledFor).toBeNull();
      expect(customer?.platformCancellationEffectiveAt).toBeTruthy();

      // Cancellation effective should be 7 days from now
      const effectiveAt = new Date(customer!.platformCancellationEffectiveAt!);
      const expectedEffective = clock.addDays(7);
      expect(effectiveAt.getTime()).toBe(expectedEffective.getTime());
    });

    it('should not allow undo after billing period ends', async () => {
      // Set customer to cancellation_pending state
      await db.update(customers)
        .set({
          platformCancellationEffectiveAt: clock.addDays(7),
        })
        .where(eq(customers.customerId, testCustomerId));

      const result = await undoCancellation(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot undo cancellation after billing period');
    });
  });

  // ==========================================================================
  // Cancellation Cleanup Tests
  // ==========================================================================

  describe('Cancellation Cleanup Job', () => {
    beforeEach(async () => {
      // Start cleanup tests from pro tier (more realistic — cancelling a paid pro sub)
      await db.update(customers)
        .set({ platformTier: 'pro' })
        .where(eq(customers.customerId, testCustomerId));
    });

    it('should delete service after 7-day grace period', async () => {
      // Create a service instance (cleanup iterates over service_instances)
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        isUserEnabled: true,
        config: {},
      });

      // Set customer to cancellation_pending with past effective date
      const effectiveAt = new Date('2025-01-15T00:00:00Z');
      await db.update(customers)
        .set({
          platformCancellationEffectiveAt: effectiveAt,
        })
        .where(eq(customers.customerId, testCustomerId));

      // Advance time past the effective date
      clock.setTime(new Date('2025-01-16T00:00:00Z'));

      // Run cleanup
      const result = await processCancellationCleanup(db, clock);

      expect(result.servicesProcessed).toBe(1);
      expect(result.servicesDeleted).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      // Verify platform tier reset
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBeNull(); // Reset on cleanup

      // Verify cancellation history created
      const history = await db.query.serviceCancellationHistory.findFirst({
        where: and(
          eq(serviceCancellationHistory.customerId, testCustomerId),
          eq(serviceCancellationHistory.serviceType, 'platform')
        ),
      });
      expect(history).toBeTruthy();
      expect(history?.previousTier).toBe('pro');
    });
  });

  // ==========================================================================
  // Anti-Abuse Tests
  // ==========================================================================

  describe('Anti-Abuse: Re-Provisioning Block', () => {
    it('should block provisioning during cancellation_pending state', async () => {
      // Set customer to cancellation_pending
      await db.update(customers)
        .set({
          platformCancellationEffectiveAt: clock.addDays(7),
        })
        .where(eq(customers.customerId, testCustomerId));

      const result = await canProvisionService(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('cancellation_pending');
    });

    it('should block provisioning during cooldown period', async () => {
      // Create cancellation history with active cooldown
      await db.insert(serviceCancellationHistory).values({
        customerId: testCustomerId,
        serviceType: 'platform',
        previousTier: 'pro',
        billingPeriodEndedAt: new Date('2025-01-08T00:00:00Z'),
        deletedAt: new Date('2025-01-15T00:00:00Z'),
        cooldownExpiresAt: new Date('2025-01-22T00:00:00Z'), // Expires in 7 days
      });

      // Reset customer platform tier (no active subscription)
      await db.update(customers)
        .set({ platformTier: null })
        .where(eq(customers.customerId, testCustomerId));

      const result = await canProvisionService(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('cooldown_period');
      expect(result.availableAt?.toISOString()).toContain('2025-01-22');
    });

    it('should allow provisioning after cooldown expires', async () => {
      // Create cancellation history with expired cooldown
      await db.insert(serviceCancellationHistory).values({
        customerId: testCustomerId,
        serviceType: 'platform',
        previousTier: 'pro',
        billingPeriodEndedAt: new Date('2025-01-01T00:00:00Z'),
        deletedAt: new Date('2025-01-08T00:00:00Z'),
        cooldownExpiresAt: new Date('2025-01-14T00:00:00Z'), // Already expired
      });

      // Reset customer platform tier (no active subscription)
      await db.update(customers)
        .set({ platformTier: null })
        .where(eq(customers.customerId, testCustomerId));

      const result = await canProvisionService(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(result.allowed).toBe(true);
    });

    it('should allow provisioning different service type during cooldown', async () => {
      // Create cancellation history for platform (only platform has tiers/billing)
      await db.insert(serviceCancellationHistory).values({
        customerId: testCustomerId,
        serviceType: 'platform',
        previousTier: 'pro',
        billingPeriodEndedAt: clock.now(),
        deletedAt: clock.now(),
        cooldownExpiresAt: clock.addDays(7),
      });

      // Clear platform tier (cancelled) so the platform check doesn't block
      await db.update(customers)
        .set({ platformTier: null })
        .where(eq(customers.customerId, testCustomerId));

      // Try to provision grpc (different service type) — should not be blocked
      const result = await canProvisionService(
        db,
        testCustomerId,
        'grpc',
        clock
      );

      expect(result.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Tier Change Options Tests
  // ==========================================================================

  describe('Get Tier Change Options', () => {
    it('should return available tier options with pricing', async () => {
      const options = await getTierChangeOptions(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(options).not.toBeNull();
      expect(options?.currentTier).toBe('starter');
      expect(options?.availableTiers).toHaveLength(2);

      // Find pro tier (upgrade)
      const pro = options?.availableTiers.find(t => t.tier === 'pro');
      expect(pro?.isUpgrade).toBe(true);
      expect(pro?.upgradeChargeCents).toBeGreaterThan(0);

      // Find starter tier (current)
      const starter = options?.availableTiers.find(t => t.tier === 'starter');
      expect(starter?.isCurrentTier).toBe(true);
    });

    it('should show cancellation status', async () => {
      // Schedule cancellation
      await db.update(customers)
        .set({ platformCancellationScheduledFor: '2025-01-31' })
        .where(eq(customers.customerId, testCustomerId));

      const options = await getTierChangeOptions(
        db,
        testCustomerId,
        'platform',
        clock
      );

      expect(options?.cancellationScheduled).toBe(true);
      expect(options?.cancellationEffectiveDate).toBeTruthy();
    });
  });

  // ==========================================================================
  // Full Journey Test
  // ==========================================================================

  describe('Full Cancellation Journey', () => {
    beforeEach(async () => {
      // Start full journey tests from pro tier
      await db.update(customers)
        .set({ platformTier: 'pro' })
        .where(eq(customers.customerId, testCustomerId));

      // Create a service instance (cancellation cleanup iterates over service_instances)
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        isUserEnabled: true,
        config: {},
      });
    });

    it('should complete full cancellation lifecycle with time simulation', async () => {
      // ---- Day 1: Mid-month, user schedules cancellation ----
      clock.setTime(new Date('2025-01-15T00:00:00Z'));

      const cancelResult = await scheduleCancellation(
        db,
        testCustomerId,
        'platform',
        clock
      );
      expect(cancelResult.success).toBe(true);

      // Customer still active, cancellation scheduled
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.status).toBe('active');
      expect(customer?.platformCancellationScheduledFor).toBeTruthy();

      // ---- Day 2: User tries to undo, then decides to keep cancellation ----
      clock.setTime(new Date('2025-01-20T00:00:00Z'));

      const undoResult = await undoCancellation(db, testCustomerId, 'platform', clock);
      expect(undoResult.success).toBe(true);

      // Re-schedule cancellation
      await scheduleCancellation(db, testCustomerId, 'platform', clock);

      // ---- Day 3: Billing period ends (Feb 1) - periodic billing processor runs ----
      // This simulates the realistic 5-minute periodic job that runs in production.
      // processCustomerBilling handles: scheduled tier changes, scheduled cancellations,
      // DRAFT→PENDING transitions, payment attempts, and grace period management.
      clock.setTime(new Date('2025-02-01T00:00:00Z'));

      const billingConfig: BillingProcessorConfig = {
        clock,
        gracePeriodDays: 14,
        maxRetryAttempts: 3,
        retryIntervalHours: 24,
        usageChargeThresholdCents: 100,
      };

      const billingResult = await processCustomerBilling(
        db,
        testCustomerId,
        billingConfig,
        paymentServices
      );

      // Verify the billing processor processed the cancellation
      const cancellationOp = billingResult.operations.find(
        op => op.description.includes('cancellation')
      );
      expect(cancellationOp).toBeDefined();

      // Customer now in cancellation_pending
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformCancellationEffectiveAt).toBeTruthy();

      // ---- Day 4: User tries to re-provision (blocked) ----
      clock.setTime(new Date('2025-02-03T00:00:00Z'));

      const provisionCheck = await canProvisionService(db, testCustomerId, 'platform', clock);
      expect(provisionCheck.allowed).toBe(false);
      expect(provisionCheck.reason).toBe('cancellation_pending');

      // ---- Day 5: 7 days pass, cleanup runs ----
      clock.setTime(new Date('2025-02-08T01:00:00Z'));

      const cleanupResult = await processCancellationCleanup(db, clock);
      expect(cleanupResult.servicesDeleted).toHaveLength(1);

      // Platform tier reset
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.platformTier).toBeNull();

      // ---- Day 6: User tries to re-provision (still blocked - cooldown) ----
      clock.setTime(new Date('2025-02-10T00:00:00Z'));

      const cooldownCheck = await canProvisionService(db, testCustomerId, 'platform', clock);
      expect(cooldownCheck.allowed).toBe(false);
      expect(cooldownCheck.reason).toBe('cooldown_period');

      // ---- Day 7: Cooldown expires, user can re-provision ----
      clock.setTime(new Date('2025-02-16T00:00:00Z'));

      const finalCheck = await canProvisionService(db, testCustomerId, 'platform', clock);
      expect(finalCheck.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Unpaid Subscription Tests (New Feature)
  // ==========================================================================

  describe('Unpaid Subscription Handling (paidOnce = false)', () => {
    beforeEach(async () => {
      // Reset customer to unpaid state
      await db.update(customers)
        .set({ paidOnce: false })
        .where(eq(customers.customerId, testCustomerId));
    });

    describe('Immediate Tier Changes for Unpaid Subscriptions', () => {
      it('should upgrade tier immediately without charge when paidOnce = false', async () => {
        const result = await handleTierUpgrade(
          db,
          testCustomerId,
          'platform',
          'pro',
          paymentServices,
          clock
        );

        expect(result.success).toBe(true);
        expect(result.newTier).toBe('pro');
        expect(result.chargeAmountUsdCents).toBe(0);

        // Verify tier was updated immediately
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, testCustomerId),
        });
        expect(customer?.platformTier).toBe('pro');
        expect(customer?.paidOnce).toBe(false); // Still unpaid
      });

      it('should downgrade tier immediately without scheduling when paidOnce = false', async () => {
        // Upgrade to pro first so we have somewhere to downgrade from
        await db.update(customers)
          .set({ platformTier: 'pro' })
          .where(eq(customers.customerId, testCustomerId));

        const result = await scheduleTierDowngrade(
          db,
          testCustomerId,
          'platform',
          'starter',
          clock
        );

        expect(result.success).toBe(true);
        expect(result.scheduledTier).toBe('starter');

        // Effective date should be now (immediate)
        expect(result.effectiveDate).toBeDefined();
        const now = clock.now();
        expect(result.effectiveDate!.getTime()).toBe(now.getTime());

        // Verify tier was changed immediately (not scheduled)
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, testCustomerId),
        });
        expect(customer?.platformTier).toBe('starter');
        expect(customer?.scheduledPlatformTier).toBeNull();
        expect(customer?.scheduledPlatformTierEffectiveDate).toBeNull();
      });
    });

    describe('Immediate Cancellation for Unpaid Subscriptions', () => {
      it('should cancel immediately (delete service) when paidOnce = false', async () => {
        const result = await scheduleCancellation(
          db,
          testCustomerId,
          'platform',
          clock
        );

        expect(result.success).toBe(true);

        // Effective date should be now (immediate)
        expect(result.effectiveDate).toBeDefined();
        const now = clock.now();
        expect(result.effectiveDate!.getTime()).toBe(now.getTime());

        // Verify platform tier was cleared (not scheduled for cancellation)
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, testCustomerId),
        });
        expect(customer?.platformTier).toBeNull();
      });

      it('should not create cancellation history for unpaid cancellation (no cooldown)', async () => {
        await scheduleCancellation(
          db,
          testCustomerId,
          'platform',
          clock
        );

        // Verify no cancellation history was created
        const history = await db.query.serviceCancellationHistory.findFirst({
          where: and(
            eq(serviceCancellationHistory.customerId, testCustomerId),
            eq(serviceCancellationHistory.serviceType, 'platform')
          ),
        });
        expect(history).toBeUndefined();
      });

      it('should allow immediate re-provisioning after unpaid cancellation', async () => {
        // First cancel the unpaid subscription
        await scheduleCancellation(
          db,
          testCustomerId,
          'platform',
          clock
        );

        // Try to provision again (should be allowed - no cooldown)
        const result = await canProvisionService(
          db,
          testCustomerId,
          'platform',
          clock
        );

        expect(result.allowed).toBe(true);
      });
    });

    describe('Key Operation Blocking for Unpaid Subscriptions', () => {
      it('should block key operations when paidOnce = false', async () => {
        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'platform'
        );

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('no_payment_yet');
        expect(result.message).toContain('complete your first payment');
      });

      it('should allow key operations when paidOnce = true', async () => {
        // Set paidOnce to true
        await db.update(customers)
          .set({ paidOnce: true })
          .where(eq(customers.customerId, testCustomerId));

        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'platform'
        );

        expect(result.allowed).toBe(true);
      });

      it('should block key operations when service not found', async () => {
        // Clear platform tier — no subscription means "service not found"
        await db.update(customers)
          .set({ platformTier: null })
          .where(eq(customers.customerId, testCustomerId));

        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'platform' // No platform tier → service_not_found
        );

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('service_not_found');
      });

      it('should block key operations when service not in active state', async () => {
        // Set customer to paid with platform tier, but in cancellation_pending
        // (platformCancellationEffectiveAt set → not in active state)
        await db.update(customers)
          .set({
            platformTier: 'starter',
            paidOnce: true,
            platformCancellationEffectiveAt: new Date('2025-02-01T00:00:00Z'),
          })
          .where(eq(customers.customerId, testCustomerId));

        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'platform'
        );

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('service_not_active');
      });
    });

    describe('Tier Options for Unpaid Subscriptions', () => {
      it('should show $0 upgrade charge when paidOnce = false', async () => {
        const options = await getTierChangeOptions(
          db,
          testCustomerId,
          'platform',
          clock
        );

        expect(options).not.toBeNull();
        expect(options?.paidOnce).toBe(false);

        // Pro tier should have $0 upgrade charge (unpaid)
        const pro = options?.availableTiers.find(t => t.tier === 'pro');
        expect(pro?.isUpgrade).toBe(true);
        expect(pro?.upgradeChargeCents).toBe(0);
      });

      it('should not show effectiveDate for downgrade when paidOnce = false', async () => {
        // Upgrade to pro first so starter is a downgrade
        await db.update(customers)
          .set({ platformTier: 'pro' })
          .where(eq(customers.customerId, testCustomerId));

        const options = await getTierChangeOptions(
          db,
          testCustomerId,
          'platform',
          clock
        );

        expect(options).not.toBeNull();

        // Starter (downgrade) should not have effective date (immediate)
        const starter = options?.availableTiers.find(t => t.tier === 'starter');
        expect(starter?.isDowngrade).toBe(true);
        expect(starter?.effectiveDate).toBeUndefined();
      });

      it('should show correct pricing when paidOnce = true', async () => {
        // Set paidOnce to true
        await db.update(customers)
          .set({ paidOnce: true })
          .where(eq(customers.customerId, testCustomerId));

        const options = await getTierChangeOptions(
          db,
          testCustomerId,
          'platform',
          clock
        );

        expect(options).not.toBeNull();
        expect(options?.paidOnce).toBe(true);

        // Upgrade to pro should have pro-rated charge
        const pro = options?.availableTiers.find(t => t.tier === 'pro');
        expect(pro?.upgradeChargeCents).toBeGreaterThan(0);

        // Starter is current tier — no downgrade effective date needed
        const starter = options?.availableTiers.find(t => t.tier === 'starter');
        expect(starter?.isCurrentTier).toBe(true);
      });
    });

    describe('Multiple Tier Changes Before Payment', () => {
      it('should allow changing tier multiple times without charge', async () => {
        // Upgrade to pro
        let result = await handleTierUpgrade(
          db,
          testCustomerId,
          'platform',
          'pro',
          paymentServices,
          clock
        );
        expect(result.success).toBe(true);
        expect(result.chargeAmountUsdCents).toBe(0);

        // Downgrade back to starter
        result = await scheduleTierDowngrade(
          db,
          testCustomerId,
          'platform',
          'starter',
          clock
        ) as any;
        expect(result.success).toBe(true);

        // Upgrade back to pro
        result = await handleTierUpgrade(
          db,
          testCustomerId,
          'platform',
          'pro',
          paymentServices,
          clock
        );
        expect(result.success).toBe(true);
        expect(result.chargeAmountUsdCents).toBe(0);

        // Final state
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, testCustomerId),
        });
        expect(customer?.platformTier).toBe('pro');
        expect(customer?.paidOnce).toBe(false);
      });

      it('should preserve paidOnce = false through tier changes', async () => {
        // Change tier
        await handleTierUpgrade(
          db,
          testCustomerId,
          'platform',
          'pro',
          paymentServices,
          clock
        );

        // Verify paidOnce is still false
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, testCustomerId),
        });
        expect(customer?.paidOnce).toBe(false);
      });

      it('should recalculate FAILED monthly invoices on paidOnce=false immediate downgrade', async () => {
        // Scenario: Customer subscribed Pro, paidOnce=false, has a FAILED monthly
        // billing invoice at Pro price. Immediate downgrade to Starter should
        // recalculate both the pendingInvoiceId invoice AND the FAILED monthly invoice.

        const PRO_PRICE_CENTS = 2900;   // $29
        const STARTER_PRICE_CENTS = 100; // $1

        // 1. Create a pending billing record (pendingInvoiceId)
        const [pendingInvoice] = await db.insert(billingRecords).values({
          customerId: testCustomerId,
          billingPeriodStart: clock.now(),
          billingPeriodEnd: clock.addDays(30),
          amountUsdCents: PRO_PRICE_CENTS,
          type: 'charge',
          status: 'pending',
          dueDate: clock.now(),
        }).returning();

        await db.insert(invoiceLineItems).values({
          billingRecordId: pendingInvoice.id,
          itemType: 'subscription_pro',
          serviceType: 'platform',
          amountUsdCents: PRO_PRICE_CENTS,
          unitPriceUsdCents: PRO_PRICE_CENTS,
          quantity: 1,
        });

        // 2. Create a separate FAILED monthly billing invoice at Pro price
        const [failedInvoice] = await db.insert(billingRecords).values({
          customerId: testCustomerId,
          billingPeriodStart: new Date('2025-01-01'),
          billingPeriodEnd: new Date('2025-02-01'),
          amountUsdCents: PRO_PRICE_CENTS,
          type: 'charge',
          status: 'failed',
          billingType: 'scheduled',
          dueDate: new Date('2025-02-01'),
        }).returning();

        await db.insert(invoiceLineItems).values({
          billingRecordId: failedInvoice.id,
          itemType: 'subscription_pro',
          serviceType: 'platform',
          amountUsdCents: PRO_PRICE_CENTS,
          unitPriceUsdCents: PRO_PRICE_CENTS,
          quantity: 1,
        });

        // 3. Set customer state to paidOnce=false with Pro tier
        await db.update(customers)
          .set({
            platformTier: 'pro',
            paidOnce: false,
            pendingInvoiceId: pendingInvoice.id,
          })
          .where(eq(customers.customerId, testCustomerId));

        // 4. Downgrade to Starter (immediate because paidOnce=false)
        const result = await scheduleTierDowngrade(
          db,
          testCustomerId,
          'platform',
          'starter',
          clock
        );

        expect(result.success).toBe(true);
        expect(result.scheduledTier).toBe('starter');

        // 5. Verify pendingInvoiceId invoice was updated (existing behavior)
        const updatedPending = await db.query.billingRecords.findFirst({
          where: eq(billingRecords.id, pendingInvoice.id),
        });
        expect(updatedPending?.amountUsdCents).toBe(STARTER_PRICE_CENTS);

        // 6. Verify FAILED monthly invoice was ALSO recalculated (new behavior)
        const updatedFailed = await db.query.billingRecords.findFirst({
          where: eq(billingRecords.id, failedInvoice.id),
        });
        expect(updatedFailed?.amountUsdCents).toBe(STARTER_PRICE_CENTS);
        expect(updatedFailed?.status).toBe('failed'); // Status unchanged

        // 7. Verify the FAILED invoice line item was updated
        const failedLineItems = await db.query.invoiceLineItems.findMany({
          where: eq(invoiceLineItems.billingRecordId, failedInvoice.id),
        });
        expect(failedLineItems).toHaveLength(1);
        expect(failedLineItems[0]?.itemType).toBe('subscription_starter');
        expect(failedLineItems[0]?.amountUsdCents).toBe(STARTER_PRICE_CENTS);
      });

      it('should update pending billing record amount when upgrading (Copilot bug scenario)', async () => {
        // This test verifies the fix for the potential bug identified by Copilot:
        // When a user upgrades while having a pending payment, the pending billing
        // record amount should be updated to match the new tier price.
        //
        // Scenario:
        // 1. User subscribes to Starter ($1). Payment fails. Pending invoice for $1.
        // 2. User upgrades to Pro ($29).
        // 3. Pending billing record should be updated to $29 (not remain $1).
        // 4. reconcilePayments should find the correct $29 record.

        const STARTER_PRICE_CENTS = 100; // $1
        const PRO_PRICE_CENTS = 2900;    // $29

        // 1. Create a pending billing record for the initial Starter tier
        const [pendingInvoice] = await db.insert(billingRecords).values({
          customerId: testCustomerId,
          billingPeriodStart: clock.now(),
          billingPeriodEnd: clock.addDays(30),
          amountUsdCents: STARTER_PRICE_CENTS,
          type: 'charge',
          status: 'pending',
          dueDate: clock.now(),
        }).returning();

        // Create line item for the pending invoice
        await db.insert(invoiceLineItems).values({
          billingRecordId: pendingInvoice.id,
          itemType: 'subscription_starter',
          serviceType: 'platform',
          amountUsdCents: STARTER_PRICE_CENTS,
          unitPriceUsdCents: STARTER_PRICE_CENTS,
          quantity: 1,
        });

        // Set customer state to match pending payment scenario
        await db.update(customers)
          .set({
            paidOnce: false,
            pendingInvoiceId: pendingInvoice.id, // Reference to the pending invoice
          })
          .where(eq(customers.customerId, testCustomerId));

        // Verify initial state
        const initialInvoice = await db.query.billingRecords.findFirst({
          where: eq(billingRecords.id, pendingInvoice.id),
        });
        expect(initialInvoice?.amountUsdCents).toBe(STARTER_PRICE_CENTS);
        expect(initialInvoice?.status).toBe('pending');

        // 2. Upgrade to Pro
        const result = await handleTierUpgrade(
          db,
          testCustomerId,
          'platform',
          'pro',
          paymentServices,
          clock
        );

        expect(result.success).toBe(true);
        expect(result.newTier).toBe('pro');
        expect(result.chargeAmountUsdCents).toBe(0); // No immediate charge when paidOnce = false

        // 3. Verify the pending billing record amount was updated
        const updatedInvoice = await db.query.billingRecords.findFirst({
          where: eq(billingRecords.id, pendingInvoice.id),
        });
        expect(updatedInvoice?.amountUsdCents).toBe(PRO_PRICE_CENTS);
        expect(updatedInvoice?.status).toBe('pending'); // Still pending

        // 4. Verify reconcilePayments would now match correctly
        // (The billing record amount matches the new tier price)
        const customer = await db.query.customers.findFirst({
          where: eq(customers.customerId, testCustomerId),
        });
        expect(customer?.platformTier).toBe('pro');
        expect(customer?.paidOnce).toBe(false);

        // The pending billing record's amount now matches what reconcilePayments
        // will look for when it calculates: getTierPriceUsdCents('pro') = $29
      });
    });
  });

  // ==========================================================================
  // Credit Overpayment on Recalculated Invoice
  // ==========================================================================

  describe('Credit Overpayment Recovery', () => {
    it('should mark invoice paid and issue refund credit when credits exceed recalculated amount', async () => {
      // Scenario:
      // 1. Customer on Pro (paidOnce=true), has $50 in credits
      // 2. Monthly billing applies $50 credit, escrow charge for remaining fails
      // 3. Invoice: amountUsdCents=2900, amountPaidUsdCents=5000, status='failed'
      // 4. Customer downgrades to Starter ($1)
      // 5. recalculateFailedInvoiceSubscription lowers amountUsdCents to 100
      // 6. Now amountPaidUsdCents(5000) > amountUsdCents(100)
      // 7. On retry: should mark invoice paid AND issue $49 refund credit

      const PRO_PRICE_CENTS = 2900;
      const STARTER_PRICE_CENTS = 100;
      const CREDIT_AMOUNT_CENTS = 5000; // $50

      // Set up: Pro tier, paidOnce=true
      await db.update(customers)
        .set({ platformTier: 'pro', paidOnce: true })
        .where(eq(customers.customerId, testCustomerId));

      // 1. Issue credits to the customer
      const tx = unsafeAsLockedTransaction(db);
      const creditId = await issueCredit(tx, testCustomerId, CREDIT_AMOUNT_CENTS, 'reconciliation', 'Test credit');
      // Mark the credit as consumed (to simulate applyCreditsToInvoice)
      await db.update(customerCredits)
        .set({ remainingAmountUsdCents: 0 })
        .where(eq(customerCredits.creditId, creditId));

      // 2. Create FAILED invoice at Pro price with credits already applied
      const [failedInvoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-02-01'),
        amountUsdCents: PRO_PRICE_CENTS,
        amountPaidUsdCents: CREDIT_AMOUNT_CENTS, // $50 already paid via credits
        type: 'charge',
        status: 'failed',
        billingType: 'scheduled',
        dueDate: new Date('2025-02-01'),
        failureReason: 'Insufficient balance',
        retryCount: 1,
      }).returning();

      await db.insert(invoiceLineItems).values({
        billingRecordId: failedInvoice.id,
        itemType: 'subscription_pro',
        serviceType: 'platform',
        amountUsdCents: PRO_PRICE_CENTS,
        unitPriceUsdCents: PRO_PRICE_CENTS,
        quantity: 1,
      });

      // Record the credit payment in invoicePayments
      await db.insert(invoicePayments).values({
        billingRecordId: failedInvoice.id,
        sourceType: 'credit',
        creditId: creditId,
        amountUsdCents: CREDIT_AMOUNT_CENTS,
      });

      // 3. Schedule downgrade to Starter → recalculates FAILED invoice
      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'platform',
        'starter',
        clock
      );
      expect(result.success).toBe(true);

      // Verify: invoice amount was recalculated to Starter price
      const recalcedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, failedInvoice.id),
      });
      expect(recalcedInvoice?.amountUsdCents).toBe(STARTER_PRICE_CENTS);
      // amountPaidUsdCents is still $50 — exceeds the new $1 total
      expect(recalcedInvoice?.amountPaidUsdCents).toBe(CREDIT_AMOUNT_CENTS);

      // 4. Retry the invoice — should detect overpayment
      const providers = await getCustomerProviders(testCustomerId, paymentServices, tx, clock);
      const payResult = await processInvoicePayment(tx, failedInvoice.id, providers, clock);

      // Should be marked as fully paid
      expect(payResult.fullyPaid).toBe(true);

      // 5. Verify invoice is now marked 'paid' (not stuck as 'failed')
      const finalInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, failedInvoice.id),
      });
      expect(finalInvoice?.status).toBe('paid');

      // 6. Verify refund credit was issued for the overpayment ($50 - $1 = $49)
      const overpaymentCents = CREDIT_AMOUNT_CENTS - STARTER_PRICE_CENTS; // 4900
      const refundCredits = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });

      // Find the refund credit (not the original test credit)
      const refundCredit = refundCredits.find(c =>
        Number(c.originalAmountUsdCents) === overpaymentCents
      );
      expect(refundCredit).toBeDefined();
      expect(Number(refundCredit!.originalAmountUsdCents)).toBe(overpaymentCents);
      expect(Number(refundCredit!.remainingAmountUsdCents)).toBe(overpaymentCents);
    });
  });

  describe('Overpayment Credit Idempotency', () => {
    it('should NOT issue duplicate overpayment credit when processInvoicePayment is called twice on a paid invoice', async () => {
      // BUG: processInvoicePayment's early-return path issues a reconciliation
      // credit every time it's called on an invoice where alreadyPaid >= totalAmount.
      // A second call on an already-paid invoice mints a duplicate credit.

      const PRO_PRICE_CENTS = 2900;    // $29
      const STARTER_PRICE_CENTS = 100; // $1
      const CREDIT_AMOUNT_CENTS = 5000; // $50

      const tx = unsafeAsLockedTransaction(db);

      // 1. Create a FAILED invoice at Pro price with $50 credit already applied
      const creditId = await issueCredit(db, testCustomerId, CREDIT_AMOUNT_CENTS, 'promo', 'Test credit for idempotency');

      const [failedInvoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        amountUsdCents: PRO_PRICE_CENTS,
        amountPaidUsdCents: CREDIT_AMOUNT_CENTS, // $50 already paid via credits
        status: 'failed',
        type: 'charge',
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        dueDate: new Date('2025-02-01'),
      }).returning();

      await db.insert(invoiceLineItems).values({
        billingRecordId: failedInvoice.id,
        itemType: 'subscription_pro',
        serviceType: 'platform',
        amountUsdCents: PRO_PRICE_CENTS,
        unitPriceUsdCents: PRO_PRICE_CENTS,
        quantity: 1,
      });

      await db.insert(invoicePayments).values({
        billingRecordId: failedInvoice.id,
        sourceType: 'credit',
        creditId: creditId,
        amountUsdCents: CREDIT_AMOUNT_CENTS,
      });

      // 2. Downgrade to Starter → recalculates to $1
      await scheduleTierDowngrade(db, testCustomerId, 'platform', 'starter', clock);

      // 3. First call to processInvoicePayment → should mark paid + issue overpayment credit
      const providers = await getCustomerProviders(testCustomerId, paymentServices, tx, clock);
      const result1 = await processInvoicePayment(tx, failedInvoice.id, providers, clock);
      expect(result1.fullyPaid).toBe(true);

      // Count reconciliation credits after first call
      const creditsAfterFirst = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });
      const overpaymentCreditsAfterFirst = creditsAfterFirst.filter(c =>
        (c.description ?? '').includes('Overpayment refund')
      );
      expect(overpaymentCreditsAfterFirst).toHaveLength(1);

      // 4. Second call to processInvoicePayment on same (now paid) invoice
      const result2 = await processInvoicePayment(tx, failedInvoice.id, providers, clock);
      expect(result2.fullyPaid).toBe(true);

      // 5. Should NOT have minted a second overpayment credit
      const creditsAfterSecond = await db.query.customerCredits.findMany({
        where: and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ),
      });
      const overpaymentCreditsAfterSecond = creditsAfterSecond.filter(c =>
        (c.description ?? '').includes('Overpayment refund')
      );
      expect(overpaymentCreditsAfterSecond).toHaveLength(1); // Still exactly 1, not 2
    });
  });

  describe('Repriced Invoice Retry Reset', () => {
    it('should reset retryCount on repriced FAILED invoices so periodic job can retry them', async () => {
      // BUG: recalculateFailedInvoiceSubscription lowers the invoice amount
      // but doesn't reset retryCount/lastRetryAt. If the invoice already
      // exhausted max retries, the periodic job skips it permanently even
      // though it's now affordable after the tier downgrade.

      const PRO_PRICE_CENTS = 2900;    // $29
      const STARTER_PRICE_CENTS = 100; // $1

      // Set customer at pro tier for the downgrade to make sense
      await db.update(customers)
        .set({ platformTier: 'pro' })
        .where(eq(customers.customerId, testCustomerId));

      // 1. Create a FAILED invoice that has exhausted retries
      const [failedInvoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        amountUsdCents: PRO_PRICE_CENTS,
        amountPaidUsdCents: 0,
        status: 'failed',
        type: 'charge',
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        dueDate: new Date('2025-02-01'),
        retryCount: 10, // Exhausted max retries
        lastRetryAt: new Date('2025-02-10'),
        failureReason: 'Insufficient balance',
      }).returning();

      await db.insert(invoiceLineItems).values({
        billingRecordId: failedInvoice.id,
        itemType: 'subscription_pro',
        serviceType: 'platform',
        amountUsdCents: PRO_PRICE_CENTS,
        unitPriceUsdCents: PRO_PRICE_CENTS,
        quantity: 1,
      });

      // 2. Downgrade to Starter → recalculates invoice to $1
      const result = await scheduleTierDowngrade(
        db, testCustomerId, 'platform', 'starter', clock
      );
      expect(result.success).toBe(true);

      // 3. Verify invoice amount was recalculated
      const recalcedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, failedInvoice.id),
      });
      expect(recalcedInvoice?.amountUsdCents).toBe(STARTER_PRICE_CENTS);

      // 4. Verify retry metadata was reset so periodic job can pick it up
      expect(recalcedInvoice?.retryCount).toBe(0);
      expect(recalcedInvoice?.lastRetryAt).toBeNull();
      expect(recalcedInvoice?.failureReason).toBeNull();
    });
  });

  // ==========================================================================
  // Bug: Downgrade then Cancel loses scheduled refund
  // ==========================================================================

  describe('Downgrade then Cancel - Refund Preservation', () => {
    it('should still process excess credit refund when downgrade is followed by cancellation', async () => {
      // BUG: Subscribe Pro → Downgrade to Starter → Cancel → refund for partial
      // month disappears. The cancellation clears scheduledTier, so on Feb 1
      // applyScheduledTierChanges returns 0 and processExcessCreditRefunds is
      // never called, leaving the reconciliation credit stranded.

      const PRO_PRICE_CENTS = PLATFORM_TIER_PRICES_USD_CENTS.pro;

      // ---- Jan 5: Subscribe at Pro tier ----
      clock.setTime(new Date('2025-01-05T00:00:00Z'));

      // Set customer to pro tier for this test
      await db.update(customers)
        .set({ platformTier: 'pro' })
        .where(eq(customers.customerId, testCustomerId));

      // Compute reconciliation credit the same way production does:
      // daysUsed = 31 - 5 + 1 = 27, daysNotUsed = 31 - 27 = 4
      // credit = floor(2900 * 4 / 31) = floor(374.19) = 374 cents
      const daysInJan = 31;
      const subscribeDay = 5;
      const daysUsed = daysInJan - subscribeDay + 1;
      const daysNotUsed = daysInJan - daysUsed;
      const expectedCreditCents = Math.floor((PRO_PRICE_CENTS * daysNotUsed) / daysInJan);
      expect(expectedCreditCents).toBe(374); // $3.74 sanity check

      // Simulate subscription payment: create an immediate invoice (paid)
      const [subInvoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: new Date('2025-02-04'),
        amountUsdCents: PRO_PRICE_CENTS,
        amountPaidUsdCents: PRO_PRICE_CENTS,
        type: 'charge',
        status: 'paid',
        billingType: 'immediate',
        createdAt: clock.now(),
      }).returning({ id: billingRecords.id });

      // Create a Stripe invoice_payments row so processExcessCreditRefunds has
      // a Stripe charge to refund against
      await db.insert(invoicePayments).values({
        billingRecordId: subInvoice.id,
        sourceType: 'stripe',
        providerReferenceId: 'in_test_stripe_refund_bug',
        creditId: null,
        escrowTransactionId: null,
        amountUsdCents: PRO_PRICE_CENTS,
      });

      // Issue reconciliation credit using the clock-derived amount
      await issueCredit(
        db,
        testCustomerId,
        expectedCreditCents,
        'reconciliation',
        `Partial month credit for platform (${daysNotUsed}/${daysInJan} days unused)`,
        null,
      );

      // Verify credit exists with correct amount
      const creditsAfterSubscribe = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ));
      expect(creditsAfterSubscribe).toHaveLength(1);
      expect(Number(creditsAfterSubscribe[0].remainingAmountUsdCents)).toBe(expectedCreditCents);

      // ---- Jan 15: Downgrade Pro → Starter ----
      clock.setTime(new Date('2025-01-15T00:00:00Z'));

      const downgradeResult = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'platform',
        'starter',
        clock
      );
      expect(downgradeResult.success).toBe(true);
      expect(downgradeResult.scheduledTier).toBe('starter');

      // Verify scheduled tier is set
      let cust = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(cust?.scheduledPlatformTier).toBe('starter');
      expect(cust?.scheduledPlatformTierEffectiveDate).toBeTruthy();

      // ---- Jan 20: Cancel subscription ----
      clock.setTime(new Date('2025-01-20T00:00:00Z'));

      const cancelResult = await scheduleCancellation(
        db,
        testCustomerId,
        'platform',
        clock
      );
      expect(cancelResult.success).toBe(true);

      // Verify: cancellation cleared the scheduled tier (this is the bug trigger)
      cust = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(cust?.platformCancellationScheduledFor).toBeTruthy();
      expect(cust?.scheduledPlatformTier).toBeNull(); // Bug: this was cleared

      // Reconciliation credit should still exist
      const creditsBeforeBilling = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ));
      expect(Number(creditsBeforeBilling[0].remainingAmountUsdCents)).toBe(expectedCreditCents);

      // ---- Feb 1: Monthly billing runs ----
      clock.setTime(new Date('2025-02-01T00:00:00Z'));

      // A DRAFT invoice already exists — created by scheduleTierDowngrade's
      // recalculateDraftInvoice call. Verify it's there.
      const existingDrafts = await db.select().from(billingRecords)
        .where(and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft'),
        ));
      expect(existingDrafts.length).toBeGreaterThanOrEqual(1);

      const billingConfig: BillingProcessorConfig = {
        clock,
        gracePeriodDays: 14,
        maxRetryAttempts: 3,
        retryIntervalHours: 24,
        usageChargeThresholdCents: 100,
      };

      await processCustomerBilling(
        db,
        testCustomerId,
        billingConfig,
        paymentServices
      );

      // ---- Verify: The excess reconciliation credit should have been refunded ----
      // After cancellation, monthly cost is $0. All reconciliation credit is excess.
      //
      // BUG: processExcessCreditRefunds is gated behind tierChangesApplied > 0.
      // Cancellation cleared scheduledTier, so no tier changes applied on Feb 1,
      // and the refund is never processed. Credit stays at 374.

      const creditsAfterBilling = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ));

      const totalRemainingCredits = creditsAfterBilling.reduce(
        (sum, c) => sum + Number(c.remainingAmountUsdCents), 0
      );

      // After refund: credit should be 0 (all excess refunded to Stripe).
      expect(totalRemainingCredits).toBe(0);

      // Verify a refund billing record was created
      const refundRecords = await db.select().from(billingRecords)
        .where(and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.type, 'credit'),
        ));
      expect(refundRecords).toHaveLength(1);
      expect(Number(refundRecords[0].amountUsdCents)).toBe(expectedCreditCents);
    });
  });
});
