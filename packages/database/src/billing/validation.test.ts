/**
 * Invoice Validation Tests
 *
 * Tests defensive validation that prevents billing errors.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingRecords,
  customerCredits,
  serviceInstances,
  billingIdempotency,
  invoicePayments,
  escrowTransactions,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { validateInvoiceBeforeCharging, ensureInvoiceValid } from './validation';
import { handleSubscriptionBilling, recalculateDraftInvoice } from './service-billing';
import { issueCredit } from './credits';
import { logInternalError } from './admin-notifications';
import { eq, and, sql } from 'drizzle-orm';
import type { ISuiService, TransactionResult, ChargeParams } from '@suiftly/shared/sui-service';
import { adminNotifications } from '../schema/admin';

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

describe('Invoice Validation', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const testWalletAddress = '0xVAL3000567890abcdefABCDEF1234567890abcdefABCDEF1234567890abc';
  let testCustomerId: number;

  beforeAll(async () => {
    await db.execute(sql`TRUNCATE TABLE admin_notifications CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_idempotency CASCADE`);
    await db.execute(sql`TRUNCATE TABLE invoice_payments CASCADE`);
    await db.execute(sql`TRUNCATE TABLE billing_records CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customer_credits CASCADE`);
    await db.execute(sql`TRUNCATE TABLE service_instances CASCADE`);
    await db.execute(sql`TRUNCATE TABLE escrow_transactions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE customers CASCADE`);
  });

  beforeEach(async () => {
    clock.setTime(new Date('2025-01-15T00:00:00Z'));

    const [customer] = await db.insert(customers).values({
      customerId: 3000,
      walletAddress: testWalletAddress,
      escrowContractId: '0xESCROW3000',
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
    await db.delete(customers);
  });

  describe('Negative Amount Detection', () => {
    it('should detect negative invoice amounts', async () => {
      // Create invoice with negative amount (bug scenario)
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: -2900, // BUG: Negative amount
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      }).returning();

      const validation = await db.transaction(async (tx) => {
        return await validateInvoiceBeforeCharging(tx, invoice.id);
      });

      expect(validation.valid).toBe(false);
      expect(validation.criticalErrors.length).toBeGreaterThanOrEqual(1);
      expect(validation.criticalErrors.some(e => e.code === 'NEGATIVE_AMOUNT')).toBe(true);
    });
  });

  describe('DRAFT Amount Mismatch Detection', () => {
    it('should detect when DRAFT amount doesnt match enabled services', async () => {
      // Create enabled service
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        config: { tier: 'pro' },
        createdAt: clock.now(),
      });

      // Create DRAFT with WRONG amount (bug scenario - stale DRAFT)
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 900, // BUG: Shows Starter price, but service is Pro
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      }).returning();

      const validation = await db.transaction(async (tx) => {
        return await validateInvoiceBeforeCharging(tx, invoice.id);
      });

      expect(validation.valid).toBe(false);
      expect(validation.criticalErrors.some(e => e.code === 'DRAFT_AMOUNT_MISMATCH')).toBe(true);

      const mismatchError = validation.criticalErrors.find(e => e.code === 'DRAFT_AMOUNT_MISMATCH');
      expect(mismatchError?.details.draftAmount).toBe(9); // $9
      expect(mismatchError?.details.expectedAmount).toBe(29); // $29
    });

    it('should pass when DRAFT amount matches enabled services', async () => {
      // Create enabled service
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        config: { tier: 'pro' },
        createdAt: clock.now(),
      });

      // Create DRAFT with CORRECT amount
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 2900, // Correct: Pro tier price
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      }).returning();

      const validation = await db.transaction(async (tx) => {
        return await validateInvoiceBeforeCharging(tx, invoice.id);
      });

      expect(validation.valid).toBe(true);
      expect(validation.criticalErrors).toHaveLength(0);
    });
  });

  describe('Multiple DRAFT Invoice Detection', () => {
    it('should detect if customer has multiple DRAFT invoices', async () => {
      // Create first DRAFT
      const [invoice1] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 2900,
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      }).returning();

      // Create second DRAFT (BUG scenario)
      await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 900,
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      });

      const validation = await db.transaction(async (tx) => {
        return await validateInvoiceBeforeCharging(tx, invoice1.id);
      });

      expect(validation.valid).toBe(false);
      expect(validation.criticalErrors.some(e => e.code === 'MULTIPLE_DRAFT_INVOICES')).toBe(true);
    });
  });

  describe('Orphaned Credits Detection', () => {
    it('should warn when reconciliation credits exist without enabled services', async () => {
      // Issue reconciliation credit (simulates cancelled service with unused credit)
      await db.transaction(async (tx) => {
        await issueCredit(
          tx,
          testCustomerId,
          1500,
          'reconciliation',
          'Partial month credit',
          null
        );
      });

      // Create DRAFT invoice (no services enabled)
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 0,
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      }).returning();

      const validation = await db.transaction(async (tx) => {
        return await validateInvoiceBeforeCharging(tx, invoice.id);
      });

      // Should pass (warnings don't fail validation)
      expect(validation.valid).toBe(true);

      // But should have warning
      expect(validation.warnings).toHaveLength(1);
      expect(validation.warnings[0].code).toBe('ORPHANED_RECONCILIATION_CREDITS');
    });
  });

  describe('Integration with handleSubscriptionBilling', () => {
    it('should create valid DRAFT invoice after subscription', async () => {
      // Subscribe to service
      const billingResult = await handleSubscriptionBilling(
        db,
        testCustomerId,
        'seal',
        'pro',
        2900,
        suiService,
        clock
      );

      expect(billingResult.paymentSuccessful).toBe(true);

      // Enable the service (happens after payment success)
      const services = await db.select().from(serviceInstances)
        .where(eq(serviceInstances.customerId, testCustomerId));

      if (services.length > 0) {
        await db.update(serviceInstances)
          .set({ isUserEnabled: true })
          .where(eq(serviceInstances.instanceId, services[0].instanceId));
      }

      // Find DRAFT invoice created by handleSubscriptionBilling
      const draft = await db.query.billingRecords.findFirst({
        where: and(
          eq(billingRecords.customerId, testCustomerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      expect(draft).toBeDefined();

      // Validate DRAFT
      const validation = await db.transaction(async (tx) => {
        return await validateInvoiceBeforeCharging(tx, draft!.id);
      });

      // Should be valid (amount matches enabled service)
      expect(validation.valid).toBe(true);
      expect(validation.criticalErrors).toHaveLength(0);
    });
  });

  describe('Admin Notifications', () => {
    it('should log validation errors to admin_notifications table', async () => {
      // Create service
      await db.insert(serviceInstances).values({
        customerId: testCustomerId,
        serviceType: 'seal',
        tier: 'pro',
        isUserEnabled: true,
        config: { tier: 'pro' },
        createdAt: clock.now(),
      });

      // Create DRAFT with wrong amount
      const [invoice] = await db.insert(billingRecords).values({
        customerId: testCustomerId,
        billingPeriodStart: clock.now(),
        billingPeriodEnd: clock.addDays(30),
        amountUsdCents: 900, // Wrong: Starter price, but service is Pro
        type: 'charge',
        status: 'draft',
        createdAt: clock.now(),
      }).returning();

      // Manually log the validation error (simulates what recalculateDraftInvoice does)
      await db.transaction(async (tx) => {
        await logInternalError(tx, {
          severity: 'error',
          category: 'billing',
          code: 'DRAFT_AMOUNT_MISMATCH',
          message: 'DRAFT invoice amount mismatch',
          details: { draftAmount: 9, expectedAmount: 29 },
          customerId: testCustomerId,
          invoiceId: invoice.id,
        });
      });

      // Verify notification was logged
      const notifications = await db.select().from(adminNotifications)
        .where(eq(adminNotifications.customerId, String(testCustomerId)));

      expect(notifications).toHaveLength(1);
      expect(notifications[0].severity).toBe('error');
      expect(notifications[0].category).toBe('billing');
      expect(notifications[0].code).toBe('DRAFT_AMOUNT_MISMATCH');
      expect(notifications[0].acknowledged).toBe(false);
    });

    it('should log warnings when orphaned reconciliation credits detected', async () => {
      // Create reconciliation credit WITHOUT any subscribed services
      // (simulates customer who cancelled subscription but credit remains)
      await db.transaction(async (tx) => {
        await issueCredit(
          tx,
          testCustomerId,
          1500,
          'reconciliation',
          'Orphaned reconciliation credit',
          null
        );
      });

      // Recalculate DRAFT (no subscribed services, so amount = $0)
      await db.transaction(async (tx) => {
        await recalculateDraftInvoice(tx, testCustomerId, clock);
      });

      // Verify warning was logged to admin_notifications
      const notifications = await db.select().from(adminNotifications)
        .where(eq(adminNotifications.category, 'billing'));

      expect(notifications.length).toBeGreaterThanOrEqual(1);
      const orphanedCreditWarning = notifications.find(n => n.code === 'ORPHANED_RECONCILIATION_CREDITS');
      expect(orphanedCreditWarning).toBeDefined();
      expect(orphanedCreditWarning?.severity).toBe('warning');
    });
  });
});
