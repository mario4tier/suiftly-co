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
  refreshStatsPerMin,
  clearAllLogs,
  clearAllStats,
} from './test-helpers';
import { resetTestState, suspendGMProcessing } from '../billing/test-helpers';
import {
  getStatsSummary,
  getUsageStats,
  getResponseTimeStats,
  getTrafficStats,
  getBandwidthStats,
  getBillableRequestCount,
  getBillableBandwidth,
  type StatsSummary,
  type UsageDataPoint,
  type ResponseTimeDataPoint,
} from './queries';

// Test customer data — wallet must be unique across ALL test files (not just API tests)
const TEST_CUSTOMER_ID = 99901;
const TEST_WALLET = '0x' + 'b'.repeat(62) + '01';

describe('Stats Queries', () => {
  let clock: MockDBClock;

  beforeAll(async () => {
    await resetTestState(db);

    // Clean up any stale data from previous runs, then create test customer
    await db.execute(sql`DELETE FROM customers WHERE wallet_address = ${TEST_WALLET} AND customer_id != ${TEST_CUSTOMER_ID}`);
    await db.execute(sql`
      INSERT INTO customers (customer_id, wallet_address, status)
      VALUES (${TEST_CUSTOMER_ID}, ${TEST_WALLET}, 'active')
      ON CONFLICT (customer_id) DO NOTHING
    `);

    // Create service instance for the customer
    await db.execute(sql`
      INSERT INTO service_instances (customer_id, service_type, state)
      VALUES (${TEST_CUSTOMER_ID}, 'seal', 'enabled')
      ON CONFLICT (customer_id, service_type) DO NOTHING
    `);
  });

  beforeEach(async () => {
    await suspendGMProcessing();

    // Reset clock to a known time
    clock = new MockDBClock({ currentTime: new Date('2024-01-15T12:00:00Z') });

    // Clear all stats data (raw logs + both materialized aggregates) for clean state.
    // Must refresh BOTH aggregates after clearing to reset TimescaleDB's internal
    // watermarks — otherwise a subsequent refresh inside a test may skip ranges
    // it thinks were already materialized.
    await clearAllStats(db);
    await refreshStatsAggregate(db);
    await refreshStatsPerMin(db);
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
        droppedCount: 0,
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
      }, { guaranteed: 70, burst: 0, dropped: 0, clientError: 20, serverError: 10 });
      await refreshStatsAggregate(db);

      const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock);

      expect(summary.successCount).toBe(70);
      expect(summary.droppedCount).toBe(0);
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

  // ==========================================================================
  // Hybrid real-time query tests (stats_per_hour + stats_per_min tail)
  // ==========================================================================
  describe('Hybrid real-time queries', () => {
    // Clock at 12:30 — 30 minutes into the current hour.
    // Cutoff = 12:00 (start of current hour).
    // Data at 10:00 → completed hour → covered by stats_per_hour.
    // Data at 12:15 → current hour → only in stats_per_min.
    const COMPLETED_HOUR = new Date('2024-01-15T10:00:00Z');
    const CURRENT_HOUR   = new Date('2024-01-15T12:15:00Z');

    beforeEach(() => {
      clock = new MockDBClock({ currentTime: new Date('2024-01-15T12:30:00Z') });
    });

    describe('getStatsSummary with range', () => {
      it('should combine hourly aggregate + minute tail', async () => {
        // 100 requests in completed hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 100,
          timestamp: COMPLETED_HOUR, statusCode: 200,
        });
        // 50 requests in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 50,
          timestamp: CURRENT_HOUR, statusCode: 200,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock, '24h');

        expect(summary.successCount).toBe(150);
        expect(summary.totalRequests).toBe(150);
      });

      it('should include minute-tail data even without hourly refresh', async () => {
        // Only insert in current hour — don't refresh stats_per_hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 30,
          timestamp: CURRENT_HOUR, statusCode: 200,
        });
        // Only refresh stats_per_min (NOT stats_per_hour)
        await refreshStatsPerMin(db);

        const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock, '24h');

        // Minute tail picks up the 30 requests
        expect(summary.successCount).toBe(30);
        expect(summary.totalRequests).toBe(30);
      });

      it('should respect the range parameter', async () => {
        // Insert data 3 days ago (outside 24h, inside 7d)
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 200,
          timestamp: new Date('2024-01-12T10:00:00Z'), statusCode: 200,
        });
        // Insert data 2 hours ago (inside 24h)
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 75,
          timestamp: COMPLETED_HOUR, statusCode: 200,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const summary24h = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock, '24h');
        const summary7d = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock, '7d');

        expect(summary24h.successCount).toBe(75);
        expect(summary7d.successCount).toBe(275);
      });

      it('should count mixed traffic types in minute tail', async () => {
        // Guaranteed success in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 40,
          timestamp: CURRENT_HOUR, statusCode: 200, trafficType: 1,
        });
        // Client error in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: CURRENT_HOUR, statusCode: 429, trafficType: 3,
        });
        await refreshStatsPerMin(db);

        const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock, '24h');

        expect(summary.successCount).toBe(40);
        expect(summary.droppedCount).toBe(10);
        expect(summary.totalRequests).toBe(50);
      });
    });

    describe('getBillableRequestCount hybrid', () => {
      it('should include minute-tail in billing counts', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Completed hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 100,
          timestamp: COMPLETED_HOUR, trafficType: 1,
        });
        // Current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 25,
          timestamp: CURRENT_HOUR, trafficType: 1,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const count = await getBillableRequestCount(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        expect(count).toBe(125);
      });

      it('should exclude non-billable traffic from minute tail', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Billable in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 20,
          timestamp: CURRENT_HOUR, trafficType: 1,
        });
        // Non-billable (dropped) in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: CURRENT_HOUR, trafficType: 3,
        });
        await refreshStatsPerMin(db);

        const count = await getBillableRequestCount(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        expect(count).toBe(20);
      });
    });

    describe('getBillableBandwidth hybrid', () => {
      it('should include minute-tail bandwidth in billing', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Completed hour: 100 requests × 4096 bytes
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 100,
          timestamp: COMPLETED_HOUR, trafficType: 1, bytesSent: 4096,
        });
        // Current hour: 10 requests × 2048 bytes
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: CURRENT_HOUR, trafficType: 1, bytesSent: 2048,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const bytes = await getBillableBandwidth(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        expect(bytes).toBe(100 * 4096 + 10 * 2048);
      });
    });

    // Stream metering (docs/STREAM_METERING_FEATURE.md Phase 2):
    // traffic_type = 7 marks a periodic byte delta from the stream-meter
    // poller. It must count toward billable_bytes (bandwidth) but NOT
    // toward billable_requests (stream deltas aren't requests).
    describe('stream-delta traffic (traffic_type = 7)', () => {
      it('getBillableBandwidth should include stream-delta bytes in both hourly and minute-tail', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Completed hour: stream delta of 8192 bytes
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: COMPLETED_HOUR, trafficType: 7, bytesSent: 8192,
        });
        // Current hour: stream delta of 3072 bytes
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 7, bytesSent: 3072,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const bytes = await getBillableBandwidth(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        expect(bytes).toBe(8192 + 3072);
      });

      it('getBillableRequestCount should exclude stream deltas', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Unary request (billable)
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 20,
          timestamp: CURRENT_HOUR, trafficType: 1,
        });
        // Stream delta (not a request)
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 5,
          timestamp: CURRENT_HOUR, trafficType: 7,
        });
        // Completed hour has the same mix
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 30,
          timestamp: COMPLETED_HOUR, trafficType: 1,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 7,
          timestamp: COMPLETED_HOUR, trafficType: 7,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const count = await getBillableRequestCount(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        // Only the unary rows (20 + 30); stream deltas excluded.
        expect(count).toBe(50);
      });

      // Close-log rows for a metered gRPC stream (traffic_type=8) repeat
      // the cumulative bytes the poller already emitted via traffic_type=7
      // AND carry the stream's lifetime (e.g. 10s) in time_total. They
      // must be excluded from billable_bytes (to avoid double-count), from
      // billable_requests (streams are not unary requests), and from
      // response-time aggregates (a 10s stream would skew avg_rt).
      it('getBillableBandwidth should exclude stream-close bytes', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Poller already emitted the bytes as tt=7
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 7, bytesSent: 50_000,
        });
        // HAProxy then emits the close-log row repeating the cumulative bytes
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 8, bytesSent: 50_000,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const bytes = await getBillableBandwidth(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        // Should only count the tt=7 row, not the tt=8 close-log echo.
        expect(bytes).toBe(50_000);
      });

      it('getBillableRequestCount should exclude stream-close rows', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: CURRENT_HOUR, trafficType: 1,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 3,
          timestamp: CURRENT_HOUR, trafficType: 8,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const count = await getBillableRequestCount(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        // Only unary (tt=1) rows count; stream-close (tt=8) excluded.
        expect(count).toBe(10);
      });

      it('getBandwidthStats should exclude stream-close bytes from the chart', async () => {
        // Chart totals must not double-count. Poller emits the bytes via
        // tt=7; HAProxy's close-log row (tt=8) echoes the same bytes for
        // lifecycle analytics only.
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: COMPLETED_HOUR, trafficType: 7, bytesSent: 40_000,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: COMPLETED_HOUR, trafficType: 8, bytesSent: 40_000,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getBandwidthStats(db, TEST_CUSTOMER_ID, 1, '24 hours', clock);
        const totalBytes = stats.reduce((s, p) => s + p.bytes, 0);

        // Should be 40_000, not 80_000 (tt=8 excluded).
        expect(totalBytes).toBe(40_000);
      });

      it('getBandwidthStats minute-tail should exclude stream-close bytes', async () => {
        // Same invariant, current-hour tail path (reads stats_per_min).
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 7, bytesSent: 15_000,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 8, bytesSent: 15_000,
        });
        await refreshStatsPerMin(db);

        const stats = await getBandwidthStats(db, TEST_CUSTOMER_ID, 1, '24 hours', clock);
        const totalBytes = stats.reduce((s, p) => s + p.bytes, 0);

        expect(totalBytes).toBe(15_000);
      });

      it('getResponseTimeStats should exclude stream-close time_total', async () => {
        // Unary request with 50ms response time in CURRENT_HOUR
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: CURRENT_HOUR, trafficType: 1, responseTimeMs: 50,
        });
        // Stream-close row: 10s lifetime — would wreck avg if included
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 8, responseTimeMs: 10_000,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getResponseTimeStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);
        const tail = stats.find(p => p.partial) ?? stats[stats.length - 1];

        // Expect ~50ms — if tt=8 leaked in, avg would be (10×50 + 1×10000)/11 ≈ 954ms.
        expect(tail.avgResponseTimeMs).toBeLessThan(100);
      });

      it('getBillableBandwidth should include a mix of unary and stream-delta bytes', async () => {
        const monthStart = new Date('2024-01-01T00:00:00Z');

        // Unary bytes in completed hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: COMPLETED_HOUR, trafficType: 1, bytesSent: 1024,
        });
        // Stream delta in completed hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: COMPLETED_HOUR, trafficType: 7, bytesSent: 4096,
        });
        // Unary bytes in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 5,
          timestamp: CURRENT_HOUR, trafficType: 1, bytesSent: 512,
        });
        // Stream delta in current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 7, bytesSent: 2048,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const bytes = await getBillableBandwidth(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );

        expect(bytes).toBe(10 * 1024 + 4096 + 5 * 512 + 2048);
      });
    });

    describe('Chart partial bar', () => {
      it('getTrafficStats should append partial bar for current hour', async () => {
        // Completed hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 80,
          timestamp: COMPLETED_HOUR, statusCode: 200, trafficType: 1,
        });
        // Current hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 20,
          timestamp: CURRENT_HOUR, statusCode: 200, trafficType: 1,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getTrafficStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

        // Should have at least 2 points
        expect(stats.length).toBeGreaterThanOrEqual(2);

        // Last point should be partial (current hour)
        const lastPoint = stats[stats.length - 1];
        expect(lastPoint.partial).toBe(true);
        expect(lastPoint.guaranteed).toBe(20);

        // Earlier points should not be partial
        const completedPoints = stats.filter(p => !p.partial);
        expect(completedPoints.length).toBeGreaterThan(0);
        const totalCompleted = completedPoints.reduce((s, p) => s + p.guaranteed, 0);
        expect(totalCompleted).toBe(80);
      });

      it('getUsageStats should append partial bar for current hour', async () => {
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 60,
          timestamp: COMPLETED_HOUR, trafficType: 1,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 15,
          timestamp: CURRENT_HOUR, trafficType: 1,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getUsageStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

        const lastPoint = stats[stats.length - 1];
        expect(lastPoint.partial).toBe(true);
        expect(lastPoint.billableRequests).toBe(15);
      });

      it('getBandwidthStats should append partial bar for current hour', async () => {
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 50,
          timestamp: COMPLETED_HOUR, bytesSent: 1024,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 5,
          timestamp: CURRENT_HOUR, bytesSent: 2048,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getBandwidthStats(db, TEST_CUSTOMER_ID, 1, '24 hours', clock);

        const lastPoint = stats[stats.length - 1];
        expect(lastPoint.partial).toBe(true);
        expect(lastPoint.bytes).toBe(5 * 2048);
      });

      it('getBandwidthStats should reflect streaming pattern (1 request, high bytes)', async () => {
        // Streaming: 1 long-lived connection → 1 log entry with large bytesSent
        // Completed hour: one 10-second stream → ~50KB
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: COMPLETED_HOUR, trafficType: 1, bytesSent: 51200,
        });
        // Current hour: one 3-second stream → ~15KB
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: CURRENT_HOUR, trafficType: 1, bytesSent: 15360,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getBandwidthStats(db, TEST_CUSTOMER_ID, 1, '24 hours', clock);

        // Completed hour bar
        const completedPoints = stats.filter(p => !p.partial);
        const completedBytes = completedPoints.reduce((s, p) => s + p.bytes, 0);
        expect(completedBytes).toBe(51200);

        // Partial current-hour bar
        const lastPoint = stats[stats.length - 1];
        expect(lastPoint.partial).toBe(true);
        expect(lastPoint.bytes).toBe(15360);
      });

      it('should combine requests + streaming patterns correctly', async () => {
        // Current hour: 10 short requests (1KB each) + 1 streaming connection (50KB)
        // Simulates a customer using both injection modes in the same hour
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 10,
          timestamp: CURRENT_HOUR, trafficType: 1, bytesSent: 1024, statusCode: 200,
        });
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 1,
          timestamp: new Date(CURRENT_HOUR.getTime() + 60000), // 1 min later
          trafficType: 1, bytesSent: 51200, statusCode: 200,
        });
        await refreshStatsPerMin(db);

        // Summary should count 11 total requests
        const summary = await getStatsSummary(db, TEST_CUSTOMER_ID, 1, clock, '24h');
        expect(summary.successCount).toBe(11);
        expect(summary.totalRequests).toBe(11);

        // Billing requests: 11 billable
        const monthStart = new Date('2024-01-01T00:00:00Z');
        const billableCount = await getBillableRequestCount(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );
        expect(billableCount).toBe(11);

        // Billing bandwidth: 10*1024 + 1*51200 = 61440
        const billableBytes = await getBillableBandwidth(
          db, TEST_CUSTOMER_ID, 1, monthStart, clock.now()
        );
        expect(billableBytes).toBe(10 * 1024 + 51200);

        // Chart bandwidth partial bar: same total
        const bwStats = await getBandwidthStats(db, TEST_CUSTOMER_ID, 1, '24 hours', clock);
        const lastPoint = bwStats[bwStats.length - 1];
        expect(lastPoint.partial).toBe(true);
        expect(lastPoint.bytes).toBe(10 * 1024 + 51200);

        // Traffic chart partial bar: 11 guaranteed
        const trafficStats = await getTrafficStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);
        const lastTraffic = trafficStats[trafficStats.length - 1];
        expect(lastTraffic.partial).toBe(true);
        expect(lastTraffic.guaranteed).toBe(11);
      });

      it('should not include partial bar when current hour has no data', async () => {
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 50,
          timestamp: COMPLETED_HOUR,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getTrafficStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

        // No partial bar — current hour has no data
        expect(stats.every(p => !p.partial)).toBe(true);
      });

      it('getResponseTimeStats (24h) should append partial bar for current hour', async () => {
        // Completed hour: 100 requests at 50ms → hourly avg=50, min=50, max=50
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 100,
          timestamp: COMPLETED_HOUR, trafficType: 1, responseTimeMs: 50,
        });
        // Current hour: 50 requests at 100ms → tail avg=100, min=100, max=100
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 50,
          timestamp: CURRENT_HOUR, trafficType: 1, responseTimeMs: 100,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getResponseTimeStats(db, TEST_CUSTOMER_ID, 1, '24h', clock);

        const lastPoint = stats[stats.length - 1];
        expect(lastPoint.partial).toBe(true);
        expect(lastPoint.avgResponseTimeMs).toBe(100);
        // True min from min_rt_ms (not min-of-avg). Fixed-value mocks → min=100.
        expect(lastPoint.minResponseTimeMs).toBe(100);
        expect(lastPoint.maxResponseTimeMs).toBe(100);
      });

      it('getResponseTimeStats (7d) should merge tail into today bucket with weighted avg', async () => {
        // Completed hour today: 100 req @ 50ms → hourly (avg,min,max)=(50,50,50), count=100
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 100,
          timestamp: COMPLETED_HOUR, trafficType: 1, responseTimeMs: 50,
        });
        // Current hour today: 50 req @ 100ms → tail (avg,min,max)=(100,100,100), count=50
        await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
          serviceType: 1, network: 1, count: 50,
          timestamp: CURRENT_HOUR, trafficType: 1, responseTimeMs: 100,
        });
        await refreshStatsAggregate(db);
        await refreshStatsPerMin(db);

        const stats = await getResponseTimeStats(db, TEST_CUSTOMER_ID, 1, '7d', clock);

        // Exactly one day bucket (today).
        const todayStart = new Date(Date.UTC(2024, 0, 15));
        const today = stats.find(p => p.bucket.getTime() === todayStart.getTime());
        expect(today).toBeDefined();
        expect(today!.partial).toBe(true);
        // Weighted avg: (50*100 + 100*50) / 150 = 66.666…
        expect(today!.avgResponseTimeMs).toBeCloseTo((50 * 100 + 100 * 50) / 150, 5);
        expect(today!.minResponseTimeMs).toBe(50);
        expect(today!.maxResponseTimeMs).toBe(100);
      });
    });
  });
});
