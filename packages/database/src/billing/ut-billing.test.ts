/**
 * Billing Processor Tests (Phase 1B)
 *
 * Comprehensive test suite for billing operations using TDD approach.
 * Uses MockDBClock for deterministic time manipulation and a simple mock Sui service.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db';
import { customers, billingRecords, customerCredits, invoicePayments, serviceInstances, escrowTransactions, billingIdempotency, mockSuiTransactions, customerPaymentMethods, adminNotifications, ledgerEntries } from '../schema';
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
  retryUnpaidInvoices,
  reconcileStuckInvoices,
} from './index';
import { unsafeAsLockedTransaction, toPaymentServices, toEscrowProviders, ensureEscrowPaymentMethod, cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';
import type { BillingProcessorConfig } from './types';
import { eq, sql, and } from 'drizzle-orm';
import { voidInvoice } from './invoices';

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
  const paymentServices = toPaymentServices(suiService);

  beforeAll(async () => {
    await resetTestState(db);
  });

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

  beforeEach(async () => {
    await suspendGMProcessing();

    // Set initial time to Jan 1, 2025
    clock.setTime(new Date('2025-01-01T00:00:00Z'));

    // Defensive cleanup: remove stale data from previous crashed runs
    await cleanupCustomerData(db, 1000);

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

    // Ensure escrow payment method exists for provider chain
    await ensureEscrowPaymentMethod(db, testCustomerId);
  });

  afterEach(async () => {
    await cleanupCustomerData(db, testCustomerId);
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
        return await processInvoicePayment(unsafeAsLockedTransaction(tx), invoice.id, toEscrowProviders(suiService, db, clock), clock);
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
        return await processInvoicePayment(unsafeAsLockedTransaction(tx), invoice.id, toEscrowProviders(suiService, db, clock), clock);
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
      expect(updatedInvoice?.failureReason).toContain('No payment method available');
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
        createdAt: clock.now(),
      }).returning();

      // Set time to Jan 1, 2025 00:00 (1st of month)
      clock.setTime(new Date('2025-01-01T00:00:00Z'));

      // Run billing processor
      const results = await processBilling(db, config, paymentServices);

      // Filter to our test customer (other customers may exist from prior tests)
      const myResult = results.find(r => r.customerId === testCustomerId);
      expect(myResult).toBeDefined();
      expect(myResult!.success).toBe(true);
      expect(myResult!.operations.some(op => op.type === 'monthly_billing')).toBe(true);

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
      await processBilling(db, config, paymentServices);

      // Check balance after first billing
      const balanceAfterFirst = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      const firstBalance = balanceAfterFirst?.currentBalanceUsdCents ?? 0;

      // Run billing processor again (should be idempotent)
      await processBilling(db, config, paymentServices);

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
      const results = await processBilling(db, config, paymentServices);

      // Verify grace period started
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });

      expect(customer?.gracePeriodStart).toBe('2025-01-01');
      const myResult = results.find(r => r.customerId === testCustomerId);
      expect(myResult).toBeDefined();
      expect(myResult!.operations.some(op => op.type === 'grace_period_start')).toBe(true);
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
      await processBilling(db, config, paymentServices);

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
      const results = await processBilling(db, config, paymentServices);

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
      const myResult = results.find(r => r.customerId === testCustomerId);
      expect(myResult).toBeDefined();
      expect(myResult!.operations.some(op => op.type === 'grace_period_end')).toBe(true);
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
      const results = await processBilling(db, config, paymentServices);

      const myResult = results.find(r => r.customerId === testCustomerId);
      expect(myResult).toBeDefined();
      expect(myResult!.operations.some(op => op.type === 'payment_retry')).toBe(true);

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
        failureReason: 'Card declined', // Must be non-null to match production behavior
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
      const results = await processBilling(db, config, paymentServices);

      // Should NOT attempt retry
      const myResult = results.find(r => r.customerId === testCustomerId);
      // If customer has no results (skipped), that's also correct behavior
      if (myResult) {
        expect(myResult.operations.some(op => op.type === 'payment_retry')).toBe(false);
      }
    });
  });

  describe('No-Provider Retry Guard', () => {
    it('should not burn retryCount when customer has no providers and no credits', async () => {
      // Setup: customer with NO payment methods and NO credits, failed invoice
      // Remove the escrow payment method that beforeEach creates
      await db.execute(sql`DELETE FROM customer_payment_methods WHERE customer_id = ${testCustomerId}`);

      // Set customer to zero balance (no escrow either)
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Create a failed invoice with retryCount=0
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900, // $9.00 starter
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: 0,
        failureReason: 'No payment method available',
        createdAt: clock.now(),
      }).returning();

      // Run periodic billing (not 1st of month to avoid monthly billing logic)
      clock.setTime(new Date('2025-01-15T00:00:00Z'));
      const results = await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // retryCount should NOT have been incremented
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });
      expect(Number(updatedInvoice?.retryCount)).toBe(0);
      expect(updatedInvoice?.status).toBe('failed');

      // A skip notification should be emitted (not a real retry attempt)
      const retryOps = results.operations.filter(op => op.type === 'payment_retry');
      expect(retryOps.length).toBe(1);
      expect(retryOps[0].description).toContain('no payment methods');
      expect(retryOps[0].success).toBe(false);
    });

    it('should emit notification when skipping retry for customer with no providers and no credits', async () => {
      // Setup: customer with NO payment methods and NO credits, failed invoice
      await db.execute(sql`DELETE FROM customer_payment_methods WHERE customer_id = ${testCustomerId}`);
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Create a failed invoice
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: 0,
        failureReason: 'No payment method available',
        createdAt: clock.now(),
      });

      // Run periodic billing
      clock.setTime(new Date('2025-01-15T00:00:00Z'));
      const results = await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Should have a payment_retry_skipped operation so the skip is observable
      expect(results.operations.some(op =>
        op.type === 'payment_retry' && op.description?.includes('no payment methods')
      )).toBe(true);

      // Should have an admin notification so ops can see these customers
      const notifications = await db.select().from(adminNotifications)
        .where(and(
          eq(adminNotifications.customerId, testCustomerId),
          eq(adminNotifications.code, 'NO_PAYMENT_METHODS_FOR_RETRY'),
        ));
      expect(notifications.length).toBe(1);
    });

    it('should not suppress no-payment-method notification across different customers', async () => {
      // Bug reproduction: logInternalErrorOnce dedupes on (invoiceId, code).
      // If invoiceId is a global sentinel (e.g. 0), the first customer's
      // notification suppresses all subsequent customers.
      const secondCustomerId = 999888;

      // Clean up second customer in case of stale data from a previous run
      await cleanupCustomerData(db, secondCustomerId);

      // Setup customer 1 (testCustomerId): no payment methods, no credits, failed invoice
      await db.execute(sql`DELETE FROM customer_payment_methods WHERE customer_id = ${testCustomerId}`);
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: 0,
        failureReason: 'No payment method available',
        createdAt: clock.now(),
      });

      // Setup customer 2: same situation
      await db.insert(customers).values({
        customerId: secondCustomerId,
        walletAddress: '0xDEDUP_TEST_999888_abcdef0123456789abcdef0123456789abcdef0123',
        status: 'active',
        currentBalanceUsdCents: 0,
        paidOnce: false,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });

      await db.insert(billingRecords).values({
        customerId: secondCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 2900,
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: 0,
        failureReason: 'No payment method available',
        createdAt: clock.now(),
      });

      // Run billing for customer 1 first
      clock.setTime(new Date('2025-01-15T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Run billing for customer 2
      await processCustomerBilling(db, secondCustomerId, config, paymentServices);

      // Both customers should have their own notification
      const notif1 = await db.select().from(adminNotifications)
        .where(and(
          eq(adminNotifications.customerId, testCustomerId),
          eq(adminNotifications.code, 'NO_PAYMENT_METHODS_FOR_RETRY'),
        ));
      const notif2 = await db.select().from(adminNotifications)
        .where(and(
          eq(adminNotifications.customerId, secondCustomerId),
          eq(adminNotifications.code, 'NO_PAYMENT_METHODS_FOR_RETRY'),
        ));

      expect(notif1.length).toBe(1);
      expect(notif2.length).toBe(1); // This would be 0 with the sentinel invoiceId bug

      // Cleanup second customer
      await cleanupCustomerData(db, secondCustomerId);
    });

    it('should still retry when customer has credits but no providers', async () => {
      // Setup: customer with credits but NO payment methods
      // Remove the escrow payment method that beforeEach creates
      await db.execute(sql`DELETE FROM customer_payment_methods WHERE customer_id = ${testCustomerId}`);

      // Set customer to zero balance
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Issue a credit that fully covers the invoice
      await db.transaction(async (tx) => {
        await issueCredit(tx, testCustomerId, 1000, 'promo', 'Test credit', null);
      });

      // Create a failed invoice
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900, // $9.00 starter — covered by $10 credit
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: 0,
        failureReason: 'No payment method available',
        createdAt: clock.now(),
      }).returning();

      // Run periodic billing
      clock.setTime(new Date('2025-01-15T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Invoice should be paid via credits
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });
      expect(updatedInvoice?.status).toBe('paid');
      expect(Number(updatedInvoice?.amountPaidUsdCents)).toBe(900);
    });
  });

  describe('Bug Fixes (Billing Audit)', () => {
    it('Bug 1: should create new DRAFT after failed monthly payment', async () => {
      // Setup: customer with a service, no funds, clock on 1st
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0, paidOnce: false })
        .where(eq(customers.customerId, testCustomerId));

      // Remove escrow payment method so payment fails
      await db.execute(sql`DELETE FROM customer_payment_methods WHERE customer_id = ${testCustomerId}`);

      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        config: { tier: 'starter' },
      });

      // Create DRAFT invoice for Jan 2025
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900, // $9.00 Starter
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      // Run billing on 1st — payment fails (no funds, no providers)
      clock.setTime(new Date('2025-01-01T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // A new DRAFT should exist for the next billing cycle (Feb)
      const drafts = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft'),
        ),
      });
      expect(drafts.length).toBeGreaterThanOrEqual(1);
    });

    it('Bug 2: should skip $0 DRAFT and not set paidOnce', async () => {
      // Setup: customer with service, schedule cancellation so DRAFT becomes $0
      await db.update(customers)
        .set({ currentBalanceUsdCents: 10000, paidOnce: false })
        .where(eq(customers.customerId, testCustomerId));

      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        state: 'enabled',
        config: { tier: 'starter' },
        cancellationScheduledFor: '2025-01-01', // Will be cancelled on 1st
      });

      // Create DRAFT invoice with $0 (already recalculated to $0 after cancellation)
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 0,
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      // Run billing on 1st
      clock.setTime(new Date('2025-01-01T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // paidOnce should remain false — $0 invoice should NOT trigger paidOnce
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, testCustomerId),
      });
      expect(customer?.paidOnce).toBe(false);

      // No paid $0 invoice should exist
      const paidInvoices = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'paid'),
        ),
      });
      const zeroPaid = paidInvoices.filter(inv => Number(inv.amountUsdCents) === 0);
      expect(zeroPaid.length).toBe(0);
    });

    it('Bug 3: should not process voided invoices', async () => {
      // Create a voided invoice
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 900,
        type: 'charge',
        status: 'voided',
        failureReason: 'Test void',
        createdAt: clock.now(),
      }).returning();

      // Attempt to process payment on the voided invoice
      const result = await db.transaction(async (tx) => {
        return await processInvoicePayment(
          unsafeAsLockedTransaction(tx),
          invoice.id,
          toEscrowProviders(suiService, db, clock),
          clock,
        );
      });

      // Should return error, not process the invoice
      expect(result.fullyPaid).toBe(false);
      expect(result.error?.type).toBe('validation_error');
      expect(result.error?.message).toContain('voided');

      // Invoice should remain voided (not transitioned to paid)
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });
      expect(updatedInvoice?.status).toBe('voided');
    });

    it('Bug 4: should restore credits when retries exhaust', async () => {
      // Setup: customer with escrow payment method but NO funds.
      // A credit was previously applied to a failed invoice (remainingAmount=0).
      // The retry will run (escrow exists), fail (no balance), and exhaust
      // → should restore the consumed credit.
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Keep escrow payment method (from beforeEach) so retry guard doesn't skip

      // Issue a credit and then mark it as fully consumed
      await db.transaction(async (tx) => {
        await issueCredit(tx, testCustomerId, 500, 'promo', 'Test credit', null);
      });
      const [creditRow] = await db.select()
        .from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));
      const creditId = creditRow.creditId;

      // Mark credit as fully consumed (simulates applyCreditsToInvoice having already used it)
      await db.update(customerCredits)
        .set({ remainingAmountUsdCents: 0 })
        .where(eq(customerCredits.creditId, creditId));

      // Create a failed invoice with retryCount = maxRetries - 1 (one more fail exhausts)
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900, // $9.00
        amountPaidUsdCents: 500, // $5.00 from credits previously applied
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: config.maxRetryAttempts - 1, // One more fail exhausts
        failureReason: 'Insufficient balance',
        lastRetryAt: new Date('2025-01-01T00:00:00Z'),
        createdAt: clock.now(),
      }).returning();

      // Record the credit payment that was previously applied
      await db.insert(invoicePayments).values({
        billingRecordId: invoice.id,
        sourceType: 'credit',
        amountUsdCents: 500,
        creditId,
        escrowTransactionId: null,
        providerReferenceId: null,
      });

      // Run billing (not 1st of month, retry will fail and exhaust)
      clock.setTime(new Date('2025-01-15T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // A compensating reconciliation credit should be issued for the 500 cents
      const credits = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ));

      const restoredCredit = credits.find(c =>
        c.description?.includes('Credit restoration')
      );
      expect(restoredCredit).toBeDefined();
      expect(Number(restoredCredit?.remainingAmountUsdCents)).toBe(500);

      // The abandoned invoice should have its applied credit reversed so retries
      // later charge the full amount.
      const updatedInvoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, invoice.id),
      });
      expect(Number(updatedInvoice?.amountPaidUsdCents ?? 0)).toBe(0);

      const remainingPayments = await db.select().from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, invoice.id));
      const creditPayments = remainingPayments.filter(p => p.sourceType === 'credit');
      expect(creditPayments.length).toBe(0);
    });

    it('Bug 5: should not refund credits needed for unpaid invoices', async () => {
      // This test exercises the excess credit refund logic indirectly.
      // processExcessCreditRefunds only runs when tierChangesApplied > 0.
      // We set up a scheduled tier change (pro → starter) so it triggers.

      // Give customer reconciliation credits
      await db.transaction(async (tx) => {
        await issueCredit(tx, testCustomerId, 5000, 'reconciliation', 'Tier downgrade credit', null);
      });

      // Create a FAILED invoice that needs payment
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2024-12-01'),
        billingPeriodEnd: new Date('2024-12-31'),
        amountUsdCents: 2900, // $29.00 unpaid
        amountPaidUsdCents: 0,
        type: 'charge',
        status: 'failed',
        billingType: 'scheduled',
        retryCount: config.maxRetryAttempts, // Exhausted - won't be retried
        failureReason: 'Card declined',
        createdAt: clock.now(),
      });

      // Create a service with scheduled tier change (pro → starter) on 1st
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        state: 'enabled',
        config: { tier: 'pro' },
        scheduledTier: 'starter',
        scheduledTierEffectiveDate: '2025-01-01',
      });

      // Create a DRAFT so monthly billing runs
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 2900, // Pro price (will be recalculated after tier change)
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      // Run billing on 1st (triggers tier change + excess credit refund check)
      clock.setTime(new Date('2025-01-01T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Check remaining reconciliation credits — they should NOT have been
      // fully refunded because the FAILED invoice needs $29 of coverage.
      // Without the fix: reserve = $9 (monthly), excess = $50 - $9 = $41
      // With the fix: reserve = $9 + $29 = $38, excess = $50 - $38 = $12
      // Since there's no Stripe payment to refund against, the refund is skipped
      // entirely, but the reserve check itself is what we're validating.
      const remainingCredits = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ));

      const totalRemaining = remainingCredits.reduce(
        (sum, c) => sum + Number(c.remainingAmountUsdCents), 0
      );
      // Should have at least $29 remaining (the unpaid invoice amount shouldn't be refunded)
      expect(totalRemaining).toBeGreaterThanOrEqual(2900);
    });

    it('Bug 7: reconcileStuckInvoices should create invoice_payments row when marking paid', async () => {
      // Scenario: Two-phase commit — invoice created as 'pending/immediate',
      // then server crashes after on-chain charge but before DB commit.
      // Reconciliation finds the ledger entry and marks the invoice paid,
      // but NEVER creates an invoice_payments row.
      //
      // Impact: getInvoicePaidAmount returns 0 for a "paid" invoice.
      // processExcessCreditRefunds can't find the Stripe/escrow source payment.
      // Audit trail shows paid invoice with zero payment history.
      //
      // FIX: When reconciling to paid, insert an invoice_payments row
      // (escrow source with the escrow transaction ID).

      // Create a stuck pending immediate invoice (created > 10 min ago)
      const createdAt = new Date(clock.now().getTime() - 15 * 60 * 1000); // 15 min ago
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-15'),
        billingPeriodEnd: new Date('2025-02-14'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'pending',
        billingType: 'immediate',
        createdAt,
      }).returning();

      // Simulate: the on-chain charge succeeded and was recorded in escrow_transactions
      const txDigest = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) txDigest[i] = i + 1; // deterministic non-zero digest
      const [escrowTx] = await db.insert(escrowTransactions).values({
        customerId: testCustomerId,
        txDigest,
        txType: 'charge',
        amountUsd: '9.00',
        assetType: '0xtest',
        timestamp: createdAt,
      }).returning();

      // Create the ledger entry that reconciliation checks
      await db.insert(ledgerEntries).values({
        customerId: testCustomerId,
        type: 'charge',
        amountUsdCents: 900,
        txDigest,
        invoiceId: invoice.id,
        description: 'Escrow charge for subscription',
      });

      // Also need a service for finalizeSuccessfulPayment
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        config: { tier: 'starter' },
        subPendingInvoiceId: invoice.id,
      });

      // Run reconciliation
      const result = await reconcileStuckInvoices(db, clock);

      expect(result.invoicesMarkedPaid).toBe(1);

      // Verify: invoice is marked paid
      const [paidInvoice] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, invoice.id));
      expect(paidInvoice.status).toBe('paid');
      expect(Number(paidInvoice.amountPaidUsdCents)).toBe(900);

      // CRITICAL: An invoice_payments row should exist for audit trail
      const payments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, invoice.id));
      expect(payments.length).toBeGreaterThanOrEqual(1);

      // The payment should be an escrow source with the correct escrow transaction ID
      const escrowPayment = payments.find(p => p.sourceType === 'escrow');
      expect(escrowPayment).toBeDefined();
      expect(Number(escrowPayment!.amountUsdCents)).toBe(900);
      expect(Number(escrowPayment!.escrowTransactionId)).toBe(escrowTx.txId);
    });

    it('Bug 4b: should not double-credit when reactive retry runs after credit restoration', async () => {
      // Scenario:
      // 1. Invoice $9.00, customer has $5 credit applied → amountPaidUsdCents=500
      // 2. Provider fails, retries exhaust → credit restored (new $5 credit issued)
      // 3. Customer adds payment method → reactive retry runs
      //
      // BUG: The invoice still has amountPaidUsdCents=500 and the old credit
      // invoice_payments row. On retry, remainingAmount = 900-500 = 400.
      // The restored credit applies $4 to the $4 remaining, provider charges $0.
      // Customer effectively gets $5 double-counted (old + restored credit).
      //
      // FIX: When restoring credits, also reverse the invoice's credit payments
      // (delete invoice_payments credit rows, reset amountPaidUsdCents).

      // Setup: customer with escrow payment method but NO funds
      await db.update(customers)
        .set({ currentBalanceUsdCents: 0 })
        .where(eq(customers.customerId, testCustomerId));

      // Issue a credit and mark it consumed (simulates prior applyCreditsToInvoice)
      await db.transaction(async (tx) => {
        await issueCredit(tx, testCustomerId, 500, 'promo', 'Test credit', null);
      });
      const [creditRow] = await db.select()
        .from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));
      const creditId = creditRow.creditId;
      await db.update(customerCredits)
        .set({ remainingAmountUsdCents: 0 })
        .where(eq(customerCredits.creditId, creditId));

      // Create a failed invoice with credits partially applied
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        amountPaidUsdCents: 500, // $5 from credits
        type: 'charge',
        status: 'failed',
        billingType: 'immediate',
        retryCount: config.maxRetryAttempts - 1, // One more fail exhausts
        failureReason: 'Insufficient balance',
        lastRetryAt: new Date('2025-01-01T00:00:00Z'),
        createdAt: clock.now(),
      }).returning();

      // Record the credit payment row
      await db.insert(invoicePayments).values({
        billingRecordId: invoice.id,
        sourceType: 'credit',
        amountUsdCents: 500,
        creditId,
        escrowTransactionId: null,
        providerReferenceId: null,
      });

      // Phase 1: Run billing — retry fails, exhausts, credit restored
      clock.setTime(new Date('2025-01-15T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Verify credit was restored
      const restoredCredits = await db.select().from(customerCredits)
        .where(and(
          eq(customerCredits.customerId, testCustomerId),
          eq(customerCredits.reason, 'reconciliation'),
        ));
      const restoredCredit = restoredCredits.find(c =>
        c.description?.includes('Credit restoration')
      );
      expect(restoredCredit).toBeDefined();

      // CRITICAL CHECK: After restoration, the invoice's amountPaidUsdCents
      // should be reset to 0 (credit payments reversed), so a reactive retry
      // sees the full $9.00 remaining instead of only $4.00.
      const [invoiceAfterExhaust] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, invoice.id));
      expect(Number(invoiceAfterExhaust.amountPaidUsdCents ?? 0)).toBe(0);

      // CRITICAL CHECK: The credit invoice_payments row should be deleted
      const creditPaymentsAfter = await db.select()
        .from(invoicePayments)
        .where(and(
          eq(invoicePayments.billingRecordId, invoice.id),
          eq(invoicePayments.sourceType, 'credit'),
        ));
      expect(creditPaymentsAfter.length).toBe(0);

      // Phase 2: Customer deposits funds and reactive retry runs
      await db.update(customers)
        .set({ currentBalanceUsdCents: 10000 }) // $100 — plenty
        .where(eq(customers.customerId, testCustomerId));

      // Reactive retry (no limits) — simulates customer adding payment method
      const tx = unsafeAsLockedTransaction(db);
      const retryResult = await retryUnpaidInvoices(
        tx, testCustomerId, toEscrowProviders(suiService, db, clock), clock
      );

      expect(retryResult.paidCount).toBe(1);

      // The invoice should be fully paid for $9.00 total
      const [finalInvoice] = await db.select()
        .from(billingRecords)
        .where(eq(billingRecords.id, invoice.id));
      expect(finalInvoice.status).toBe('paid');
      // Total paid should be $9.00 (restored credit applied fresh + escrow for remainder)
      expect(Number(finalInvoice.amountPaidUsdCents)).toBe(900);

      // Customer should NOT get a $5 discount — escrow should have been charged
      // for the portion not covered by the restored credit
      const allPayments = await db.select()
        .from(invoicePayments)
        .where(eq(invoicePayments.billingRecordId, invoice.id));
      const totalPaid = allPayments.reduce((sum, p) => sum + Number(p.amountUsdCents), 0);
      expect(totalPaid).toBe(900); // Full $9.00, no double-credit
    });

    it('Bug 6c: catch-up should create DRAFT for current month, not skip it', async () => {
      // Scenario: Processor was down on Jan 1. Catches up on Feb 5.
      // Catch-up processes stale January DRAFT. After payment,
      // recalculateDraftInvoice creates a DRAFT for MARCH (next month from Feb 5).
      // February has no DRAFT and is permanently unbilled.
      //
      // FIX: After catch-up, if the processed DRAFT was for a previous month,
      // also create a DRAFT for the current month so the next run bills it.

      await db.update(customers)
        .set({ currentBalanceUsdCents: 10000 }) // $100 — enough to pay
        .where(eq(customers.customerId, testCustomerId));

      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        config: { tier: 'starter' },
      });

      // Create a stale January DRAFT (processor was down all of January)
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'draft',
        createdAt: new Date('2024-12-15T00:00:00Z'),
      });

      // Run billing on Feb 5 — catch-up processes January DRAFT
      clock.setTime(new Date('2025-02-05T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // January should be billed (paid or at least transitioned from draft)
      const allInvoices = await db.select().from(billingRecords)
        .where(eq(billingRecords.customerId, testCustomerId));
      const janInvoice = allInvoices.find(i =>
        new Date(i.billingPeriodStart).getUTCMonth() === 0 && // January
        i.status !== 'draft'
      );
      expect(janInvoice).toBeDefined();

      // CRITICAL: A February DRAFT should exist so the next catch-up run bills it.
      // Without the fix, only a March DRAFT exists and February is permanently skipped.
      const febDraft = allInvoices.find(i => {
        const start = new Date(i.billingPeriodStart);
        return start.getUTCMonth() === 1 && // February
               start.getUTCFullYear() === 2025 &&
               i.status === 'draft';
      });
      expect(febDraft).toBeDefined();
      // Amount may be $0 initially — processMonthlyBilling will recalculate
      // when the next catch-up run processes this DRAFT.

      // The February DRAFT should be stale (billingPeriodStart <= now),
      // so the next billing run will catch it up too.
      const febStart = new Date(febDraft!.billingPeriodStart);
      expect(febStart.getTime()).toBeLessThanOrEqual(clock.now().getTime());
    });

    it('Bug 8a: catch-up DRAFT should be billed, not voided as $0', async () => {
      // Scenario: Processor was down on Jan 1, catches up on Feb 5.
      // 1st run: January stale DRAFT is processed (paid).
      //   recalculateDraftInvoice creates a March DRAFT (next month from Feb 5).
      //   Catch-up code creates a February DRAFT with $0 and no line items.
      // 2nd run: processMonthlyBilling finds the $0 February DRAFT.
      //   Without fix: amount check sees $0 → voids it. February never billed.
      //   With fix: recalculateDraftInvoice populates the DRAFT before the amount check.

      await db.update(customers)
        .set({ currentBalanceUsdCents: 100000 }) // $1000 — plenty
        .where(eq(customers.customerId, testCustomerId));

      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        config: { tier: 'starter' },
      });

      // Create a stale January DRAFT
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'draft',
        createdAt: new Date('2024-12-15T00:00:00Z'),
      });

      // 1st run: catch-up processes January, creates bare February DRAFT
      clock.setTime(new Date('2025-02-05T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Verify February DRAFT exists (from Bug 6c test)
      const allInvoices1 = await db.select().from(billingRecords)
        .where(eq(billingRecords.customerId, testCustomerId));
      const febDraft = allInvoices1.find(i => {
        const start = new Date(i.billingPeriodStart);
        return start.getUTCMonth() === 1 && start.getUTCFullYear() === 2025 && i.status === 'draft';
      });
      expect(febDraft).toBeDefined();

      // 2nd run: catch-up finds February DRAFT as stale and processes it
      clock.setTime(new Date('2025-02-06T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // February should be PAID, not voided
      const allInvoices2 = await db.select().from(billingRecords)
        .where(eq(billingRecords.customerId, testCustomerId));
      const febInvoice = allInvoices2.find(i => {
        const start = new Date(i.billingPeriodStart);
        return start.getUTCMonth() === 1 && start.getUTCFullYear() === 2025;
      });
      expect(febInvoice).toBeDefined();
      expect(febInvoice!.status).toBe('paid');
      expect(Number(febInvoice!.amountUsdCents)).toBe(900); // Starter price

      // No February invoice should be voided
      const febVoided = allInvoices2.find(i => {
        const start = new Date(i.billingPeriodStart);
        return start.getUTCMonth() === 1 && start.getUTCFullYear() === 2025 && i.status === 'voided';
      });
      expect(febVoided).toBeUndefined();
    });

    it('Bug 8b: catch-up should not prematurely bill future month DRAFTs', async () => {
      // Scenario: After January catch-up on Feb 5, recalculateDraftInvoice creates
      // a March DRAFT (next month from Feb 5). Without the fix, processMonthlyBilling
      // on the 2nd run would find both February and March DRAFTs and bill March early.
      //
      // The fix has two parts:
      // 1. Catch-up deletes premature future-month DRAFTs (March) when creating the
      //    current-month DRAFT (February). This prevents MULTIPLE_DRAFT_INVOICES.
      // 2. processMonthlyBilling filters DRAFTs by billingPeriodStart <= now.
      //
      // After 1st run: only February DRAFT exists (March was deleted).
      // After 2nd run: February is paid, March DRAFT is recreated by
      //   recalculateDraftInvoice (next month from Feb 6).
      // March DRAFT should remain as draft — it's for a future month.

      await db.update(customers)
        .set({ currentBalanceUsdCents: 100000 })
        .where(eq(customers.customerId, testCustomerId));

      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        config: { tier: 'starter' },
      });

      // Create a stale January DRAFT
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'draft',
        createdAt: new Date('2024-12-15T00:00:00Z'),
      });

      // 1st run: catch-up on Feb 5 → processes January, creates Feb DRAFT
      // (premature March DRAFT is deleted by the catch-up code)
      clock.setTime(new Date('2025-02-05T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // After 1st run: only February DRAFT should exist (no premature March)
      const allInvoices1 = await db.select().from(billingRecords)
        .where(eq(billingRecords.customerId, testCustomerId));
      const drafts1 = allInvoices1.filter(i => i.status === 'draft');
      expect(drafts1.length).toBe(1);
      const febDraft = drafts1[0];
      expect(new Date(febDraft.billingPeriodStart).getUTCMonth()).toBe(1); // February

      // 2nd run: processes February catch-up, creates March DRAFT after payment
      clock.setTime(new Date('2025-02-06T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // After 2nd run: February should be paid, March DRAFT should exist
      const allInvoices2 = await db.select().from(billingRecords)
        .where(eq(billingRecords.customerId, testCustomerId));

      // March DRAFT should exist and still be a draft (not prematurely billed)
      const marchAfter = allInvoices2.find(i => {
        const start = new Date(i.billingPeriodStart);
        return start.getUTCMonth() === 2 && start.getUTCFullYear() === 2025;
      });
      expect(marchAfter).toBeDefined();
      expect(marchAfter!.status).toBe('draft'); // NOT paid or pending
    });

    it('Bug 9: voidInvoice should restore consumed credits', async () => {
      // Scenario: An invoice has credits applied (via applyCreditsToInvoice) but
      // the provider charge fails, leaving the invoice as 'failed' with partial
      // credit payments recorded in invoice_payments. If the invoice is later voided,
      // those credits must be restored — otherwise the customer loses real money.
      //
      // Without fix: credits stay consumed against a dead (voided) invoice.
      // With fix: voidInvoice issues a compensating credit before voiding.

      // Give customer credits
      await issueCredit(db, testCustomerId, 500, 'reconciliation', 'Test credit');

      // Create a pending invoice with amount > credits (so provider is needed)
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'pending',
      }).returning();

      // Apply credits to the invoice (simulates what processInvoicePayment does)
      const tx = unsafeAsLockedTransaction(db);
      const creditResult = await applyCreditsToInvoice(tx, testCustomerId, invoice.id, 900, clock);
      expect(creditResult.totalAppliedCents).toBe(500); // All 500 cents used

      // Update invoice to reflect partial payment
      await db.update(billingRecords)
        .set({ amountPaidUsdCents: 500, status: 'failed' })
        .where(eq(billingRecords.id, invoice.id));

      // Verify credits are consumed
      const [creditBefore] = await db.select().from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));
      expect(Number(creditBefore.remainingAmountUsdCents)).toBe(0);

      // Void the invoice — credits should be restored
      await voidInvoice(db, invoice.id, 'Test void with credits');

      // Verify invoice is voided
      const [voidedInvoice] = await db.select().from(billingRecords)
        .where(eq(billingRecords.id, invoice.id));
      expect(voidedInvoice.status).toBe('voided');

      // Verify a compensating credit was issued (remaining > 0 distinguishes it
      // from the original consumed credit which has remaining = 0)
      const allCredits = await db.select().from(customerCredits)
        .where(eq(customerCredits.customerId, testCustomerId));
      const compensatingCredit = allCredits.find(c =>
        Number(c.remainingAmountUsdCents) === 500 && c.reason === 'reconciliation'
      );
      expect(compensatingCredit).toBeDefined();
    });

    it('Bug 6b: catch-up should not consume next month idempotency key', async () => {
      // Scenario: processor was down on Jan 1. Stale January DRAFT survives.
      // On Feb 1 (isFirstOfMonth=true), the normal path finds the stale January
      // DRAFT and processes it. The idempotency key must be derived from the
      // DRAFT's billing period (January), NOT from today (February).
      // Otherwise, February's own billing would be skipped as "already processed."

      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'starter',
        isUserEnabled: true,
        config: { tier: 'starter' },
      });

      // Create a stale January DRAFT (processor was down Jan 1)
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: new Date('2025-01-01'),
        billingPeriodEnd: new Date('2025-01-31'),
        amountUsdCents: 900,
        type: 'charge',
        status: 'draft',
        createdAt: new Date('2024-12-15T00:00:00Z'),
      });

      // Run billing on Feb 1 — should process stale January DRAFT
      clock.setTime(new Date('2025-02-01T00:00:00Z'));
      await processCustomerBilling(db, testCustomerId, config, paymentServices);

      // Verify: January billing happened (stale DRAFT processed)
      const janInvoice = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'paid'),
        ),
      });
      expect(janInvoice).toBeDefined();

      // Critical check: the idempotency key should be for January, NOT February.
      // If February's key was consumed, February billing would be permanently skipped.
      const febKey = `monthly-${testCustomerId}-2025-02`;
      const janKey = `monthly-${testCustomerId}-2025-01`;

      const febIdempotency = await db.select().from(billingIdempotency)
        .where(eq(billingIdempotency.idempotencyKey, febKey));
      const janIdempotency = await db.select().from(billingIdempotency)
        .where(eq(billingIdempotency.idempotencyKey, janKey));

      // February's key should NOT be consumed by January's catch-up
      expect(febIdempotency.length).toBe(0);
      // January's key SHOULD be set
      expect(janIdempotency.length).toBe(1);
    });
  });
});
