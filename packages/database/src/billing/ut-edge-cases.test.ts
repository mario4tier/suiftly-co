/**
 * Edge Case Tests - Coverage Gaps Identified by Code Review
 *
 * Tests for critical edge cases that weren't covered:
 * 1. Idempotency cleanup actually deletes old records
 * 2. Grace period boundary (3 days vs 2 days)
 * 3. Leap year handling in date calculations
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingIdempotency,
  billingRecords,
  serviceInstances,
  customerCredits,
  invoicePayments,
  escrowTransactions,
  adminNotifications,
  mockSuiTransactions,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { cleanupIdempotencyRecords } from './idempotency';
import { calculateProRatedUpgradeCharge, handleSubscriptionBilling } from './service-billing';
import { eq, sql } from 'drizzle-orm';
import type { ISuiService, TransactionResult, ChargeParams } from '@suiftly/shared/sui-service';

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

describe('Billing Edge Cases', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const testWalletAddress = '0xEDGE5000567890abcdefABCDEF1234567890abcdefABCDEF1234567890abc';
  let testCustomerId: number;

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE admin_notifications CASCADE`);
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
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

    const [customer] = await db.insert(customers).values({
      customerId: 5000,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW5000',
      status: 'active',
      currentBalanceUsdCents: 10000,
      spendingLimitUsdCents: 25000,
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-01-01',
      paidOnce: false,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    }).returning();

    testCustomerId = customer.customerId;
  });

  afterEach(async () => {
    await db.delete(adminNotifications);
    await db.delete(billingIdempotency);
    await db.delete(invoicePayments);
    await db.delete(billingRecords);
    await db.delete(customerCredits);
    await db.delete(serviceInstances);
    await db.delete(escrowTransactions);
    await db.delete(mockSuiTransactions);
    await db.delete(customers);
  });

  describe('Idempotency Cleanup', () => {
    it('should delete records older than cutoff and preserve recent ones', async () => {
      // Clean any existing records first
      await db.delete(billingIdempotency);

      // Create idempotency records at different ages
      const now = clock.now();

      await db.transaction(async (tx) => {
        // Old record (25 hours old)
        await tx.insert(billingIdempotency).values({
          idempotencyKey: 'old-key-25h',
          response: '{"old":true}',
          createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
        });

        // Medium record (23 hours old - within 24h)
        await tx.insert(billingIdempotency).values({
          idempotencyKey: 'recent-key-23h',
          response: '{"recent":true}',
          createdAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
        });

        // Fresh record (1 hour old)
        await tx.insert(billingIdempotency).values({
          idempotencyKey: 'fresh-key-1h',
          response: '{"fresh":true}',
          createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
        });
      });

      // Clean up records older than 24 hours (using mock clock time)
      const deletedCount = await db.transaction(async (tx) => {
        return await cleanupIdempotencyRecords(tx, clock, 24);
      });

      // Verify only the old record was deleted
      expect(deletedCount).toBe(1);

      const remaining = await db.select().from(billingIdempotency);
      expect(remaining).toHaveLength(2);
      expect(remaining.some(r => r.idempotencyKey === 'old-key-25h')).toBe(false);
      expect(remaining.some(r => r.idempotencyKey === 'recent-key-23h')).toBe(true);
      expect(remaining.some(r => r.idempotencyKey === 'fresh-key-1h')).toBe(true);
    });
  });

  describe('Pro-Rated Charge Boundary (Grace Period)', () => {
    it('should charge $0 for exactly 2 days remaining (grace period)', () => {
      // Jan 30 upgrade (2 days remaining: Jan 30, 31)
      clock.setTime(new Date('2025-01-30T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(900, 2900, clock);

      expect(charge).toBe(0); // Grace period applies
    });

    it('should charge pro-rated amount for exactly 3 days remaining (NOT grace period)', () => {
      // Jan 29 upgrade (3 days remaining: Jan 29, 30, 31)
      clock.setTime(new Date('2025-01-29T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(900, 2900, clock);

      // $20 price difference × (3 days / 31 days in January)
      const expected = Math.floor((2000 * 3) / 31);
      expect(charge).toBe(expected);
      expect(charge).toBeGreaterThan(0); // NOT grace period
    });

    it('should charge $0 for exactly 1 day remaining (grace period)', () => {
      // Jan 31 upgrade (1 day remaining)
      clock.setTime(new Date('2025-01-31T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(900, 2900, clock);

      expect(charge).toBe(0); // Grace period applies
    });
  });

  describe('Leap Year Handling', () => {
    it('should calculate correct days for February in leap year (29 days)', async () => {
      // Subscribe on Feb 15, 2024 (leap year)
      clock.setTime(new Date('2024-02-15T00:00:00Z'));

      await db.update(customers)
        .set({ currentPeriodStart: '2024-02-01' })
        .where(eq(customers.customerId, testCustomerId));

      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900,
        suiService,
        clock
      );

      // Verify reconciliation credit
      // Feb 15-29 = 15 days used
      // Feb 1-14 = 14 days NOT used
      // Credit: $29 × (14 / 29)
      const credits = await db.select().from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));

      expect(credits).toHaveLength(1);
      const expectedCredit = Math.floor((2900 * 14) / 29);
      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCredit);
    });

    it('should calculate correct days for February in non-leap year (28 days)', async () => {
      // Subscribe on Feb 15, 2025 (non-leap year)
      clock.setTime(new Date('2025-02-15T00:00:00Z'));

      await db.update(customers)
        .set({ currentPeriodStart: '2025-02-01' })
        .where(eq(customers.customerId, testCustomerId));

      await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'starter',
        900,
        suiService,
        clock
      );

      // Feb 15-28 = 14 days used
      // Feb 1-14 = 14 days NOT used
      // Credit: $9 × (14 / 28) = $4.50
      const credits = await db.select().from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));

      expect(credits).toHaveLength(1);
      const expectedCredit = Math.floor((900 * 14) / 28);
      expect(Number(credits[0].originalAmountUsdCents)).toBe(expectedCredit);
    });

    it('should handle pro-rating correctly in leap year February', () => {
      // Upgrade on Feb 15, 2024 (29-day February)
      clock.setTime(new Date('2024-02-15T00:00:00Z'));

      const charge = calculateProRatedUpgradeCharge(900, 2900, clock);

      // $20 difference × (15 days remaining / 29 days)
      const expected = Math.floor((2000 * 15) / 29);
      expect(charge).toBe(expected);
    });
  });
});
