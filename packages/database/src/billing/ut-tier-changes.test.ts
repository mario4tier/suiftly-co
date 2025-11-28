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
  serviceInstances,
  escrowTransactions,
  billingIdempotency,
  serviceCancellationHistory,
  apiKeys,
  sealKeys,
  sealPackages,
  userActivityLogs,
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
import { processCancellationCleanup } from './cancellation-cleanup';
import { processCustomerBilling } from './processor';
import type { BillingProcessorConfig } from './types';
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

  const testWalletAddress = '0xTIER3000567890abcdefABCDEF1234567890abcdefABCDEF1234567890abc';
  let testCustomerId: number;
  let testInstanceId: number;

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE user_activity_logs CASCADE`);
    await db.execute(sql`TRUNCATE TABLE service_cancellation_history CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_idempotency CASCADE`);
    await db.execute(sql`TRUNCATE TABLE invoice_payments CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_records CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customer_credits CASCADE`);
    await db.execute(sql`TRUNCATE TABLE seal_packages CASCADE`);
    await db.execute(sql`TRUNCATE TABLE seal_keys CASCADE`);
    await db.execute(sql`TRUNCATE TABLE api_keys CASCADE`);
    await db.execute(sql`TRUNCATE TABLE service_instances CASCADE`);
    await db.execute(sql`TRUNCATE TABLE escrow_transactions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers CASCADE`);
  });

  beforeEach(async () => {
    // Reset mock service
    suiService.setFailure(false);

    // Set time to Jan 15, 2025 (mid-month)
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

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
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;

    // Create service in Pro tier (with paidOnce = true for existing tests)
    const [service] = await db.insert(serviceInstances).values({
      customerId: testCustomerId,
      serviceType: 'seal',
      tier: 'pro',
      state: 'enabled',
      isUserEnabled: true,
      subscriptionChargePending: false,
      paidOnce: true, // Service has been paid for (normal paid subscription)
      config: { tier: 'pro' },
    }).returning();

    testInstanceId = service.instanceId;
  });

  afterEach(async () => {
    await db.delete(userActivityLogs);
    await db.execute(sql`TRUNCATE TABLE service_cancellation_history CASCADE`);
    await db.delete(billingIdempotency);
    await db.delete(invoicePayments);
    await db.delete(billingRecords);
    await db.delete(customerCredits);
    await db.delete(sealPackages);
    await db.delete(sealKeys);
    await db.delete(apiKeys);
    await db.delete(serviceInstances);
    await db.delete(escrowTransactions);
    await db.delete(customers);
  });

  // ==========================================================================
  // Tier Upgrade Tests
  // ==========================================================================

  describe('Tier Upgrade (Immediate Effect)', () => {
    it('should upgrade tier with pro-rated charge', async () => {
      // Upgrade from Pro ($29) to Enterprise ($185) on Jan 15
      // 17 days remaining in 31-day month
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'seal',
        'enterprise',
        suiService,
        clock
      );

      expect(result.success).toBe(true);
      expect(result.newTier).toBe('enterprise');

      // Expected charge: ($185 - $29) × (17/31) = $156 × 0.548 = $85.48
      const expectedCharge = Math.floor((15600 * 17) / 31);
      expect(result.chargeAmountUsdCents).toBe(expectedCharge);

      // Verify tier was updated immediately
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.tier).toBe('enterprise');
    });

    it('should charge $0 and upgrade immediately when ≤2 days remaining (grace period)', async () => {
      // Upgrade on Jan 30 (2 days remaining)
      clock.setTime(new Date('2025-01-30T00:00:00Z'));

      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'seal',
        'enterprise',
        suiService,
        clock
      );

      expect(result.success).toBe(true);
      expect(result.chargeAmountUsdCents).toBe(0);
      expect(result.newTier).toBe('enterprise');

      // Verify tier was updated
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.tier).toBe('enterprise');
    });

    it('should fail upgrade if payment fails', async () => {
      suiService.setFailure(true, 'Insufficient balance');

      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'seal',
        'enterprise',
        suiService,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');

      // Verify tier was NOT updated
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.tier).toBe('pro'); // Still Pro
    });

    it('should reject downgrade attempt as upgrade', async () => {
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'seal',
        'starter', // Lower tier
        suiService,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Use downgrade for lower tiers');
    });

    it('should clear scheduled downgrade when upgrading', async () => {
      // First schedule a downgrade
      await db.update(serviceInstances)
        .set({
          scheduledTier: 'starter',
          scheduledTierEffectiveDate: '2025-02-01',
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      // Now upgrade (should clear the scheduled downgrade)
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'seal',
        'enterprise',
        suiService,
        clock
      );

      expect(result.success).toBe(true);

      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.tier).toBe('enterprise');
      expect(service?.scheduledTier).toBeNull();
      expect(service?.scheduledTierEffectiveDate).toBeNull();
    });

    it('should clear scheduled cancellation when upgrading', async () => {
      // First schedule cancellation
      await db.update(serviceInstances)
        .set({
          cancellationScheduledFor: '2025-01-31',
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      // Now upgrade (should clear cancellation)
      const result = await handleTierUpgrade(
        db,
        testCustomerId,
        'seal',
        'enterprise',
        suiService,
        clock
      );

      expect(result.success).toBe(true);

      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.cancellationScheduledFor).toBeNull();
    });
  });

  // ==========================================================================
  // Tier Downgrade Tests
  // ==========================================================================

  describe('Tier Downgrade (Scheduled Effect)', () => {
    it('should schedule downgrade for end of billing period', async () => {
      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'seal',
        'starter',
        clock
      );

      expect(result.success).toBe(true);
      expect(result.scheduledTier).toBe('starter');

      // Effective date should be Feb 1, 2025
      expect(result.effectiveDate.getUTCFullYear()).toBe(2025);
      expect(result.effectiveDate.getUTCMonth()).toBe(1); // February
      expect(result.effectiveDate.getUTCDate()).toBe(1);

      // Verify scheduled in database
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.tier).toBe('pro'); // Still Pro until effective date
      expect(service?.scheduledTier).toBe('starter');
    });

    it('should reject upgrade attempt as downgrade', async () => {
      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'seal',
        'enterprise', // Higher tier
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Use upgrade for higher tiers');
    });

    it('should clear cancellation when scheduling downgrade', async () => {
      // First schedule cancellation
      await db.update(serviceInstances)
        .set({
          cancellationScheduledFor: '2025-01-31',
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      // Now schedule downgrade (should clear cancellation)
      const result = await scheduleTierDowngrade(
        db,
        testCustomerId,
        'seal',
        'starter',
        clock
      );

      expect(result.success).toBe(true);

      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.cancellationScheduledFor).toBeNull();
      expect(service?.scheduledTier).toBe('starter');
    });

    it('should allow canceling scheduled tier change', async () => {
      // Schedule downgrade
      await scheduleTierDowngrade(
        db,
        testCustomerId,
        'seal',
        'starter',
        clock
      );

      // Cancel it
      const result = await cancelScheduledTierChange(
        db,
        testCustomerId,
        'seal',
        clock
      );

      expect(result.success).toBe(true);

      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.scheduledTier).toBeNull();
    });

    it('should apply scheduled tier change on 1st of month', async () => {
      // Schedule downgrade to starter
      await db.update(serviceInstances)
        .set({
          scheduledTier: 'starter',
          scheduledTierEffectiveDate: '2025-02-01',
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      // Advance to Feb 1
      clock.setTime(new Date('2025-02-01T00:00:00Z'));

      // Apply tier changes
      await db.transaction(async (tx) => {
        const count = await applyScheduledTierChanges(tx, testCustomerId, clock);
        expect(count).toBe(1);
      });

      // Verify tier was changed
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.tier).toBe('starter');
      expect(service?.scheduledTier).toBeNull();
      expect(service?.scheduledTierEffectiveDate).toBeNull();
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
        'seal',
        clock
      );

      expect(result.success).toBe(true);

      // Effective date should be Jan 31, 2025 (end of month)
      expect(result.effectiveDate.getUTCDate()).toBe(31);

      // Verify scheduled in database (service still active)
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.state).toBe('enabled'); // Still enabled
      expect(service?.cancellationScheduledFor).toBeTruthy();
    });

    it('should allow undoing scheduled cancellation', async () => {
      // Schedule cancellation
      await scheduleCancellation(
        db,
        testCustomerId,
        'seal',
        clock
      );

      // Undo it
      const result = await undoCancellation(
        db,
        testCustomerId,
        'seal',
        clock
      );

      expect(result.success).toBe(true);

      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.cancellationScheduledFor).toBeNull();
    });

    it('should transition to cancellation_pending on 1st of month', async () => {
      // Schedule cancellation for end of January
      await db.update(serviceInstances)
        .set({
          cancellationScheduledFor: '2025-01-31',
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      // Advance to Feb 1
      clock.setTime(new Date('2025-02-01T00:00:00Z'));

      // Process cancellations
      await db.transaction(async (tx) => {
        const count = await processScheduledCancellations(tx, testCustomerId, clock);
        expect(count).toBe(1);
      });

      // Verify state changed to cancellation_pending
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.state).toBe('cancellation_pending');
      expect(service?.isUserEnabled).toBe(false);
      expect(service?.cancellationScheduledFor).toBeNull();
      expect(service?.cancellationEffectiveAt).toBeTruthy();

      // Cancellation effective should be 7 days from now
      const effectiveAt = new Date(service!.cancellationEffectiveAt!);
      const expectedEffective = clock.addDays(7);
      expect(effectiveAt.getTime()).toBe(expectedEffective.getTime());
    });

    it('should not allow undo after billing period ends', async () => {
      // Set service to cancellation_pending state
      await db.update(serviceInstances)
        .set({
          state: 'cancellation_pending',
          cancellationEffectiveAt: clock.addDays(7),
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      const result = await undoCancellation(
        db,
        testCustomerId,
        'seal',
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
    it('should delete service after 7-day grace period', async () => {
      // Create API key and seal key for the service
      await db.insert(apiKeys).values({
        apiKeyFp: 999999,
        apiKeyId: 'test-api-key-' + Date.now(),
        customerId: testCustomerId,
        serviceType: 'seal',
      });

      await db.insert(sealKeys).values({
        customerId: testCustomerId,
        instanceId: testInstanceId,
        publicKey: Buffer.from('0'.repeat(96), 'hex'),
        derivationIndex: 0,
      });

      // Set service to cancellation_pending with past effective date
      const effectiveAt = new Date('2025-01-15T00:00:00Z');
      await db.update(serviceInstances)
        .set({
          state: 'cancellation_pending',
          cancellationEffectiveAt: effectiveAt,
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      // Advance time past the effective date
      clock.setTime(new Date('2025-01-16T00:00:00Z'));

      // Run cleanup
      const result = await processCancellationCleanup(db, clock);

      expect(result.servicesProcessed).toBe(1);
      expect(result.servicesDeleted).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      // Verify service reset to not_provisioned
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.state).toBe('not_provisioned');
      expect(service?.tier).toBe('starter');
      expect(service?.config).toBeNull();

      // Verify API keys deleted
      const remainingApiKeys = await db.select()
        .from(apiKeys)
        .where(eq(apiKeys.customerId, testCustomerId));
      expect(remainingApiKeys).toHaveLength(0);

      // Verify seal keys deleted
      const remainingSealKeys = await db.select()
        .from(sealKeys)
        .where(eq(sealKeys.customerId, testCustomerId));
      expect(remainingSealKeys).toHaveLength(0);

      // Verify cancellation history created
      const history = await db.query.serviceCancellationHistory.findFirst({
        where: and(
          eq(serviceCancellationHistory.customerId, testCustomerId),
          eq(serviceCancellationHistory.serviceType, 'seal')
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
      // Set service to cancellation_pending
      await db.update(serviceInstances)
        .set({
          state: 'cancellation_pending',
          cancellationEffectiveAt: clock.addDays(7),
        })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      const result = await canProvisionService(
        db,
        testCustomerId,
        'seal',
        clock
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('cancellation_pending');
    });

    it('should block provisioning during cooldown period', async () => {
      // Create cancellation history with active cooldown
      await db.insert(serviceCancellationHistory).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        previousTier: 'pro',
        billingPeriodEndedAt: new Date('2025-01-08T00:00:00Z'),
        deletedAt: new Date('2025-01-15T00:00:00Z'),
        cooldownExpiresAt: new Date('2025-01-22T00:00:00Z'), // Expires in 7 days
      });

      // Reset service to not_provisioned
      await db.update(serviceInstances)
        .set({ state: 'not_provisioned' })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      const result = await canProvisionService(
        db,
        testCustomerId,
        'seal',
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
        serviceType: 'seal',
        previousTier: 'pro',
        billingPeriodEndedAt: new Date('2025-01-01T00:00:00Z'),
        deletedAt: new Date('2025-01-08T00:00:00Z'),
        cooldownExpiresAt: new Date('2025-01-14T00:00:00Z'), // Already expired
      });

      // Reset service to not_provisioned
      await db.update(serviceInstances)
        .set({ state: 'not_provisioned' })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      const result = await canProvisionService(
        db,
        testCustomerId,
        'seal',
        clock
      );

      expect(result.allowed).toBe(true);
    });

    it('should allow provisioning different service type during cooldown', async () => {
      // Create cancellation history for seal service
      await db.insert(serviceCancellationHistory).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        previousTier: 'pro',
        billingPeriodEndedAt: clock.now(),
        deletedAt: clock.now(),
        cooldownExpiresAt: clock.addDays(7),
      });

      // Try to provision grpc (different service type)
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
        'seal',
        clock
      );

      expect(options).not.toBeNull();
      expect(options?.currentTier).toBe('pro');
      expect(options?.availableTiers).toHaveLength(3);

      // Find starter tier (downgrade)
      const starter = options?.availableTiers.find(t => t.tier === 'starter');
      expect(starter?.isDowngrade).toBe(true);
      expect(starter?.effectiveDate).toBeTruthy();

      // Find enterprise tier (upgrade)
      const enterprise = options?.availableTiers.find(t => t.tier === 'enterprise');
      expect(enterprise?.isUpgrade).toBe(true);
      expect(enterprise?.upgradeChargeCents).toBeGreaterThan(0);
    });

    it('should show cancellation status', async () => {
      // Schedule cancellation
      await db.update(serviceInstances)
        .set({ cancellationScheduledFor: '2025-01-31' })
        .where(eq(serviceInstances.instanceId, testInstanceId));

      const options = await getTierChangeOptions(
        db,
        testCustomerId,
        'seal',
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
    it('should complete full cancellation lifecycle with time simulation', async () => {
      // ---- Day 1: Mid-month, user schedules cancellation ----
      clock.setTime(new Date('2025-01-15T00:00:00Z'));

      const cancelResult = await scheduleCancellation(
        db,
        testCustomerId,
        'seal',
        clock
      );
      expect(cancelResult.success).toBe(true);

      // Service still active, cancellation scheduled
      let service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.state).toBe('enabled');
      expect(service?.cancellationScheduledFor).toBeTruthy();

      // ---- Day 2: User tries to undo, then decides to keep cancellation ----
      clock.setTime(new Date('2025-01-20T00:00:00Z'));

      const undoResult = await undoCancellation(db, testCustomerId, 'seal', clock);
      expect(undoResult.success).toBe(true);

      // Re-schedule cancellation
      await scheduleCancellation(db, testCustomerId, 'seal', clock);

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
        suiService
      );

      // Verify the billing processor processed the cancellation
      const cancellationOp = billingResult.operations.find(
        op => op.description.includes('cancellation')
      );
      expect(cancellationOp).toBeDefined();

      // Service now in cancellation_pending
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.state).toBe('cancellation_pending');
      expect(service?.isUserEnabled).toBe(false);

      // ---- Day 4: User tries to re-provision (blocked) ----
      clock.setTime(new Date('2025-02-03T00:00:00Z'));

      const provisionCheck = await canProvisionService(db, testCustomerId, 'seal', clock);
      expect(provisionCheck.allowed).toBe(false);
      expect(provisionCheck.reason).toBe('cancellation_pending');

      // ---- Day 5: 7 days pass, cleanup runs ----
      clock.setTime(new Date('2025-02-08T01:00:00Z'));

      const cleanupResult = await processCancellationCleanup(db, clock);
      expect(cleanupResult.servicesDeleted).toHaveLength(1);

      // Service reset to not_provisioned
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, testInstanceId),
      });
      expect(service?.state).toBe('not_provisioned');

      // ---- Day 6: User tries to re-provision (still blocked - cooldown) ----
      clock.setTime(new Date('2025-02-10T00:00:00Z'));

      const cooldownCheck = await canProvisionService(db, testCustomerId, 'seal', clock);
      expect(cooldownCheck.allowed).toBe(false);
      expect(cooldownCheck.reason).toBe('cooldown_period');

      // ---- Day 7: Cooldown expires, user can re-provision ----
      clock.setTime(new Date('2025-02-16T00:00:00Z'));

      const finalCheck = await canProvisionService(db, testCustomerId, 'seal', clock);
      expect(finalCheck.allowed).toBe(true);
    });
  });

  // ==========================================================================
  // Unpaid Subscription Tests (New Feature)
  // ==========================================================================

  describe('Unpaid Subscription Handling (paidOnce = false)', () => {
    beforeEach(async () => {
      // Reset service to unpaid state
      await db.update(serviceInstances)
        .set({ paidOnce: false })
        .where(eq(serviceInstances.instanceId, testInstanceId));
    });

    describe('Immediate Tier Changes for Unpaid Subscriptions', () => {
      it('should upgrade tier immediately without charge when paidOnce = false', async () => {
        const result = await handleTierUpgrade(
          db,
          testCustomerId,
          'seal',
          'enterprise',
          suiService,
          clock
        );

        expect(result.success).toBe(true);
        expect(result.newTier).toBe('enterprise');
        expect(result.chargeAmountUsdCents).toBe(0);
        expect(result.immediateUnpaid).toBe(true);

        // Verify tier was updated immediately
        const service = await db.query.serviceInstances.findFirst({
          where: eq(serviceInstances.instanceId, testInstanceId),
        });
        expect(service?.tier).toBe('enterprise');
        expect(service?.paidOnce).toBe(false); // Still unpaid
      });

      it('should downgrade tier immediately without scheduling when paidOnce = false', async () => {
        const result = await scheduleTierDowngrade(
          db,
          testCustomerId,
          'seal',
          'starter',
          clock
        );

        expect(result.success).toBe(true);
        expect(result.scheduledTier).toBe('starter');
        expect(result.immediateUnpaid).toBe(true);

        // Effective date should be now (immediate)
        const now = clock.now();
        expect(result.effectiveDate.getTime()).toBe(now.getTime());

        // Verify tier was changed immediately (not scheduled)
        const service = await db.query.serviceInstances.findFirst({
          where: eq(serviceInstances.instanceId, testInstanceId),
        });
        expect(service?.tier).toBe('starter');
        expect(service?.scheduledTier).toBeNull();
        expect(service?.scheduledTierEffectiveDate).toBeNull();
      });
    });

    describe('Immediate Cancellation for Unpaid Subscriptions', () => {
      it('should cancel immediately (delete service) when paidOnce = false', async () => {
        const result = await scheduleCancellation(
          db,
          testCustomerId,
          'seal',
          clock
        );

        expect(result.success).toBe(true);
        expect(result.immediateUnpaid).toBe(true);

        // Effective date should be now (immediate)
        const now = clock.now();
        expect(result.effectiveDate.getTime()).toBe(now.getTime());

        // Verify service was DELETED (not scheduled for cancellation)
        const service = await db.query.serviceInstances.findFirst({
          where: eq(serviceInstances.instanceId, testInstanceId),
        });
        expect(service).toBeUndefined();
      });

      it('should not create cancellation history for unpaid cancellation (no cooldown)', async () => {
        await scheduleCancellation(
          db,
          testCustomerId,
          'seal',
          clock
        );

        // Verify no cancellation history was created
        const history = await db.query.serviceCancellationHistory.findFirst({
          where: and(
            eq(serviceCancellationHistory.customerId, testCustomerId),
            eq(serviceCancellationHistory.serviceType, 'seal')
          ),
        });
        expect(history).toBeUndefined();
      });

      it('should allow immediate re-provisioning after unpaid cancellation', async () => {
        // First cancel the unpaid subscription
        await scheduleCancellation(
          db,
          testCustomerId,
          'seal',
          clock
        );

        // Try to provision again (should be allowed - no cooldown)
        const result = await canProvisionService(
          db,
          testCustomerId,
          'seal',
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
          'seal'
        );

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('no_payment_yet');
        expect(result.message).toContain('complete your first payment');
      });

      it('should allow key operations when paidOnce = true', async () => {
        // Set paidOnce to true
        await db.update(serviceInstances)
          .set({ paidOnce: true })
          .where(eq(serviceInstances.instanceId, testInstanceId));

        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'seal'
        );

        expect(result.allowed).toBe(true);
      });

      it('should block key operations when service not found', async () => {
        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'grpc' // Service doesn't exist
        );

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('service_not_found');
      });

      it('should block key operations when service not in active state', async () => {
        // Set service to not_provisioned state
        await db.update(serviceInstances)
          .set({ state: 'not_provisioned', paidOnce: true })
          .where(eq(serviceInstances.instanceId, testInstanceId));

        const result = await canPerformKeyOperation(
          db,
          testCustomerId,
          'seal'
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
          'seal',
          clock
        );

        expect(options).not.toBeNull();
        expect(options?.paidOnce).toBe(false);

        // All tiers should have $0 upgrade charge
        const enterprise = options?.availableTiers.find(t => t.tier === 'enterprise');
        expect(enterprise?.isUpgrade).toBe(true);
        expect(enterprise?.upgradeChargeCents).toBe(0);
      });

      it('should not show effectiveDate for downgrade when paidOnce = false', async () => {
        const options = await getTierChangeOptions(
          db,
          testCustomerId,
          'seal',
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
        await db.update(serviceInstances)
          .set({ paidOnce: true })
          .where(eq(serviceInstances.instanceId, testInstanceId));

        const options = await getTierChangeOptions(
          db,
          testCustomerId,
          'seal',
          clock
        );

        expect(options).not.toBeNull();
        expect(options?.paidOnce).toBe(true);

        // Upgrade should have pro-rated charge
        const enterprise = options?.availableTiers.find(t => t.tier === 'enterprise');
        expect(enterprise?.upgradeChargeCents).toBeGreaterThan(0);

        // Downgrade should have effective date
        const starter = options?.availableTiers.find(t => t.tier === 'starter');
        expect(starter?.effectiveDate).toBeTruthy();
      });
    });

    describe('Multiple Tier Changes Before Payment', () => {
      it('should allow changing tier multiple times without charge', async () => {
        // Upgrade to enterprise
        let result = await handleTierUpgrade(
          db,
          testCustomerId,
          'seal',
          'enterprise',
          suiService,
          clock
        );
        expect(result.success).toBe(true);
        expect(result.chargeAmountUsdCents).toBe(0);

        // Downgrade to starter
        result = await scheduleTierDowngrade(
          db,
          testCustomerId,
          'seal',
          'starter',
          clock
        ) as any;
        expect(result.success).toBe(true);

        // Upgrade back to pro
        result = await handleTierUpgrade(
          db,
          testCustomerId,
          'seal',
          'pro',
          suiService,
          clock
        );
        expect(result.success).toBe(true);
        expect(result.chargeAmountUsdCents).toBe(0);

        // Final state
        const service = await db.query.serviceInstances.findFirst({
          where: eq(serviceInstances.instanceId, testInstanceId),
        });
        expect(service?.tier).toBe('pro');
        expect(service?.paidOnce).toBe(false);
      });

      it('should preserve paidOnce = false through tier changes', async () => {
        // Change tier
        await handleTierUpgrade(
          db,
          testCustomerId,
          'seal',
          'enterprise',
          suiService,
          clock
        );

        // Verify paidOnce is still false
        const service = await db.query.serviceInstances.findFirst({
          where: eq(serviceInstances.instanceId, testInstanceId),
        });
        expect(service?.paidOnce).toBe(false);
      });
    });
  });
});
