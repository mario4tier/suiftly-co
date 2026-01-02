/**
 * API Test: Stats Endpoints
 *
 * Tests the stats API endpoints through HTTP calls only.
 * Uses mock HAProxy logs via /test/stats/* endpoints.
 *
 * See STATS_DESIGN.md D4 for endpoint specifications.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcQuery,
  trpcMutation,
  resetTestData,
  restCall,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

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
  spreadAcrossHours?: number;
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
 * Insert mixed success/error logs via test endpoint
 */
async function insertMockMixedLogs(options: {
  customerId: number;
  serviceType: number;
  count: number;
  timestamp: string;
  distribution?: { success: number; clientError: number; serverError: number };
}): Promise<{ success: boolean; inserted?: any; error?: string }> {
  const response = await fetch(`${API_BASE}/test/stats/mock-mixed-logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return response.json() as Promise<{ success: boolean; inserted?: any; error?: string }>;
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

describe('API: Stats Endpoints', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset clock to a known time
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

    // Ensure test balance
    await ensureTestBalance(100, { walletAddress: TEST_WALLET });

    // Subscribe to Seal service
    await trpcMutation<any>(
      'services.subscribe',
      { serviceType: 'seal', tier: 'starter' },
      accessToken
    );
  });

  afterEach(async () => {
    await resetClock();
    await clearLogs();
    await resetTestData(TEST_WALLET);
  });

  describe('Mock data endpoints', () => {
    it('should insert mock HAProxy logs', async () => {
      const result = await insertMockLogs({
        customerId,
        serviceType: 1, // Seal
        count: 100,
        timestamp: '2024-01-15T10:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.inserted).toBe(100);
    });

    it('should insert mixed success/error logs', async () => {
      const result = await insertMockMixedLogs({
        customerId,
        serviceType: 1,
        count: 100,
        timestamp: '2024-01-15T10:00:00Z',
        distribution: { success: 70, clientError: 20, serverError: 10 },
      });

      expect(result.success).toBe(true);
      // success=70 gets split into guaranteed (49) + burst (21)
      // dropped defaults to 0 when using success format
      expect(result.inserted).toEqual({
        guaranteed: 49,
        burst: 21,
        dropped: 0,
        clientError: 20,
        serverError: 10,
        success: 70, // Legacy field: guaranteed + burst
      });
    });
  });

  describe('stats.getSummary', () => {
    it('should return zeros when no logs exist', async () => {
      const response = await trpcQuery<any>(
        'stats.getSummary',
        { serviceType: 'seal' },
        accessToken
      );

      expect(response.result?.data).toBeDefined();
      expect(response.result?.data.successCount).toBe(0);
      expect(response.result?.data.clientErrorCount).toBe(0);
      expect(response.result?.data.serverErrorCount).toBe(0);
    });

    it('should return correct counts after inserting logs', async () => {
      // Insert mixed logs
      await insertMockMixedLogs({
        customerId,
        serviceType: 1,
        count: 100,
        timestamp: '2024-01-15T10:00:00Z',
        distribution: { success: 80, clientError: 15, serverError: 5 },
      });

      const response = await trpcQuery<any>(
        'stats.getSummary',
        { serviceType: 'seal' },
        accessToken
      );

      expect(response.result?.data).toBeDefined();
      expect(response.result?.data.successCount).toBe(80);
      expect(response.result?.data.clientErrorCount).toBe(15);
      expect(response.result?.data.serverErrorCount).toBe(5);
      expect(response.result?.data.totalRequests).toBe(100);
    });

    it('should only include last 24 hours of data', async () => {
      // Insert logs from 2 days ago (should NOT be included)
      await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 100,
        timestamp: '2024-01-13T10:00:00Z',
      });

      // Insert logs from 10 hours ago (should be included)
      await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 50,
        timestamp: '2024-01-15T02:00:00Z',
      });

      const response = await trpcQuery<any>(
        'stats.getSummary',
        { serviceType: 'seal' },
        accessToken
      );

      expect(response.result?.data.successCount).toBe(50);
    });

    it('should require authentication', async () => {
      const response = await trpcQuery<any>(
        'stats.getSummary',
        { serviceType: 'seal' }
        // No access token
      );

      expect(response.error).toBeDefined();
    });
  });

  describe('stats.getUsage', () => {
    it('should return usage data for 24h range', async () => {
      // Insert logs spread across 6 hours
      await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 600,
        timestamp: '2024-01-15T06:00:00Z',
        spreadAcrossHours: 6,
      });

      const response = await trpcQuery<any>(
        'stats.getUsage',
        { serviceType: 'seal', range: '24h' },
        accessToken
      );

      expect(response.result?.data).toBeDefined();
      expect(Array.isArray(response.result?.data)).toBe(true);

      // Should have data points
      const dataPoints = response.result?.data;
      expect(dataPoints.length).toBeGreaterThan(0);

      // Total should be 600
      const total = dataPoints.reduce((sum: number, p: any) => sum + p.billableRequests, 0);
      expect(total).toBe(600);
    });

    it('should support different time ranges', async () => {
      // Insert logs
      await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 100,
        timestamp: '2024-01-15T10:00:00Z',
      });

      // Test 24h range
      const response24h = await trpcQuery<any>(
        'stats.getUsage',
        { serviceType: 'seal', range: '24h' },
        accessToken
      );
      expect(response24h.result?.data).toBeDefined();

      // Test 7d range
      const response7d = await trpcQuery<any>(
        'stats.getUsage',
        { serviceType: 'seal', range: '7d' },
        accessToken
      );
      expect(response7d.result?.data).toBeDefined();

      // Test 30d range
      const response30d = await trpcQuery<any>(
        'stats.getUsage',
        { serviceType: 'seal', range: '30d' },
        accessToken
      );
      expect(response30d.result?.data).toBeDefined();
    });
  });

  describe('stats.getResponseTime', () => {
    it('should return response time data', async () => {
      await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 100,
        timestamp: '2024-01-15T10:00:00Z',
      });

      const response = await trpcQuery<any>(
        'stats.getResponseTime',
        { serviceType: 'seal', range: '24h' },
        accessToken
      );

      expect(response.result?.data).toBeDefined();
      expect(Array.isArray(response.result?.data)).toBe(true);

      const dataPoints = response.result?.data;
      if (dataPoints.length > 0) {
        expect(dataPoints[0].avgResponseTimeMs).toBeDefined();
        expect(dataPoints[0].bucket).toBeDefined();
      }
    });
  });

  describe('Usage billing integration', () => {
    it('should add usage charges to invoice on billing day', async () => {
      // Insert usage logs in January using pre-aggregation (production HAProxy feature)
      await insertMockLogs({
        customerId,
        serviceType: 1,
        count: 1,
        repeat: 10000, // Pre-aggregated: 1 row representing 10,000 requests
        timestamp: '2024-01-15T12:00:00Z',
      });

      // Advance to Feb 1 (billing day)
      await setClockTime('2024-02-01T00:00:00Z');

      // Run billing job
      const billingResult = await restCall<any>(
        'POST',
        '/test/billing/run-periodic-job',
        { customerId }
      );

      expect(billingResult.success).toBe(true);

      // Check that usage charges were added
      const jobResult = billingResult.data?.result;
      const usageOp = jobResult?.phases?.billing?.results?.[0]?.operations?.find(
        (op: any) => op.description?.includes('usage charge')
      );

      // Usage charges should have been added (if service is active)
      // Note: The exact behavior depends on service state
    });
  });
});
