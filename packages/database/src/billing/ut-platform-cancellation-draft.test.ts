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
  serviceInstances,
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
    // 1. Create platform service instance, then process billing
    await db.insert(serviceInstances).values({
      customerId: CUSTOMER_ID,
      serviceType: 'platform',
      tier: 'starter',
      state: 'enabled',
      isUserEnabled: true,
      paidOnce: false,
      config: { tier: 'starter' },
    });

    const platformResult = await handleSubscriptionBilling(
      db, CUSTOMER_ID, 'platform', 'starter',
      getTierPriceUsdCents('starter', 'platform'),
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
    const platformItemAfter = lineItemsAfter.find(li => li.serviceType === 'platform');

    console.log(`DRAFT after cancellation: $${Number(draftAfter!.amountUsdCents) / 100}, platform line items: ${lineItemsAfter.filter(li => li.serviceType === 'platform').length}`);

    expect(platformItemAfter).toBeUndefined();
    expect(Number(draftAfter!.amountUsdCents)).toBe(0);
  });

  it('should remove seal subscription from DRAFT after cancellation (control test)', async () => {
    // 1. Create seal service instance, then process billing
    await db.insert(serviceInstances).values({
      customerId: CUSTOMER_ID,
      serviceType: 'seal',
      tier: 'pro',
      state: 'disabled',
      isUserEnabled: false,
      paidOnce: false,
      config: { tier: 'pro' },
    });

    const sealResult = await handleSubscriptionBilling(
      db, CUSTOMER_ID, 'seal', 'pro',
      getTierPriceUsdCents('pro', 'seal'),
      paymentServices, clock
    );
    expect(sealResult.paymentSuccessful).toBe(true);

    // 2. Verify DRAFT includes seal subscription
    const draftBefore = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, CUSTOMER_ID),
        eq(billingRecords.status, 'draft')
      ),
    });
    expect(draftBefore).toBeDefined();

    const lineItemsBefore = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.billingRecordId, draftBefore!.id));
    const sealItemBefore = lineItemsBefore.find(li => li.serviceType === 'seal');
    expect(sealItemBefore).toBeDefined();
    console.log(`DRAFT before cancellation: $${Number(draftBefore!.amountUsdCents) / 100}, seal line item: $${Number(sealItemBefore!.amountUsdCents) / 100}`);

    // 3. Schedule cancellation
    const cancelResult = await scheduleCancellation(
      db, CUSTOMER_ID, 'seal', clock
    );
    expect(cancelResult.success).toBe(true);

    // 4. Verify DRAFT no longer includes seal subscription
    const draftAfter = await db.query.billingRecords.findFirst({
      where: and(
        eq(billingRecords.customerId, CUSTOMER_ID),
        eq(billingRecords.status, 'draft')
      ),
    });
    expect(draftAfter).toBeDefined();

    const lineItemsAfter = await db.select().from(invoiceLineItems)
      .where(eq(invoiceLineItems.billingRecordId, draftAfter!.id));
    const sealItemAfter = lineItemsAfter.find(li => li.serviceType === 'seal');

    console.log(`DRAFT after cancellation: $${Number(draftAfter!.amountUsdCents) / 100}, seal line items: ${lineItemsAfter.filter(li => li.serviceType === 'seal').length}`);

    expect(sealItemAfter).toBeUndefined();
    expect(Number(draftAfter!.amountUsdCents)).toBe(0);
  });
});
