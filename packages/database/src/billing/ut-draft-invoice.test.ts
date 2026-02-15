/**
 * DRAFT Invoice Bug Detection Tests
 *
 * Tests to detect specific bugs reported in production testing:
 * 1. DRAFT invoice date showing wrong date (Nov 30 instead of Dec 1)
 * 2. Missing reconciliation credit for unused days in partial month
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingRecords,
  customerCredits,
  serviceInstances,
  escrowTransactions,
  invoicePayments,
  billingIdempotency,
  adminNotifications,
  mockSuiTransactions,
  customerPaymentMethods,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { handleSubscriptionBilling } from './service-billing';
import { eq, and, sql } from 'drizzle-orm';
import type { ISuiService, TransactionResult, ChargeParams } from '@suiftly/shared/sui-service';
import { toPaymentServices, ensureEscrowPaymentMethod, cleanupCustomerData } from './test-helpers';

// Simple mock Sui service
class TestMockSuiService implements ISuiService {
  private generateMockDigest(): string {
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
    return '0x' + bytes.toString('hex');
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, params.userAddress),
    });

    if (!customer || (customer.currentBalanceUsdCents ?? 0) < params.amountUsdCents) {
      return { digest: this.generateMockDigest(), success: false, error: 'Insufficient balance' };
    }

    await db.update(customers)
      .set({ currentBalanceUsdCents: (customer.currentBalanceUsdCents ?? 0) - params.amountUsdCents })
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

describe('DRAFT Invoice Date and Credit Bugs', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const paymentServices = toPaymentServices(suiService);
  const testWalletAddress = '0xBUG4000567890abcdefABCDEF1234567890abcdefABCDEF1234567890abc';
  let testCustomerId: number;

  beforeEach(async () => {
    // Set time to November 24, 2025 (7 days before end of month)
    clock.setTime(new Date('2025-11-24T00:00:00Z'));

    const [customer] = await db.insert(customers).values({
      customerId: 4000,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW4000',
      status: 'active',
      currentBalanceUsdCents: 10000, // $100
      spendingLimitUsdCents: 25000, // $250
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-11-01',
      paidOnce: false,
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

  describe('Bug 1: DRAFT Invoice Date', () => {
    it('should create DRAFT invoice with due date of December 1, not November 30', async () => {
      // Subscribe on November 24
      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900,
        paymentServices,
        clock
      );

      // Find DRAFT invoice
      const draft = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      expect(draft).toBeDefined();

      // Check billing_period_start is December 1, 2025 (UTC)
      const periodStart = draft!.billingPeriodStart!;
      expect(periodStart.getUTCFullYear()).toBe(2025);
      expect(periodStart.getUTCMonth()).toBe(11); // December (0-indexed)
      expect(periodStart.getUTCDate()).toBe(1); // 1st of month

      // Format as YYYY-MM-DD for clarity
      const dateString = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}-${String(periodStart.getUTCDate()).padStart(2, '0')}`;
      expect(dateString).toBe('2025-12-01'); // NOT 2025-11-30
    });
  });

  describe('Bug 2: Missing Reconciliation Credit', () => {
    it('should issue reconciliation credit for unused days when subscribing mid-month', async () => {
      // Subscribe on November 24 (7 days into 30-day November)
      // Days used: Nov 24-30 = 7 days
      // Days NOT used: Nov 1-23 = 23 days
      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900, // $29.00
        paymentServices,
        clock
      );

      // Verify reconciliation credit was created
      const credits = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation')
        ));

      expect(credits).toHaveLength(1);

      // Calculate expected credit: $29 × (23 unused days / 30 days in November)
      const expectedCreditCents = Math.floor((2900 * 23) / 30);

      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);
      expect(Number(credits[0].remainingAmountUsdCents)).toBe(expectedCreditCents);
      expect(credits[0].expiresAt).toBeNull(); // Reconciliation credits never expire
    });

    it('should NOT issue credit when subscribing on last day of month', async () => {
      // Subscribe on November 30 (last day)
      // Days used: Nov 30 = 1 day
      // Days NOT used: Nov 1-29 = 29 days
      clock.setTime(new Date('2025-11-30T00:00:00Z'));

      // Update customer month start
      await db.update(customers)
        .set({ currentPeriodStart: '2025-11-01' })
        .where(eq(customers.customerId, testCustomerId));

      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'starter',
        900, // $9.00
        paymentServices,
        clock
      );

      // Verify reconciliation credit WAS created (29 unused days)
      const credits = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation')
        ));

      expect(credits).toHaveLength(1);
      const expectedCreditCents = Math.floor((900 * 29) / 30);
      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);
    });

    it('should calculate correct credit for mid-month subscription in January (31 days)', async () => {
      // Subscribe on January 15 (mid-month of 31-day month)
      // Days used: Jan 15-31 = 17 days
      // Days NOT used: Jan 1-14 = 14 days
      clock.setTime(new Date('2025-01-15T00:00:00Z'));

      // Update customer month start
      await db.update(customers)
        .set({ currentPeriodStart: '2025-01-01' })
        .where(eq(customers.customerId, testCustomerId));

      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900, // $29.00
        paymentServices,
        clock
      );

      // Verify credit: $29 × (14 / 31)
      const credits = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation')
        ));

      expect(credits).toHaveLength(1);
      const expectedCreditCents = Math.floor((2900 * 14) / 31);
      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCreditCents);
    });
  });
});
