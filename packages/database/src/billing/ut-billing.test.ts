/**
 * Billing Processor Tests (Phase 1B)
 *
 * Comprehensive test suite for billing operations using TDD approach.
 * Uses MockDBClock for deterministic time manipulation and a simple mock Sui service.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db';
import { customers, billingRecords, customerCredits, invoicePayments, serviceInstances, escrowTransactions, billingIdempotency, mockSuiTransactions } from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, TransactionResult, ChargeParams } from '@suiftly/shared/sui-service';
import {
  processBilling,
  processCustomerBilling,
  issueCredit,
  applyCreditsToInvoice,
  processInvoicePayment,
  startGracePeriod,
  isGracePeriodExpired,
  suspendCustomerForNonPayment,
  withIdempotency,
  generateMonthlyBillingKey,
} from './index';
import { unsafeAsLockedTransaction } from './test-helpers';
import type { BillingProcessorConfig } from './types';
import { eq, sql } from 'drizzle-orm';

/**
 * Simple mock Sui service for testing
 * Simulates successful charges by updating customer balance in database
 */
class TestMockSuiService implements ISuiService {
  private generateMockDigest(): string {
    // Generate a proper 32-byte hex digest (64 hex characters)
    const bytes = Buffer.alloc(32);
    // Fill with pseudo-random data
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
      return {
        digest: this.generateMockDigest(),
        success: false,
        error: 'Customer not found',
      };
    }

    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (currentBalance < params.amountUsdCents) {
      return {
        digest: this.generateMockDigest(),
        success: false,
        error: 'Insufficient balance',
      };
    }

    // Deduct from balance
    await db.update(customers)
      .set({ currentBalanceUsdCents: currentBalance - params.amountUsdCents })
      .where(eq(customers.customerId, customer.customerId));

    return {
      digest: this.generateMockDigest(),
      success: true,
      checkpoint: Date.now(),
    };
  }

  // Stub implementations for interface compliance
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

