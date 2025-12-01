/**
 * Stats Query Unit Tests (STATS_DESIGN.md D5)
 *
 * TDD tests for stats query functions.
 * Uses MockDBClock for deterministic time and mock HAProxy log data.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '../db';
import { customers, serviceInstances } from '../schema';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { eq, sql } from 'drizzle-orm';
import {
  insertMockHAProxyLogs,
  insertMockMixedLogs,
  refreshStatsAggregate,
  clearAllLogs,
} from './test-helpers';
import {
  getStatsSummary,
  getUsageStats,
  getResponseTimeStats,
  type StatsSummary,
  type UsageDataPoint,
  type ResponseTimeDataPoint,
} from './queries';

// Test customer data
const TEST_CUSTOMER_ID = 99901;
// Use unique wallet to avoid conflicts with API tests that use 0xaaa...
const TEST_WALLET = '0x' + 'b'.repeat(64);

describe('Stats Queries', () => {
  let clock: MockDBClock;

  beforeAll(async () => {
    // Create test customer if not exists
    await db.execute(sql`
      INSERT INTO customers (customer_id, wallet_address, status)
      VALUES (${TEST_CUSTOMER_ID}, ${TEST_WALLET}, 'active')
      ON CONFLICT (customer_id) DO NOTHING
    `);

    // Create service instance for the customer
    await db.execute(sql`
      INSERT INTO service_instances (customer_id, service_type, state, tier)
      VALUES (${TEST_CUSTOMER_ID}, 'seal', 'enabled', 'starter')
      ON CONFLICT (customer_id, service_type) DO NOTHING
    `);
  });

  beforeEach(async () => {
    // Reset clock to a known time
    clock = new MockDBClock({ currentTime: new Date('2024-01-15T12:00:00Z') });

    // Clear existing logs and refresh aggregate to ensure clean state
    await clearAllLogs(db);
    await refreshStatsAggregate(db);
  });

  afterAll(async () => {
    // Cleanup test data
    await clearAllLogs(db);
    await db.execute(sql`DELETE FROM service_instances WHERE customer_id = ${TEST_CUSTOMER_ID}`);
    await db.execute(sql`DELETE FROM customers WHERE customer_id = ${TEST_CUSTOMER_ID}`);
  });

  describe('getStatsSummary', () => {
    it('should return zeros when no logs exist', async () => {
      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      expect(summary).toEqual({
        successCount: 0,
        clientErrorCount: 0,
        serverErrorCount: 0,
        totalRequests: 0,
      });
    });

    it('should count successful requests (2xx)', async () => {
      // Insert 100 successful requests
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date('2024-01-15T10:00:00Z'), // 2 hours ago
        statusCode: 200,
      });
      await refreshStatsAggregate(db);

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      expect(summary.successCount).toBe(100);
      expect(summary.clientErrorCount).toBe(0);
      expect(summary.serverErrorCount).toBe(0);
      expect(summary.totalRequests).toBe(100);
    });

    it('should count client errors (4xx)', async () => {
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 50,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        statusCode: 400,
      });
      await refreshStatsAggregate(db);

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      expect(summary.successCount).toBe(0);
      expect(summary.clientErrorCount).toBe(50);
      expect(summary.serverErrorCount).toBe(0);
    });

    it('should count server errors (5xx)', async () => {
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 25,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        statusCode: 500,
      });
      await refreshStatsAggregate(db);

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      expect(summary.successCount).toBe(0);
      expect(summary.clientErrorCount).toBe(0);
      expect(summary.serverErrorCount).toBe(25);
    });

    it('should count mixed status codes correctly', async () => {
      await insertMockMixedLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date('2024-01-15T10:00:00Z'),
      }, { success: 70, clientError: 20, serverError: 10 });
      await refreshStatsAggregate(db);

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      expect(summary.successCount).toBe(70);
      expect(summary.clientErrorCount).toBe(20);
      expect(summary.serverErrorCount).toBe(10);
      expect(summary.totalRequests).toBe(100);
    });

    it('should only include logs from last 24 hours', async () => {
      // Insert logs from 2 days ago (should be excluded)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date('2024-01-13T10:00:00Z'), // 2 days ago
        statusCode: 200,
      });

      // Insert logs from 10 hours ago (should be included)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 50,
        timestamp: new Date('2024-01-15T02:00:00Z'), // 10 hours ago
        statusCode: 200,
      });
      await refreshStatsAggregate(db);

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      // Should only count the 50 from last 24h
      expect(summary.successCount).toBe(50);
    });

    it('should filter by service type', async () => {
      // Insert logs for service type 1 (seal)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date('2024-01-15T10:00:00Z'),
      });

      // Insert logs for service type 2 (grpc)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 2,
        network: 1,
        count: 50,
        timestamp: new Date('2024-01-15T10:00:00Z'),
      });
      await refreshStatsAggregate(db);

      const summaryType1 = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);
      const summaryType2 = await getStatsSummary(db, TEST_CUSTOMER_ID, 2, clock);

      expect(summaryType1.successCount).toBe(100);
      expect(summaryType2.successCount).toBe(50);
    });
  });

  describe('getUsageStats', () => {
    it('should return empty array when no logs exist', async () => {
      const stats = await getUsageStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

      expect(stats).toEqual([]);
    });

    it('should return hourly data points for 24h range', async () => {
      // Insert logs spread across 6 hours
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 600,
        timestamp: new Date('2024-01-15T06:00:00Z'),
        spreadAcrossHours: 6,
      });
      await refreshStatsAggregate(db);

      const stats = await getUsageStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

      // Should have data points for the hours with data
      expect(stats.length).toBeGreaterThan(0);
      expect(stats.every(p => 'bucket' in p && 'billableRequests' in p)).toBe(true);

      // Total should be 600
      const total = stats.reduce((sum, p) => sum + p.billableRequests, 0);
      expect(total).toBe(600);
    });

    it('should return daily data points for 7d range', async () => {
      // Set clock to a week later
      clock = new MockDBClock({ currentTime: new Date('2024-01-22T12:00:00Z') });

      // Insert logs spread across 7 days
      for (let day = 0; day < 7; day++) {
        const timestamp = new Date(`2024-01-${15 + day}T12:00:00Z`);
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1,
          network: 1,
          count: 100,
          timestamp,
        });
      }
      await refreshStatsAggregate(db);

      const stats = await getUsageStats(db, TEST_CUSTOMER_ID, 1, '7d', clock);

      // Should aggregate by day
      expect(stats.length).toBeLessThanOrEqual(7);
    });

    it('should only count billable requests (traffic_type 1 or 2)', async () => {
      // Insert billable requests (traffic_type = 1)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        trafficType: 1, // guaranteed
      });

      // Insert non-billable requests (traffic_type = 3)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 50,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        trafficType: 3, // denied
      });
      await refreshStatsAggregate(db);

      const stats = await getUsageStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);
      const total = stats.reduce((sum, p) => sum + p.billableRequests, 0);

      // Only billable requests should be counted
      expect(total).toBe(100);
    });
  });

  describe('getResponseTimeStats', () => {
    it('should return empty array when no logs exist', async () => {
      const stats = await getResponseTimeStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

      expect(stats).toEqual([]);
    });

    it('should return average response time per bucket', async () => {
      // Insert logs with known response times
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        responseTimeMs: 50, // 50ms average
      });
      await refreshStatsAggregate(db);

      const stats = await getResponseTimeStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

      expect(stats.length).toBeGreaterThan(0);
      expect(stats.every(p => 'bucket' in p && 'avgResponseTimeMs' in p)).toBe(true);

      // Average should be close to 50ms
      const avgRt = stats[0]?.avgResponseTimeMs;
      expect(avgRt).toBeCloseTo(50, 0);
    });

    it('should compute weighted average across multiple buckets', async () => {
      // Insert logs with different response times
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 50,
        timestamp: new Date('2024-01-15T10:00:00Z'),
        responseTimeMs: 100,
      });

      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 50,
        timestamp: new Date('2024-01-15T11:00:00Z'),
        responseTimeMs: 200,
      });
      await refreshStatsAggregate(db);

      const stats = await getResponseTimeStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

      // Should have 2 buckets with different averages
      expect(stats.length).toBe(2);
    });
  });

  describe('Time range filtering', () => {
    it('should correctly filter by 24h using DBClock', async () => {
      // Insert logs at various times
      const baseTime = new Date('2024-01-15T00:00:00Z');

      // 30 hours ago (outside 24h)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 100,
        timestamp: new Date(baseTime.getTime() - 30 * 60 * 60 * 1000),
      });

      // 12 hours ago (inside 24h)
      await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
        serviceType: 1,
        network: 1,
        count: 200,
        timestamp: baseTime,
      });
      await refreshStatsAggregate(db);

      // Set clock to 12 hours after base time
      clock = new MockDBClock({ currentTime: new Date('2024-01-15T12:00:00Z') });

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      // Should only include the 200 from 12 hours ago
      expect(summary.successCount).toBe(200);
    });
  });
});
