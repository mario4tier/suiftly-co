/**
 * API Test: Invoice Line Items
 *
 * Tests the stats → invoice integration:
 * - Usage logs appear as usage line items in DRAFT invoices
 * - Line items have correct itemType, quantity, and pricing
 * - formatLineItemDescription() produces correct UI text
 *
 * See STATS_DESIGN.md and invoice-formatter.ts for implementation details.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcQuery,
  resetTestData,
  subscribeAndEnable,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { INVOICE_LINE_ITEM_TYPE, SERVICE_TYPE } from '@suiftly/shared/constants';

const API_BASE = 'http://localhost:22700';

/**
 * Insert mock HAProxy logs via test endpoint
 */
async function insertMockLogs(options: {
  customerId: number;
  serviceType: number;
  count: number;
  timestamp: string;
  statusCode?: number;
  trafficType?: number;
  refreshAggregate?: boolean;
  /** Pre-aggregated repeat count - each row represents this many requests */
  repeat?: number;
}): Promise<{ success: boolean; inserted?: number; error?: string }> {
  const response = await fetch(`${API_BASE}/test/stats/mock-logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return response.json() as Promise<{ success: boolean; inserted?: number; error?: string }>;
}

/**
 * Sync usage to DRAFT invoice via test endpoint
 */
async function syncUsageToDraft(customerId: number): Promise<{ success: boolean; error?: string }> {
  const response = await fetch(`${API_BASE}/test/stats/sync-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId }),
  });
  return response.json() as Promise<{ success: boolean; error?: string }>;
}

/**
 * Clear all HAProxy logs via test endpoint
 */
async function clearLogs(): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}/test/stats/clear-logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return response.json() as Promise<{ success: boolean }>;
}

describe('API: Invoice Line Items', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset clock to a known time (mid-month)
    await setClockTime('2024-01-15T12:00:00Z');

    // Reset test data
    await resetTestData(TEST_WALLET);

    // Clear existing logs
    await clearLogs();

    // Login and create customer
    accessToken = await login(TEST_WALLET);

    // Get customer ID
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;

    // Ensure balance for subscription
    await ensureTestBalance(100, { walletAddress: TEST_WALLET });
  });

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
    await clearLogs();
  });

  describe('Usage Line Items in DRAFT Invoice', () => {
    it('should include usage charges in getNextScheduledPayment after syncing logs', async () => {
      // ---- Setup: Subscribe to Seal Starter ----
      await subscribeAndEnable('seal', 'starter', accessToken);

      // ---- Insert mock usage logs: 15,500 billable requests ----
      // Note: Insert at 11:00 and clock is at 12:00, so bucket (11:00) < now (12:00)
      const insertResult = await insertMockLogs({
        customerId,
        serviceType: 1, // seal
        count: 15500,
        timestamp: '2024-01-15T11:00:00Z', // 1 hour before clock time
        trafficType: 1, // billable
        refreshAggregate: true,
      });
      expect(insertResult.success).toBe(true);

      // ---- Sync usage to DRAFT invoice ----
      const syncResult = await syncUsageToDraft(customerId);
      expect(syncResult.success).toBe(true);

      // ---- Get next scheduled payment ----
      const paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      // Access response data (tRPC returns { result: { data: ... } })
      const lineItems = paymentResult.result?.data?.lineItems;
      expect(lineItems).toBeDefined();
      expect(lineItems.length).toBeGreaterThanOrEqual(1);

      // Find the usage line item
      const usageItem = lineItems.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.REQUESTS
      );

      expect(usageItem).toBeDefined();
      expect(usageItem.service).toBe(SERVICE_TYPE.SEAL);
      expect(usageItem.quantity).toBe(15500);

      // Verify pricing: 15500 requests @ $0.0001/req = $1.55
      // unitPriceUsd = cents per 1000 / 100 / 1000 = 10 / 100 / 1000 = 0.0001
      expect(usageItem.unitPriceUsd).toBeCloseTo(0.0001, 6);
      expect(usageItem.amountUsd).toBeCloseTo(1.55, 2);
    }, 15000); // 15 second timeout

    it('should show zero usage when no logs exist', async () => {
      // ---- Setup: Subscribe to Seal Starter ----
      await subscribeAndEnable('seal', 'starter', accessToken);

      // ---- Sync empty usage to DRAFT invoice ----
      const syncResult = await syncUsageToDraft(customerId);
      expect(syncResult.success).toBe(true);

      // ---- Get next scheduled payment ----
      const paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      const lineItems = paymentResult.result?.data?.lineItems;
      expect(lineItems).toBeDefined();

      // Find the usage line item (may or may not exist with quantity 0)
      const usageItem = lineItems.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.REQUESTS
      );

      // Either no usage item, or it has quantity 0
      if (usageItem) {
        expect(usageItem.quantity).toBe(0);
        expect(usageItem.amountUsd).toBe(0);
      }

      // Should have subscription line item
      const subscriptionItem = lineItems.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER
      );
      expect(subscriptionItem).toBeDefined();
      expect(subscriptionItem.service).toBe(SERVICE_TYPE.SEAL);
      expect(subscriptionItem.amountUsd).toBe(9); // $9 for Starter
    }, 15000);

    it('should calculate usage correctly for high volume (50,000 requests = $5.00)', async () => {
      // ---- Setup: Subscribe and enable ----
      await subscribeAndEnable('seal', 'starter', accessToken);

      // ---- Insert 50,000 billable requests using pre-aggregation ----
      // Uses repeat field (production HAProxy feature) instead of 50k individual rows.
      // The continuous aggregate uses SUM(repeat) so behavior is identical.
      // Note: Insert at 11:00 and clock is at 12:00, so bucket (11:00) < now (12:00)
      const insertResult = await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 1,
        repeat: 50000, // Pre-aggregated: 1 row representing 50,000 requests
        timestamp: '2024-01-15T11:00:00Z', // 1 hour before clock time
        trafficType: 1,
        refreshAggregate: true,
      });
      expect(insertResult.success).toBe(true);

      // ---- Sync and verify ----
      await syncUsageToDraft(customerId);

      const paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      const lineItems = paymentResult.result?.data?.lineItems;
      const usageItem = lineItems?.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.REQUESTS
      );

      expect(usageItem).toBeDefined();
      expect(usageItem.quantity).toBe(50000);
      // 50,000 * $0.0001 = $5.00
      expect(usageItem.amountUsd).toBeCloseTo(5.00, 2);
    });
  });

  describe('Subscription Line Items', () => {
    it('should include correct tier subscription in DRAFT line items', async () => {
      // ---- Subscribe to Pro tier ----
      await subscribeAndEnable('seal', 'pro', accessToken);

      // ---- Get next scheduled payment ----
      const paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      const lineItems = paymentResult.result?.data?.lineItems;

      // Find subscription line item
      const subscriptionItem = lineItems?.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO
      );

      expect(subscriptionItem).toBeDefined();
      expect(subscriptionItem.service).toBe(SERVICE_TYPE.SEAL);
      expect(subscriptionItem.quantity).toBe(1);
      expect(subscriptionItem.unitPriceUsd).toBe(29); // $29 for Pro
      expect(subscriptionItem.amountUsd).toBe(29);
    }, 15000);
  });
});
