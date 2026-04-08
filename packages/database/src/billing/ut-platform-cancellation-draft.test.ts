/**
 * Platform Cancellation DRAFT Invoice Test
 *
 * Reproduces bug: after scheduling platform cancellation, the DRAFT invoice
 * still shows the platform subscription charge.
 * Tests both platform and seal to check if root cause is shared.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '../db';
import {
  customers,
  billingRecords,
  invoiceLineItems,
  customerPaymentMethods,
} from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import type { ISuiService, ChargeParams, TransactionResult } from '@suiftly/shared/sui-service';
import { scheduleCancellation } from './tier-changes';
import { handleSubscriptionBilling } from './service-billing';
import { recalculateDraftInvoice } from './draft-invoice';
import {
  unsafeAsLockedTransaction,
  toPaymentServices,
  ensureEscrowPaymentMethod,
  cleanupCustomerData,
  resetTestState,
  suspendGMProcessing,
} from './test-helpers';
import { eq, and } from 'drizzle-orm';
import { getTierPriceUsdCents } from '@suiftly/shared/pricing';

// Mock SUI service — matches pattern from ut-tier-changes.test.ts
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
    if (!customer) return { digest: this.generateMockDigest(), success: false, error: 'Customer not found' };
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

describe('Cancellation should remove service from DRAFT invoice', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const paymentServices = toPaymentServices(suiService);
  const CUSTOMER_ID = 8800;
  const WALLET = '0xCANCEL8800abcdef1234567890abcdefABCDEF1234567890abcdefABCDEF12';

  beforeAll(async () => {
    await resetTestState(db);
  });

  beforeEach(async () => {
    await suspendGMProcessing();
    clock.setTime(new Date('2025-01-15T00:00:00Z'));
    await cleanupCustomerData(db, CUSTOMER_ID);

    // Create customer with balance
    await db.insert(customers).values({
      customerId: CUSTOMER_ID,
      walletAddress: WALLET,
      escrowContractId: '0xESCROW8800',
      status: 'active',
      currentBalanceUsdCents: 100000, // $1000
      spendingLimitUsdCents: 200000,
      currentPeriodChargedUsdCents: 0,
      currentPeriodStart: '2025-01-01',
      paidOnce: true,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });

    await ensureEscrowPaymentMethod(db, CUSTOMER_ID);
  });

  afterEach(async () => {
    await cleanupCustomerData(db, CUSTOMER_ID);
  });

  it('should remove platform subscription from DRAFT after cancellation', async () => {
    // 1. Set platform tier on customer, then process billing
    await db.update(customers).set({
      platformTier: 'starter',
    }).where(eq(customers.customerId, CUSTOMER_ID));

    const platformResult = await handleSubscriptionBilling(
      db, CUSTOMER_ID, 'platform', 'starter',
      getTierPriceUsdCents('starter'),
      paymentServices, clock
    );
    expect(platformResult.paymentSuccessful).toBe(true);

    // 2. Verify DRAFT includes platform subscription
    const draftBefore = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, CUSTOMER_ID),
        eq(billingRecords.status, 'draft')
      ),
    });
    expect(draftBefore).toBeDefined();

    const lineItemsBefore = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.billingRecordId, draftBefore!.id));
    const platformItemBefore = lineItemsBefore.find(li => li.serviceType === 'platform');
    expect(platformItemBefore).toBeDefined();
    console.log(`DRAFT before cancellation: $${Number(draftBefore!.amountUsdCents) / 100}, platform line item: $${Number(platformItemBefore!.amountUsdCents) / 100}`);

    // 3. Schedule cancellation
    const cancelResult = await scheduleCancellation(
      db, CUSTOMER_ID, 'platform', clock
    );
    expect(cancelResult.success).toBe(true);

    // 4. Verify DRAFT no longer includes platform subscription
    const draftAfter = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, CUSTOMER_ID),
        eq(billingRecords.status, 'draft')
      ),
    });
    expect(draftAfter).toBeDefined();

    const lineItemsAfter = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.billingRecordId, draftAfter!.id));
    const platformSubItemAfter = lineItemsAfter.find(
      li => li.serviceType === 'platform' && li.itemType !== 'credit'
    );

    console.log(`DRAFT after cancellation: $${Number(draftAfter!.amountUsdCents) / 100}, platform sub items: ${lineItemsAfter.filter(li => li.serviceType === 'platform' && li.itemType !== 'credit').length}`);

    expect(platformSubItemAfter).toBeUndefined();
    // DRAFT negative because platform credit remains after sub removed.
    // Platform Starter on Jan 15: credit = floor(100*14/31) = 45 cents
    expect(Number(draftAfter!.amountUsdCents)).toBe(-45);
  });

  it('should remove platform pro subscription from DRAFT after cancellation (control test)', async () => {
    // 1. Set platform pro tier on customer, then process billing
    // (Control test: verifies cancellation DRAFT removal works for pro tier too)
    await db.update(customers).set({
      platformTier: 'pro',
    }).where(eq(customers.customerId, CUSTOMER_ID));

    const proResult = await handleSubscriptionBilling(
      db, CUSTOMER_ID, 'platform', 'pro',
      getTierPriceUsdCents('pro'),
      paymentServices, clock
    );
    expect(proResult.paymentSuccessful).toBe(true);

    // 2. Verify DRAFT includes platform pro subscription
    const draftBefore = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, CUSTOMER_ID),
        eq(billingRecords.status, 'draft')
      ),
    });
    expect(draftBefore).toBeDefined();

    const lineItemsBefore = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.billingRecordId, draftBefore!.id));
    const proItemBefore = lineItemsBefore.find(li => li.serviceType === 'platform');
    expect(proItemBefore).toBeDefined();
    console.log(`DRAFT before cancellation: $${Number(draftBefore!.amountUsdCents) / 100}, platform pro line item: $${Number(proItemBefore!.amountUsdCents) / 100}`);

    // 3. Schedule cancellation
    const cancelResult = await scheduleCancellation(
      db, CUSTOMER_ID, 'platform', clock
    );
    expect(cancelResult.success).toBe(true);

    // 4. Verify DRAFT no longer includes platform subscription
    const draftAfter = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, CUSTOMER_ID),
        eq(billingRecords.status, 'draft')
      ),
    });
    expect(draftAfter).toBeDefined();

    const lineItemsAfter = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.billingRecordId, draftAfter!.id));
    const proSubItemAfter = lineItemsAfter.find(
      li => li.serviceType === 'platform' && li.itemType !== 'credit'
    );

    console.log(`DRAFT after cancellation: $${Number(draftAfter!.amountUsdCents) / 100}, platform sub items: ${lineItemsAfter.filter(li => li.serviceType === 'platform' && li.itemType !== 'credit').length}`);

    expect(proSubItemAfter).toBeUndefined();
    // DRAFT negative because platform pro credit remains after sub removed.
    // Platform Pro on Jan 15: credit = floor(2900*14/31) = 1309 cents
    expect(Number(draftAfter!.amountUsdCents)).toBe(-1309);
  });
});
