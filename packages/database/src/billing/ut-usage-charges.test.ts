/**
 * Usage Charges Unit Tests (STATS_DESIGN.md D3)
 *
 * TDD tests for adding usage charges to DRAFT invoices.
 * Tests the integration between stats and billing systems.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '../db';
import { customers, serviceInstances, billingRecords, invoiceLineItems } from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { eq, and, sql } from 'drizzle-orm';
import {
  insertMockHAProxyLogs,
  refreshStatsAggregate,
  clearAllLogs,
} from '../stats/test-helpers';
import {
  addUsageChargesToDraft,
  type UsageChargeResult,
} from './usage-charges';

// Test customer data
const TEST_CUSTOMER_ID = 99902;
const TEST_WALLET = '0x' + 'b'.repeat(64);

describe('Usage Charges', () => {
  let clock: MockDBClock;
  let testInvoiceId: string;

  beforeAll(async () => {
    // Create test customer
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
  });

  beforeEach(async () => {
    // Reset clock to 1st of month (billing day)
    clock = new MockDBClock({ currentTime: new Date('2024-02-01T00:00:00Z') });

    // Clear logs and refresh aggregate to ensure clean state
    await clearAllLogs(db);
    await refreshStatsAggregate(db);

    // Clear line items and billing records
    await db.execute(sql`DELETE FROM invoice_line_items WHERE billing_record_id IN (
      SELECT id FROM billing_records WHERE customer_id = ${TEST_CUSTOMER_ID}
    )`);
    await db.execute(sql`DELETE FROM billing_records WHERE customer_id = ${TEST_CUSTOMER_ID}`);

    // Reset last_billed_timestamp
    await db.execute(sql`
      UPDATE service_instances
      SET last_billed_timestamp = NULL
      WHERE customer_id = ${TEST_CUSTOMER_ID}
    `);

    // Create a fresh DRAFT invoice for each test
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
    // Cleanup test data
    await clearAllLogs(db);
    await db.execute(sql`DELETE FROM invoice_line_items WHERE billing_record_id IN (
      SELECT id FROM billing_records WHERE customer_id = ${TEST_CUSTOMER_ID}
    )`);
    await db.execute(sql`DELETE FROM billing_records WHERE customer_id = ${TEST_CUSTOMER_ID}`);
    await db.execute(sql`DELETE FROM service_instances WHERE customer_id = ${TEST_CUSTOMER_ID}`);
    await db.execute(sql`DELETE FROM customers WHERE customer_id = ${TEST_CUSTOMER_ID}`);
  });

  describe('addUsageChargesToDraft', () => {
    it('should add no line items when no usage exists', async () => {
      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
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
      // Insert 10,000 billable requests in January
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1, // Seal
        network: 1,
        count: 10000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
        trafficType: 1, // guaranteed = billable
      });
      await refreshStatsAggregate(db);

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      expect(result.success).toBe(true);
      expect(result.lineItemsAdded).toBe(1);
      expect(result.totalUsageChargesCents).toBeGreaterThan(0);

      // Verify line item created
      const lineItems = await db.query.invoiceLineItems.findMany({
        where: eq(invoiceLineItems.billingRecordId, testInvoiceId),
      });
      expect(lineItems.length).toBe(1);
      expect(lineItems[0].description).toContain('Usage');
      expect(lineItems[0].serviceType).toBe('seal');
    });

    it('should not count non-billable requests (traffic_type > 2)', async () => {
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

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      // Should only charge for 5000 requests
      expect(result.requestCounts).toBeDefined();
      expect(result.requestCounts?.seal).toBe(5000);
    });

    it('should update last_billed_timestamp on service instance', async () => {
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 1000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      await addUsageChargesToDraft(db, TEST_CUSTOMER_ID, testInvoiceId, clock);

      // Verify last_billed_timestamp was updated
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, TEST_CUSTOMER_ID),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      expect(service?.lastBilledTimestamp).toBeDefined();
      expect(service?.lastBilledTimestamp?.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    });

    it('should only include requests after last_billed_timestamp', async () => {
      // Set last_billed_timestamp to middle of January
      await db.execute(sql`
        UPDATE service_instances
        SET last_billed_timestamp = '2024-01-15T00:00:00Z'
        WHERE customer_id = ${TEST_CUSTOMER_ID} AND service_type = 'seal'
      `);

      // Insert requests before cutoff (should NOT be billed)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 5000,
        timestamp: new Date('2024-01-10T12:00:00Z'),
      });

      // Insert requests after cutoff (should be billed)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 3000,
        timestamp: new Date('2024-01-20T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      // Should only count 3000 requests (after cutoff)
      expect(result.requestCounts?.seal).toBe(3000);
    });

    it('should handle multiple service types', async () => {
      // Insert logs for Seal service
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 2000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });

      // Insert logs for SSFN service (service type 2)
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

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
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

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      // Verify invoice amount was updated
      const invoice = await db.query.billingRecords.findFirst({
        where: eq(billingRecords.id, testInvoiceId),
      });

      expect(Number(invoice?.amountUsdCents)).toBe(result.totalUsageChargesCents);
    });
  });

  describe('Pricing calculations', () => {
    it('should apply correct per-request pricing for Seal', async () => {
      // Assuming $0.001 per request (0.1 cents)
      // 10,000 requests = $10 = 1000 cents
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 10000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      // Verify pricing is applied (exact rate TBD)
      expect(result.totalUsageChargesCents).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty billing period gracefully', async () => {
      // No logs inserted
      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      expect(result.success).toBe(true);
      expect(result.totalUsageChargesCents).toBe(0);
    });

    it('should handle non-existent invoice', async () => {
      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        '00000000-0000-0000-0000-000000000000', // Non-existent
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should not add charges to non-DRAFT invoice', async () => {
      // Change invoice to PENDING
      await db.update(billingRecords)
        .set({ status: 'pending' })
        .where(eq(billingRecords.id, testInvoiceId));

      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 1000,
        timestamp: new Date('2024-01-15T12:00:00Z'),
      });
      await refreshStatsAggregate(db);

      const result = await addUsageChargesToDraft(
        db,
        TEST_CUSTOMER_ID,
        testInvoiceId,
        clock
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in draft');
    });
  });
});
