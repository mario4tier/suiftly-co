/**
 * Service Billing Integration Tests (Phase 2)
 *
 * Tests the integration between service lifecycle and billing engine.
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
  mockSuiTransactions,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, TransactionResult, ChargeParams } from '@suiftly/shared/sui-service';
import {
  handleSubscriptionBilling,
  recalculateDraftInvoice,
  calculateProRatedUpgradeCharge,
} from './service-billing';
import { getOrCreateDraftInvoice } from './invoices';
import { unsafeAsLockedTransaction } from './test-helpers';
import { eq, and, sql } from 'drizzle-orm';

// Simple mock Sui service for testing
class TestMockSuiService implements ISuiService {
  private generateMockDigest(): string {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return '0x' + bytes.toString('hex');
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
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

  // Stub implementations
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

describe('Service Billing Integration (Phase 2)', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();

  const testWalletAddress = '0xSVC2000567890abcdefABCDEF1234567890abcdefABCDEF1234567890abc';
  let testCustomerId: number;

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE billing_idempotency CASCADE`);
    await db.execute(sql`TRUNCATE TABLE invoice_payments CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_records CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customer_credits CASCADE`);
    await db.execute(sql`TRUNCATE TABLE service_instances CASCADE`);
    await db.execute(sql`TRUNCATE TABLE escrow_transactions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE mock_sui_transactions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers CASCADE`);
  });

  beforeEach(async () => {
    // Set time to Jan 15, 2025 (mid-month)
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

    // Create test customer with balance
    const [customer] = await db.insert(customers).values({
      customerId: 2000,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW2000',
      status: 'active',
      currentBalanceUsdCents: 10000, // $100.00
      spendingLimitUsdCents: 25000, // $250.00
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-01-01',
      paidOnce: false,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;
  });

  afterEach(async () => {
    await db.delete(billingIdempotency);
    await db.delete(invoicePayments);
    await db.delete(billingRecords);
    await db.delete(customerCredits);
    await db.delete(serviceInstances);
    await db.delete(escrowTransactions);
    await db.delete(mockSuiTransactions);
    await db.delete(customers);
  });

  describe('Subscription Billing (Prepay + Reconcile)', () => {
    it('should charge full month on first subscription', async () => {
      // Subscribe on Jan 15 (mid-month)
      const result = await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900, // $29.00
        suiService,
        clock
      );

      expect(result.paymentSuccessful).toBe(true);
      expect(result.subscriptionChargePending).toBe(false);
      expect(result.amountUsdCents).toBe(2900);

      // Verify invoice created and paid
      const invoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, result.invoiceId),
      });

      expect(invoice?.status).toBe('paid');
      expect(Number(invoice?.amountPaidUsdCents)).toBe(2900);
    });

    it('should issue reconciliation credit for partial month', async () => {
      // Subscribe on Jan 15 (17 days remaining in January)
      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900, // $29.00
        suiService,
        clock
      );

      // Verify reconciliation credit created
      const credits = await db.select().from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));

      expect(credits).toHaveLength(1);
      expect(credits[0].reason).toBe('reconciliation');
      expect(credits[0].expiresAt).toBeNull(); // Never expires

      // Calculate expected credit: $29 × (14 days not used / 31 days in January)
      // Subscribed Jan 15: used 17 days (Jan 15-31), NOT used 14 days (Jan 1-14)
      const expectedCredit = Math.floor((2900 * 14) / 31);
      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCredit);
    });

    it('should create DRAFT invoice for next billing cycle', async () => {
      // Create and enable service (simulates successful subscription)
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true, // Service is enabled
        subscriptionChargePending: false,
        config: { tier: 'pro' },
      });

      // Handle billing (creates/updates DRAFT)
      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900,
        suiService,
        clock
      );

      // Verify DRAFT invoice exists for next month with correct amount
      const drafts = await db.select().from(billingRecords)
        .where(and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ));

      expect(drafts).toHaveLength(1);
      expect(Number(drafts[0].amountUsdCents)).toBe(2900); // Full month rate
    });
  });

  describe('Pro-Rated Tier Upgrades', () => {
    it('should calculate pro-rated charge for mid-month upgrade', () => {
      // Upgrade from Starter ($9) to Pro ($29) on Jan 15
      // 17 days remaining in 31-day month
      clock.setTime(new Date('2025-01-15T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(
        900, // Starter: $9.00
        2900, // Pro: $29.00
        clock
      );

      // Expected: ($29 - $9) × (17 / 31) = $20 × 0.548 = $10.97
      const expected = Math.floor((2000 * 17) / 31);
      expect(charge).toBe(expected);
      expect(charge).toBe(1096); // $10.96
    });

    it('should charge $0 if 2 or fewer days remaining (grace period)', () => {
      // Upgrade on Jan 30 (2 days remaining)
      clock.setTime(new Date('2025-01-30T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(900, 2900, clock);

      expect(charge).toBe(0); // Grace period
    });

    it('should handle end-of-month upgrade (1 day remaining)', () => {
      // Upgrade on Jan 31 (last day)
      clock.setTime(new Date('2025-01-31T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(900, 2900, clock);

      expect(charge).toBe(0); // Grace period
    });
  });

  describe('DRAFT Invoice Management', () => {
    it('should recalculate DRAFT when service configuration changes', async () => {
      // Create service
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        config: {
          tier: 'pro',
          purchasedSealKeys: 2, // 2 extra keys @ $5 each
          purchasedPackages: 5, // 5 extra packages @ $2 each
          purchasedApiKeys: 0,
        },
      });

      // Recalculate DRAFT
      await db.transaction(async (tx) => {
        await recalculateDraftInvoice(unsafeAsLockedTransaction(tx), testCustomerId, clock);
      });

      // Verify DRAFT amount includes tier + add-ons
      const draft = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      // Expected: Pro tier ($29) + 2 keys ($10) + 5 packages ($10) = $49
      expect(Number(draft?.amountUsdCents)).toBe(4900);
    });

    it('should NOT change DRAFT when service is toggled off (subscription still active)', async () => {
      // Create subscribed service (enabled)
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true, // Service is ON
        config: { tier: 'pro' },
      });

      // Calculate initial DRAFT
      await db.transaction(async (tx) => {
        await recalculateDraftInvoice(unsafeAsLockedTransaction(tx), testCustomerId, clock);
      });

      const draftWithServiceOn = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      expect(Number(draftWithServiceOn?.amountUsdCents)).toBe(2900); // $29 for Pro

      // Toggle service OFF (user temporarily disables it)
      await db.update(serviceInstances)
        .set({ isUserEnabled: false })
        .where(eq(serviceInstances.customerId, testCustomerId));

      // Recalculate DRAFT (simulate "something changed")
      await db.transaction(async (tx) => {
        await recalculateDraftInvoice(unsafeAsLockedTransaction(tx), testCustomerId, clock);
      });

      const draftAfterToggleOff = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      // CRITICAL: Amount should NOT change
      // Toggling service off/on does NOT cancel subscription
      // Customer is still billed for subscribed services
      expect(Number(draftAfterToggleOff?.amountUsdCents)).toBe(2900); // Still $29
      expect(draftAfterToggleOff?.id).toBe(draftWithServiceOn?.id); // Same DRAFT, just updated

      // Toggle service back ON
      await db.update(serviceInstances)
        .set({ isUserEnabled: true })
        .where(eq(serviceInstances.customerId, testCustomerId));

      // Recalculate again
      await db.transaction(async (tx) => {
        await recalculateDraftInvoice(unsafeAsLockedTransaction(tx), testCustomerId, clock);
      });

      const draftAfterToggleOn = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      // Amount should STILL be the same
      expect(Number(draftAfterToggleOn?.amountUsdCents)).toBe(2900); // Still $29
    });
  });
});