describe('Billing Processor (Phase 1B)', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();

  const config: BillingProcessorConfig = {
    clock,
    usageChargeThresholdCents: 500, // $5.00
    gracePeriodDays: 14,
    maxRetryAttempts: 3,
    retryIntervalHours: 24,
  };

  // Test customer setup
  const testWalletAddress = '0xTEST1234567890abcdefABCDEF1234567890abcdefABCDEF1234567890';
  let testCustomerId: number;

  beforeAll(async () => {
    // Truncate all billing-related tables before starting tests
    // This ensures a clean slate even if previous test run didn't clean up
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
    // Set initial time to Jan 1, 2025
    clock.setTime(new Date('2025-01-01T00:00:00Z'));

    // Create test customer with escrow account
    const [customer] = await db.insert(customers).values({
      customerId: 1000,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW1234',
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
    // Clean up test data in correct order (respecting foreign keys)
    await db.delete(billingIdempotency); // References billing_records
    await db.delete(invoicePayments); // References billing_records, credits, escrow_transactions
    await db.delete(billingRecords); // References customers
    await db.delete(customerCredits); // References customers
    await db.delete(serviceInstances); // References customers
    await db.delete(escrowTransactions); // References customers
    await db.delete(mockSuiTransactions); // References customers
    await db.delete(customers); // No dependencies
  });

  describe('Credit Application', () => {
    it('should apply credits in order of expiration (oldest first)', async () => {
      // Issue 3 credits with different expiration dates
      await db.transaction(async (tx) => {
        // Credit 1: Expires in 30 days (oldest expiring)
        await issueCredit(
          tx,
          testCustomerId,
          1000, // $10.00
          'promo',
          'Promo credit - expires soon',
          clock.addDays(30)
        );

        // Credit 2: Never expires
        await issueCredit(
          tx,
          testCustomerId,
          2000, // $20.00
          'goodwill',
          'Goodwill credit - no expiry',
          null
        );

        // Credit 3: Expires in 60 days
        await issueCredit(
          tx,
          testCustomerId,
          1500, // $15.00
          'promo',
          'Promo credit - expires later',
          clock.addDays(60)
        );
      });

      // Create an invoice for $25.00
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 2500,
        type: 'charge',
        status: 'pending',
        createdAt: clock.now(),
      }).returning();

      // Apply credits
      const result = await db.transaction(async (tx) => {
        return await applyCreditsToInvoice(
          unsafeAsLockedTransaction(tx),
          testCustomerId,
          invoice.id,
          2500,
          clock
        );
      });

      // Should apply in order: 30-day expiry ($10), 60-day expiry ($15)
      expect(result.totalAppliedCents).toBe(2500);
      expect(result.remainingInvoiceAmountCents).toBe(0);
      expect(result.creditsApplied).toHaveLength(2);

      // Verify credit 1 (30-day) was fully consumed
      expect(result.creditsApplied[0].amountUsedCents).toBe(1000);
      expect(result.creditsApplied[0].remainingCents).toBe(0);

      // Verify credit 3 (60-day) was fully consumed
      expect(result.creditsApplied[1].amountUsedCents).toBe(1500);
      expect(result.creditsApplied[1].remainingCents).toBe(0);

      // Credit 2 (never expires) should remain untouched ($20.00)
      const remainingCredits = await db.select().from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));

      const untouchedCredit = remainingCredits.find(c => c.reason === 'goodwill');
      expect(untouchedCredit).toBeDefined();
      expect(Number(untouchedCredit?.remainingAmountUsdCents)).toBe(2000);
    });

    it('should skip expired credits', async () => {
      await db.transaction(async (tx) => {
        // Credit already expired
        await issueCredit(
          tx,
          testCustomerId,
          3000,
          'promo',
          'Expired credit',
          clock.addDays(-1) // Expired yesterday
        );

        // Valid credit
        await issueCredit(
          tx,
          testCustomerId,
          2000,
          'goodwill',
          'Valid credit',
          clock.addDays(30)
        );
      });

      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 2500,
        type: 'charge',
        status: 'pending',
        createdAt: clock.now(),
      }).returning();

      const result = await db.transaction(async (tx) => {
        return await applyCreditsToInvoice(unsafeAsLockedTransaction(tx), testCustomerId, invoice.id, 2500, clock);
      });

      // Should only apply the valid credit ($20.00)
      expect(result.totalAppliedCents).toBe(2000);
      expect(result.remainingInvoiceAmountCents).toBe(500); // $5.00 remaining
      expect(result.creditsApplied).toHaveLength(1);
    });
  });

  describe('Multi-Source Payment', () => {
    it('should pay invoice with credits + escrow', async () => {
      // Issue $15.00 credit
      await db.transaction(async (tx) => {
        await issueCredit(tx, testCustomerId, 1500, 'goodwill', 'Partial payment');
      });

      // Create $50.00 invoice
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 5000,
        type: 'charge',
        status: 'pending',
        createdAt: clock.now(),
      }).returning();

      // Process payment (should use $15 credit + $35 escrow)
      const result = await db.transaction(async (tx) => {
        return await processInvoicePayment(unsafeAsLockedTransaction(tx), invoice.id, suiService, clock);
      });

      expect(result.fullyPaid).toBe(true);
      expect(result.amountPaidCents).toBe(5000);
      expect(result.paymentSources).toHaveLength(2);

      // Verify payment sources
      const creditPayment = result.paymentSources.find(p => p.type === 'credit');
      const escrowPayment = result.paymentSources.find(p => p.type === 'escrow');

      expect(creditPayment?.amountCents).toBe(1500);
      expect(escrowPayment?.amountCents).toBe(3500);

      // Verify invoice status
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });

      expect(updatedInvoice?.status).toBe('paid');
      expect(Number(updatedInvoice?.amountPaidUsdCents)).toBe(5000);
    });

    it('should keep credits applied even if escrow fails', async () => {
      // Issue $15.00 credit
      await db.transaction(async (tx) => {
        await issueCredit(tx, testCustomerId, 1500, 'goodwill', 'Partial payment');
      });

      // Set customer balance to $0 (escrow will fail)
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Create $50.00 invoice
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 5000,
        type: 'charge',
        status: 'pending',
        createdAt: clock.now(),
      }).returning();

      // Process payment
      const result = await db.transaction(async (tx) => {
        return await processInvoicePayment(unsafeAsLockedTransaction(tx), invoice.id, suiService, clock);
      });

      // Payment should fail (insufficient escrow)
      expect(result.fullyPaid).toBe(false);
      expect(result.amountPaidCents).toBe(1500); // Only credits applied
      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe('payment_failed');

      // Credits should stay applied (NOT rolled back)
      const payments = await db.select().from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, invoice.id));

      expect(payments).toHaveLength(1);
      expect(payments[0].sourceType).toBe('credit');
      expect(Number(payments[0].amountUsdCents)).toBe(1500);

      // Invoice should be marked as failed with partial payment
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });

      expect(updatedInvoice?.status).toBe('failed');
      expect(Number(updatedInvoice?.amountPaidUsdCents)).toBe(1500);
      expect(updatedInvoice?.failureReason).toContain('Insufficient');
    });
  });

  describe('Monthly Billing', () => {
    it('should process DRAFT → PENDING → PAID on 1st of month', async () => {
      // Create enabled service (so DRAFT validation passes)
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        config: { tier: 'pro' },
      });

      // Create a DRAFT invoice for Jan 2025
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 2900, // $29.00 (matches Pro tier)
        type: 'charge',
        status: 'draft',
        invoiceNumber: 'INV-2025-01-0001',
        createdAt: clock.now(),
      }).returning();

      // Set time to Jan 1, 2025 00:00 (1st of month)
      clock.setTime(new Date('2025-01-01T00:00:00Z'));

      // Run billing processor
      const results = await processBilling(db, config, suiService);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].operations.some(op => op.type === 'monthly_billing')).toBe(true);

      // Verify invoice was paid
      const paidInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });

      expect(paidInvoice?.status).toBe('paid');
      expect(Number(paidInvoice?.amountPaidUsdCents)).toBe(2900);

      // Verify paid_once flag set
      const updatedCustomer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      expect(updatedCustomer?.paidOnce).toBe(true);
    });

    it('should enforce idempotency (prevent double-billing)', async () => {
      // Create DRAFT invoice
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 2900,
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      // Set time to Jan 1
      clock.setTime(new Date('2025-01-01T00:00:00Z'));

      // Run billing processor first time
      await processBilling(db, config, suiService);

      // Check balance after first billing
      const balanceAfterFirst = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      const firstBalance = balanceAfterFirst?.currentBalanceUsdCents ?? 0;

      // Run billing processor again (should be idempotent)
      await processBilling(db, config, suiService);

      // Balance should not change (no double-charge)
      const balanceAfterSecond = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      expect(Number(balanceAfterSecond?.currentBalanceUsdCents)).toBe(Number(firstBalance));
    });
  });

  describe('Grace Period (14-day)', () => {
    it('should start grace period when payment fails (only if paid_once=true)', async () => {
      // Create enabled service (so DRAFT validation passes)
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        config: { tier: 'pro' },
      });

      // Set customer as having paid before
      await db.update(customers)
        .set({ paidOnce: true, currentBalanceUsdCents: 0 }) // No balance = payment will fail
        .where(eq(customers.customerId, testCustomerId));

      // Create DRAFT invoice
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 2900, // Matches Pro tier
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      // Run billing (will fail due to zero balance)
      clock.setTime(new Date('2025-01-01T00:00:00Z'));
      const results = await processBilling(db, config, suiService);

      // Verify grace period started
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      expect(customer?.gracePeriodStart).toBe('2025-01-01');
      expect(results[0].operations.some(op => op.type === 'grace_period_start')).toBe(true);
    });

    it('should NOT start grace period if customer never paid before', async () => {
      // Set customer as never having paid
      await db.update(customers)
        .set({ paidOnce: false, currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Create DRAFT invoice
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 2900,
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      // Run billing
      clock.setTime(new Date('2025-01-01T00:00:00Z'));
      await processBilling(db, config, suiService);

      // Verify NO grace period
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      expect(customer?.gracePeriodStart).toBeNull();
    });

    it('should suspend account after 14-day grace period', async () => {
      // Start grace period on Jan 1
      await db.update(customers)
        .set({
          paidOnce: true,
          gracePeriodStart: '2025-01-01',
          status: 'active',
        })
        .where(eq(customers.customerId, testCustomerId));

      // Create a service to test suspension
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
      });

      // Advance time to Jan 16 (15 days later = grace period expired)
      clock.setTime(new Date('2025-01-16T00:00:00Z'));

      // Run billing processor
      const results = await processBilling(db, config, suiService);

      // Verify account suspended
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      expect(customer?.status).toBe('suspended');

      // Verify services disabled
      const service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.customerId, testCustomerId),
      });

      expect(service?.isUserEnabled).toBe(false);

      // Verify operation logged
      expect(results[0].operations.some(op => op.type === 'grace_period_end')).toBe(true);
    });
  });

  describe('Payment Retry', () => {
    it('should retry failed payments after interval', async () => {
      // Create failed invoice
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 2900,
        type: 'charge',
        status: 'failed',
        retryCount: 0,
        lastRetryAt: clock.now(),
        createdAt: clock.now(),
      }).returning();

      // Advance time by 25 hours (past retry interval)
      clock.advance(25 * 60 * 60 * 1000);

      // Run billing processor (should retry)
      const results = await processBilling(db, config, suiService);

      expect(results[0].operations.some(op => op.type === 'payment_retry')).toBe(true);

      // Verify invoice paid
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });

      expect(updatedInvoice?.status).toBe('paid');
    });

    it('should stop retrying after max attempts', async () => {
      // Create failed invoice with max retries
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 2900,
        type: 'charge',
        status: 'failed',
        retryCount: 3, // Max retries reached
        lastRetryAt: clock.now(),
        createdAt: clock.now(),
      });

      // Set balance to 0 (payment will fail)
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Advance time
      clock.advance(25 * 60 * 60 * 1000);

      // Run billing processor
      const results = await processBilling(db, config, suiService);

      // Should NOT attempt retry
      expect(results[0].operations.some(op => op.type === 'payment_retry')).toBe(false);
    });
  });
});
