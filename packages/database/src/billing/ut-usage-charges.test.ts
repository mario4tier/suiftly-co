/**
 * Usage Charges Unit Tests (STATS_DESIGN.md D3)
 *
 * TDD tests for updating usage charges on DRAFT invoices.
 * Tests the integration between stats and billing systems.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '../db';
import { customers, serviceInstances, billingRecords, invoiceLineItems } from '../schema';
import { eq, sql } from 'drizzle-orm';
import {
  insertMockHAProxyLogs,
  refreshStatsAggregate,
  clearAllStats,
} from '../stats/test-helpers';
import { updateUsageChargesToDraft } from './usage-charges';
import { ensureEscrowPaymentMethod, cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';
import { withCustomerLock, type LockedTransaction } from '../locking';

// Test customer data — wallet must be unique across ALL test files
const TEST_CUSTOMER_ID = 99902;
const TEST_WALLET = '0x' + 'b'.repeat(62) + '02';

describe('Usage Charges', () => {
  let testInvoiceId: number;

  /**
   * Run test logic inside a customer advisory lock, resetting the DRAFT invoice
   * to a clean state first. The GM process runs concurrently and can change DRAFT
   * status to 'failed'; this helper prevents that interference.
   */
  async function withCleanDraft<T>(
    fn: (tx: LockedTransaction) => Promise<T>,
  ): Promise<T> {
    return withCustomerLock(db, TEST_CUSTOMER_ID, async (tx) => {
      // Undo any GM modifications: delete child records and restore draft status
      await tx.execute(sql`DELETE FROM invoice_payments WHERE billing_record_id = ${testInvoiceId}`);
      await tx.execute(sql`DELETE FROM billing_idempotency WHERE billing_record_id = ${testInvoiceId}`);
      await tx.execute(sql`DELETE FROM invoice_line_items WHERE billing_record_id = ${testInvoiceId}`);
      await tx.execute(sql`UPDATE billing_records SET status = 'draft', amount_usd_cents = 0 WHERE id = ${testInvoiceId}`);
      return fn(tx);
    });
  }

  beforeAll(async () => {
    await suspendGMProcessing();

    await resetTestState(db);

    // Defensive cleanup: remove stale data from previous crashed runs
    await cleanupCustomerData(db, TEST_CUSTOMER_ID);

    // Clean up any stale data from previous runs, then create test customer
    await db.execute(sql`DELETE FROM customers WHERE wallet_address = ${TEST_WALLET} AND customer_id != ${TEST_CUSTOMER_ID}`);
    await db.execute(sql`
      INSERT INTO customers (customer_id, wallet_address, status)
      VALUES (${TEST_CUSTOMER_ID}, ${TEST_WALLET}, 'active')
      ON CONFLICT (customer_id) DO NOTHING
    `);

    // Create service instance
    await db.execute(sql`
      INSERT INTO service_instances (customer_id, service_type, state, tier)
      VALUES (${TEST_CUSTOMER_ID}, 'seal', 'enabled', 'starter')
      ON CONFLICT (customer_id, service_type) DO NOTHING
    `);

    // Ensure escrow payment method exists for provider chain
    await ensureEscrowPaymentMethod(db, TEST_CUSTOMER_ID);
  });

  beforeEach(async () => {
    // Clear logs and refresh aggregate to ensure clean state
    await clearAllStats(db);
    await refreshStatsAggregate(db);

    // Clear line items and billing records
    await db.execute(sql`DELETE FROM invoice_line_items WHERE billing_record_id IN (
      SELECT id FROM billing_records WHERE customer_id = ${TEST_CUSTOMER_ID}
    )`);
    await db.execute(sql`DELETE FROM billing_records WHERE customer_id = ${TEST_CUSTOMER_ID}`);

    // Create a fresh DRAFT invoice for each test
    // Billing period: January 2024 (Jan 1 to Feb 1)
    const result = await db.insert(billingRecords).values({
      customerId: TEST_CUSTOMER_ID,
      billingPeriodStart: new Date('2024-01-01T00:00:00Z'),
      billingPeriodEnd: new Date('2024-02-01T00:00:00Z'),
      amountUsdCents: 0, // Will be updated with usage
      type: 'charge',
      status: 'draft',
    }).returning({ id: billingRecords.id });

    testInvoiceId = result[0].id;
  });

  afterAll(async () => {
    await clearAllStats(db);
    await cleanupCustomerData(db, TEST_CUSTOMER_ID);
  });

  describe('updateUsageChargesToDraft', () => {
    it('should add no line items when no usage exists', async () => {
      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      expect(result.success).toBe(true);
      expect(result.totalUsageChargesCents).toBe(0);
      expect(result.lineItemsAdded).toBe(0);

      // Verify no line items created
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, testInvoiceId),
      });
      expect(lineItems.length).toBe(0);
    });

    it('should add usage line item for billable requests', async () => {
      // Insert 10,000 billable requests in January (within billing period)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1, // Seal
        network: 1,
        count: 10000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
        trafficType: 1, // guaranteed = billable
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      expect(result.success).toBe(true);
      expect(result.lineItemsAdded).toBe(1);
      expect(result.totalUsageChargesCents).toBeGreaterThan(0);

      // Verify line item created
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, testInvoiceId),
      });
      expect(lineItems.length).toBe(1);
      expect(lineItems[0].itemType).toBe('requests');
      expect(lineItems[0].serviceType).toBe('seal');
    });

    it.skip('should not count non-billable requests (traffic_type > 2)', async () => {
      // Insert billable requests
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 5000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
        trafficType: 1, // billable
      });

      // Insert non-billable requests (denied)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 3000,
        timestamp: new Date('2024-01-15T13:00:00Z'),
        trafficType: 3, // denied - not billable
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Should only charge for 5000 requests
      expect(result.requestCounts).toBeDefined();
      expect(result.requestCounts?.seal).toBe(5000);
    });

    it.skip('should handle multiple service types', async () => {
      // Insert logs for Seal service
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 2000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });

      // Insert logs for gRPC service (service type 2)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 2,
        network: 1,
        count: 1000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      // Create service instance for service type 2
      await db.execute(sql`
        INSERT INTO service_instances (customer_id, service_type, state, tier)
        VALUES (${TEST_CUSTOMER_ID}, 'grpc', 'enabled', 'starter')
        ON CONFLICT (customer_id, service_type) DO NOTHING
      `);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Should have line items for both services
      expect(result.lineItemsAdded).toBe(2);
      expect(result.requestCounts?.seal).toBe(2000);
      expect(result.requestCounts?.grpc).toBe(1000);

      // Cleanup extra service
      await db.execute(sql`
        DELETE FROM service_instances
        WHERE customer_id = ${TEST_CUSTOMER_ID} AND service_type = 'grpc'
      `);
    });

    it('should update invoice total amount', async () => {
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 10000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Verify invoice amount was updated
      const invoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, testInvoiceId),
      });

      expect(Number(invoice?.amountUsdCents)).toBe(result.totalUsageChargesCents);
    });
  });

  describe('Idempotency', () => {
    it('should be idempotent - calling twice produces same result', async () => {
      // Insert billable requests
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 5000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      // Both calls inside one lock to prevent GM interference between them
      const { result1, result2 } = await withCleanDraft(async (tx) => {
        const r1 = await updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId);
        const r2 = await updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId);
        return { result1: r1, result2: r2 };
      });

      // Both results should be identical
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.totalUsageChargesCents).toBe(result2.totalUsageChargesCents);
      expect(result1.lineItemsAdded).toBe(result2.lineItemsAdded);

      // Verify only ONE line item exists (not duplicated)
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, testInvoiceId),
      });
      expect(lineItems.length).toBe(1);
    });

    it('should update usage when called with new data', async () => {
      // Insert initial requests
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 3000,
        timestamp: new Date('2024-01-10T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      // First call (lock prevents GM from modifying the draft)
      const result1 = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );
      expect(result1.requestCounts?.seal).toBe(3000);

      // Insert more requests (same billing period)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 2000,
        timestamp: new Date('2024-01-20T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      // Second call - should now include ALL requests (reset undoes any GM interference)
      const result2 = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );
      expect(result2.requestCounts?.seal).toBe(5000); // 3000 + 2000

      // Still only ONE line item
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, testInvoiceId),
      });
      expect(lineItems.length).toBe(1);
    });
  });

  describe('Billing period boundaries', () => {
    it('should NOT count requests before billingPeriodStart', async () => {
      // Insert requests BEFORE the billing period (December 2023)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 5000,
        timestamp: new Date('2023-12-25T12:00:00Z'), // Before Jan 1
      });

      // Insert requests WITHIN the billing period (January 2024)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 3000,
        timestamp: new Date('2024-01-15T12:00:00Z'), // Within Jan
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Should only count 3000 requests (within billing period)
      expect(result.requestCounts?.seal).toBe(3000);
    });

    it('should NOT count requests at or after billingPeriodEnd', async () => {
      // Insert requests WITHIN the billing period
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 3000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });

      // Insert requests AFTER the billing period (February 2024)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 5000,
        timestamp: new Date('2024-02-05T12:00:00Z'), // After Feb 1
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Should only count 3000 requests (within billing period)
      expect(result.requestCounts?.seal).toBe(3000);
    });

    it('should count requests at exactly billingPeriodStart', async () => {
      // Insert requests at EXACTLY the billing period start
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 1000,
        timestamp: new Date('2024-01-01T00:00:00Z'), // Exactly at start
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Should count requests at exactly the start (>= start)
      expect(result.requestCounts?.seal).toBe(1000);
    });

    it('should NOT count requests at exactly billingPeriodEnd', async () => {
      // Insert requests WITHIN the billing period
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 2000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });

      // Insert requests at EXACTLY the billing period end
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 1000,
        timestamp: new Date('2024-02-01T00:00:00Z'), // Exactly at end
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Should NOT count requests at exactly the end (< end, not <=)
      expect(result.requestCounts?.seal).toBe(2000);
    });
  });

  describe('Pricing calculations', () => {
    it('should apply correct per-request pricing for Seal', async () => {
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 10000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      // Verify pricing is applied (exact rate TBD)
      expect(result.totalUsageChargesCents).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty billing period gracefully', async () => {
      // No logs inserted
      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId)
      );

      expect(result.success).toBe(true);
      expect(result.totalUsageChargesCents).toBe(0);
    });

    it('should handle non-existent invoice', async () => {
      const result = await withCleanDraft((tx) =>
        updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, 999999999)
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should not add charges to non-DRAFT invoice', async () => {
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 1000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      // Set to PENDING inside lock to prevent GM from changing it
      const result = await withCustomerLock(db, TEST_CUSTOMER_ID, async (tx) => {
        await tx.update(billingRecords)
          .set({ status: 'pending' })
          .where(eq(billingRecords.id, testInvoiceId));
        return updateUsageChargesToDraft(tx, TEST_CUSTOMER_ID, testInvoiceId);
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in draft');
    });
  });
});
