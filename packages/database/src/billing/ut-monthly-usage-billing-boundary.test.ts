/**
 * Monthly Usage Billing Boundary Tests
 *
 * Tests that verify usage billing correctly charges the PREVIOUS month's usage
 * when the billing processor runs on the 1st of a new month.
 *
 * These tests insert pre-aggregated stats directly into the stats_per_hour
 * materialization table (via insertMockStats) to avoid TimescaleDB continuous
 * aggregate refresh race conditions. Each test uses a unique customer ID.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '../db';
import { customers, serviceInstances, billingRecords, invoiceLineItems } from '../schema';
import { eq, sql } from 'drizzle-orm';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { insertMockStats, clearMockStats } from '../stats/test-helpers';
import { runPeriodicJobForCustomer } from './periodic-job';
import type { BillingProcessorConfig } from './types';
import type { ISuiService, ChargeParams, TransactionResult } from '@suiftly/shared/sui-service';
import { toPaymentServices, ensureEscrowPaymentMethod, cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

// Each test gets a unique customer ID to avoid cross-test contamination.
const BASE_CUSTOMER_ID = 99950;
let testCounter = 0;

class TestMockSuiService implements ISuiService {
  private generateMockDigest(): string {
    return '0x' + Buffer.alloc(32).fill(Math.random() * 256).toString('hex');
  }

  async charge(params: ChargeParams): Promise<TransactionResult> {
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, params.userAddress),
    });
    if (!customer) return { digest: this.generateMockDigest(), success: false, error: 'Customer not found' };
    const balance = customer.currentBalanceUsdCents ?? 0;
    if (balance < params.amountUsdCents) return { digest: this.generateMockDigest(), success: false, error: 'Insufficient balance' };
    await db.update(customers)
      .set({ currentBalanceUsdCents: balance - params.amountUsdCents })
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

async function createTestCustomer(clock: MockDBClock): Promise<number> {
  testCounter++;
  const customerId = BASE_CUSTOMER_ID + testCounter;
  const idStr = customerId.toString();
  const wallet = '0x' + 'c'.repeat(64 - idStr.length) + idStr;

  await db.insert(customers).values({
    customerId,
    walletAddress: wallet,
    escrowContractId: `0xESCROW_${customerId}`,
    status: 'active',
    currentBalanceUsdCents: 100000,
    spendingLimitUsdCents: 100000,
    currentPeriodChargedUsdCents: 0,
    currentPeriodStart: '2025-01-01',
    paidOnce: true,
    platformTier: 'pro',
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  await db.insert(serviceInstances).values({
    customerId,
    serviceType: 'seal',
    state: 'enabled',
    isUserEnabled: true,
    config: {},
  });

  await ensureEscrowPaymentMethod(db, customerId);
  return customerId;
}

// ============================================================================
// Pure unit tests (no DB)
// ============================================================================

describe('JavaScript Date.UTC month underflow', () => {
  it('should roll back to December of previous year when month is -1', () => {
    const invoiceBillingStart = new Date('2025-01-01T00:00:00Z');
    const usagePeriodStart = new Date(Date.UTC(
      invoiceBillingStart.getUTCFullYear(),
      invoiceBillingStart.getUTCMonth() - 1,
      1, 0, 0, 0, 0
    ));
    expect(usagePeriodStart.toISOString()).toBe('2024-12-01T00:00:00.000Z');
  });

  it('should handle multiple month underflow (edge case)', () => {
    const date = new Date(Date.UTC(2025, -2, 1));
    expect(date.toISOString()).toBe('2024-11-01T00:00:00.000Z');
  });
});

// ============================================================================
// Integration tests
// ============================================================================

describe('Monthly Usage Billing - Month Boundary', () => {
  const clock = new MockDBClock();
  const suiService = new TestMockSuiService();
  const paymentServices = toPaymentServices(suiService);
  const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro;


  const config: BillingProcessorConfig = {
    clock,
    usageChargeThresholdCents: 500,
    gracePeriodDays: 14,
    maxRetryAttempts: 3,
    retryIntervalHours: 24,
  };

  const customerIdsToCleanup: number[] = [];

  // Clean up all possible customer IDs from previous runs (counter resets to 0)
  const ALL_POSSIBLE_IDS = Array.from({ length: 10 }, (_, i) => BASE_CUSTOMER_ID + i + 1);
  beforeAll(async () => {
    await suspendGMProcessing();

    await resetTestState(db);
    for (const id of ALL_POSSIBLE_IDS) {
      await clearMockStats(db, id);
      await cleanupCustomerData(db, id);
    }
  });

  afterEach(async () => {
    for (const id of customerIdsToCleanup) {
      await clearMockStats(db, id);
      await cleanupCustomerData(db, id);
    }
    customerIdsToCleanup.length = 0;
  });

  it('should bill February usage when periodic job runs on March 1 (non-leap year 2025)', async () => {
    clock.setTime(new Date('2025-02-15T12:00:00Z'));
    const customerId = await createTestCustomer(clock);
    customerIdsToCleanup.push(customerId);

    await db.insert(billingRecords).values({
      customerId,
      billingPeriodStart: new Date('2025-03-01T00:00:00Z'),
      billingPeriodEnd: new Date('2025-03-31T23:59:59Z'),
      amountUsdCents: PRO_PRICE,
      type: 'charge',
      status: 'draft',
      createdAt: clock.now(),
    });

    await insertMockStats(db, customerId, {
      serviceType: 1,
      network: 1,
      timestamp: new Date('2025-02-15T12:00:00Z'),
      billableRequests: 5000,
    });

    clock.setTime(new Date('2025-03-01T00:05:00Z'));
    const jobResult = await runPeriodicJobForCustomer(db, customerId, config, paymentServices);

    expect(jobResult.phases.billing.executed).toBe(true);

    // Find the paid invoice (original draft was transitioned to paid)
    const paidInvoices = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, customerId));
    const paidInvoice = paidInvoices.find(i => i.status === 'paid');
    expect(paidInvoice).toBeDefined();

    const lineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, paidInvoice!.id),
    });
    const usageLineItem = lineItems.find(li => li.itemType === 'requests');

    expect(usageLineItem).toBeDefined();
    expect(usageLineItem?.quantity).toBe(5000);
    expect(usageLineItem?.serviceType).toBe('seal');
  });

  it('should bill February usage including leap day (leap year 2024)', async () => {
    clock.setTime(new Date('2024-02-15T12:00:00Z'));
    const customerId = await createTestCustomer(clock);
    customerIdsToCleanup.push(customerId);

    await db.insert(billingRecords).values({
      customerId,
      billingPeriodStart: new Date('2024-03-01T00:00:00Z'),
      billingPeriodEnd: new Date('2024-03-31T23:59:59Z'),
      amountUsdCents: PRO_PRICE,
      type: 'charge',
      status: 'draft',
      createdAt: clock.now(),
    });

    // Leap day usage + mid-month usage
    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2024-02-29T12:00:00Z'),
      billableRequests: 3000,
    });
    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2024-02-15T12:00:00Z'),
      billableRequests: 2000,
    });

    clock.setTime(new Date('2024-03-01T00:05:00Z'));
    const jobResult = await runPeriodicJobForCustomer(db, customerId, config, paymentServices);

    expect(jobResult.phases.billing.executed).toBe(true);

    const paidInvoices = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, customerId));
    const paidInvoice = paidInvoices.find(i => i.status === 'paid');
    expect(paidInvoice).toBeDefined();

    const lineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, paidInvoice!.id),
    });
    const usageLineItem = lineItems.find(li => li.itemType === 'requests');

    expect(usageLineItem).toBeDefined();
    expect(usageLineItem?.quantity).toBe(5000);
  });

  it('should bill December 2024 usage on January 1, 2025 (year boundary)', async () => {
    clock.setTime(new Date('2024-12-15T12:00:00Z'));
    const customerId = await createTestCustomer(clock);
    customerIdsToCleanup.push(customerId);

    await db.insert(billingRecords).values({
      customerId,
      billingPeriodStart: new Date('2025-01-01T00:00:00Z'),
      billingPeriodEnd: new Date('2025-01-31T23:59:59Z'),
      amountUsdCents: PRO_PRICE,
      type: 'charge',
      status: 'draft',
      createdAt: clock.now(),
    });

    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2024-12-20T12:00:00Z'),
      billableRequests: 7000,
    });

    clock.setTime(new Date('2025-01-01T00:05:00Z'));
    const jobResult = await runPeriodicJobForCustomer(db, customerId, config, paymentServices);

    expect(jobResult.phases.billing.executed).toBe(true);

    const paidInvoices = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, customerId));
    const paidInvoice = paidInvoices.find(i => i.status === 'paid');
    expect(paidInvoice).toBeDefined();

    const lineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, paidInvoice!.id),
    });
    const usageLineItem = lineItems.find(li => li.itemType === 'requests');

    expect(usageLineItem).toBeDefined();
    expect(usageLineItem?.quantity).toBe(7000);
  });

  it('should NOT include new month usage in previous month billing', async () => {
    clock.setTime(new Date('2025-01-31T23:00:00Z'));
    const customerId = await createTestCustomer(clock);
    customerIdsToCleanup.push(customerId);

    await db.insert(billingRecords).values({
      customerId,
      billingPeriodStart: new Date('2025-02-01T00:00:00Z'),
      billingPeriodEnd: new Date('2025-02-28T23:59:59Z'),
      amountUsdCents: PRO_PRICE,
      type: 'charge',
      status: 'draft',
      createdAt: clock.now(),
    });

    // January usage (should be billed)
    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2025-01-15T12:00:00Z'),
      billableRequests: 4000,
    });

    // February usage (should NOT be billed)
    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2025-02-01T00:00:00Z'),
      billableRequests: 1000,
    });

    clock.setTime(new Date('2025-02-01T01:00:00Z'));
    const jobResult = await runPeriodicJobForCustomer(db, customerId, config, paymentServices);

    expect(jobResult.phases.billing.executed).toBe(true);

    const paidInvoices = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, customerId));
    const paidInvoice = paidInvoices.find(i => i.status === 'paid');
    expect(paidInvoice).toBeDefined();

    const lineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, paidInvoice!.id),
    });
    const usageLineItem = lineItems.find(li => li.itemType === 'requests');

    expect(usageLineItem).toBeDefined();
    expect(usageLineItem?.quantity).toBe(4000);
  });

  it('should bill January usage even when processing is delayed (edge case)', async () => {
    clock.setTime(new Date('2025-01-15T12:00:00Z'));
    const customerId = await createTestCustomer(clock);
    customerIdsToCleanup.push(customerId);

    await db.insert(billingRecords).values({
      customerId,
      billingPeriodStart: new Date('2025-02-01T00:00:00Z'),
      billingPeriodEnd: new Date('2025-02-28T23:59:59Z'),
      amountUsdCents: PRO_PRICE,
      type: 'charge',
      status: 'draft',
      createdAt: clock.now(),
    });

    // January usage (should be billed)
    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2025-01-20T12:00:00Z'),
      billableRequests: 8000,
    });

    // February usage (should NOT be billed)
    await insertMockStats(db, customerId, {
      serviceType: 1, network: 1,
      timestamp: new Date('2025-02-15T12:00:00Z'),
      billableRequests: 2000,
    });

    // Delayed: set to Feb 1 for monthly billing trigger
    clock.setTime(new Date('2025-02-01T00:05:00Z'));
    const jobResult = await runPeriodicJobForCustomer(db, customerId, config, paymentServices);

    expect(jobResult.phases.billing.executed).toBe(true);

    const paidInvoices = await db.select().from(billingRecords)
      .where(eq(billingRecords.customerId, customerId));
    const paidInvoice = paidInvoices.find(i => i.status === 'paid');
    expect(paidInvoice).toBeDefined();

    const lineItems = await db.query.invoiceLineItems.findMany({
      where: eq(invoiceLineItems.billingRecordId, paidInvoice!.id),
    });
    const usageLineItem = lineItems.find(li => li.itemType === 'requests');

    expect(usageLineItem).toBeDefined();
    expect(usageLineItem?.quantity).toBe(8000);
  });
});
