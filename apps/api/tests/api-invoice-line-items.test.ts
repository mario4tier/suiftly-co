/**
 * API Test: Invoice Line Items
 *
 * Tests the stats → invoice integration:
 * - Usage logs appear as usage line items in DRAFT invoices
 * - Line items have correct itemType, quantity, and pricing
 * - formatLineItemDescription() produces correct UI text
 * - Platform subscription line items show correct tier amounts
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
  trpcMutation,
  resetTestData,
  subscribeAndEnable,
  subscribePlatform,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { INVOICE_LINE_ITEM_TYPE, SERVICE_TYPE } from '@suiftly/shared/constants';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

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
  const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter;
  const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro;


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

    // Ensure balance BEFORE subscribing to platform (so escrow payment method exists)
    await ensureTestBalance(100, { walletAddress: TEST_WALLET });

    await setClockTime('2024-01-01T00:00:00Z');
    await subscribePlatform(accessToken);
    // Seal/grpc/graphql are auto-provisioned (disabled) after platform subscribe

    // Restore clock to mid-month (usage tests insert logs at 2024-01-15T11:00:00Z
    // and expect the clock to be at 12:00 so the bucket is in the past)
    await setClockTime('2024-01-15T12:00:00Z');
  });

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
    await clearLogs();
  });

  describe('Usage Line Items in DRAFT Invoice', () => {
    it('should include usage charges in getNextScheduledPayment after syncing logs', async () => {
      // Enable the auto-provisioned seal service for usage tracking
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
      expect(usageItem.unitPriceUsd).toBeCloseTo(0.0001, 6);
      expect(usageItem.amountUsd).toBeCloseTo(1.55, 2);
    }, 15000); // 15 second timeout

    it('should show zero usage when no logs exist', async () => {
      // Enable seal for usage queries
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

      // Platform subscription line item should exist
      const platformSubItem = lineItems.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER && item.service === SERVICE_TYPE.PLATFORM
      );
      expect(platformSubItem).toBeDefined();
      expect(platformSubItem.service).toBe(SERVICE_TYPE.PLATFORM);
      expect(platformSubItem.amountUsd).toBe(STARTER_PRICE / 100); // $2 for Platform Starter
    }, 15000);

    it('should calculate usage correctly for high volume (50,000 requests = $5.00)', async () => {
      // Enable seal for usage tracking
      await subscribeAndEnable('seal', 'starter', accessToken);

      // ---- Insert 50,000 billable requests using pre-aggregation ----
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
    it('should include platform Pro subscription in DRAFT line items', async () => {
      // Upgrade platform to Pro tier to test Pro subscription line item
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );
      expect(upgradeResult.result?.data?.success).toBe(true);

      // ---- Get next scheduled payment ----
      const paymentResult = await trpcQuery<any>(
        'billing.getNextScheduledPayment',
        undefined,
        accessToken
      );

      const lineItems = paymentResult.result?.data?.lineItems;

      // Find platform Pro subscription line item
      const subscriptionItem = lineItems?.find(
        (item: any) => item.itemType === INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO && item.service === SERVICE_TYPE.PLATFORM
      );

      expect(subscriptionItem).toBeDefined();
      expect(subscriptionItem.service).toBe(SERVICE_TYPE.PLATFORM);
      expect(subscriptionItem.quantity).toBe(1);
      expect(subscriptionItem.unitPriceUsd).toBe(PRO_PRICE / 100); // $39 for Platform Pro
      expect(subscriptionItem.amountUsd).toBe(PRO_PRICE / 100);
    }, 15000);
  });
});
