/**
 * Preview path tests — `getUsageChargePreview` in usage-charges.ts.
 *
 * Pins two behaviors:
 *   (1) Window is the current calendar month, independent of `enabledAt` or
 *       any per-service timestamp. Traffic from the prior month must NOT
 *       appear in the preview.
 *   (2) Bandwidth is included alongside requests, so the preview matches the
 *       draft invoice the customer will actually be charged.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '../db';
import { customers, serviceInstances } from '../schema';
import { eq, sql } from 'drizzle-orm';
import { MockDBClock } from '@suiftly/shared/db-clock';
import { BANDWIDTH_PRICING_CENTS_PER_GB, USAGE_PRICING_CENTS_PER_1000, SERVICE_TYPE } from '@suiftly/shared/constants';
import {
  insertMockHAProxyLogs,
  refreshStatsAggregate,
  refreshStatsPerMin,
  clearAllStats,
} from '../stats/test-helpers';
import { getUsageChargePreview } from './usage-charges';
import { cleanupCustomerData, resetTestState, suspendGMProcessing } from './test-helpers';

const TEST_CUSTOMER_ID = 99903;
const TEST_WALLET = '0x' + 'c'.repeat(62) + '03';

describe('getUsageChargePreview', () => {
  beforeAll(async () => {
    await suspendGMProcessing();
    await resetTestState(db);
    await cleanupCustomerData(db, TEST_CUSTOMER_ID);

    await db.execute(sql`DELETE FROM customers WHERE wallet_address = ${TEST_WALLET} AND customer_id != ${TEST_CUSTOMER_ID}`);
    await db.execute(sql`
      INSERT INTO customers (customer_id, wallet_address, status)
      VALUES (${TEST_CUSTOMER_ID}, ${TEST_WALLET}, 'active')
      ON CONFLICT (customer_id) DO NOTHING
    `);

    // gRPC has non-zero bandwidth pricing — required to exercise the new bandwidth path.
    await db.execute(sql`
      INSERT INTO service_instances (customer_id, service_type, state)
      VALUES (${TEST_CUSTOMER_ID}, 'grpc', 'enabled')
      ON CONFLICT (customer_id, service_type) DO NOTHING
    `);
  });

  beforeEach(async () => {
    await clearAllStats(db);
    await refreshStatsAggregate(db);
    await refreshStatsPerMin(db);
  });

  afterAll(async () => {
    await clearAllStats(db);
    await cleanupCustomerData(db, TEST_CUSTOMER_ID);
  });

  it('window is current calendar month, ignoring prior-month traffic', async () => {
    const clock = new MockDBClock({ currentTime: new Date('2024-02-15T12:00:00Z') });

    // Prior month (January): must be excluded.
    await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
      serviceType: 2, // gRPC
      network: 1,
      count: 5000,
      timestamp: new Date('2024-01-20T10:00:00Z'),
      trafficType: 1,
      bytesSent: 4096,
    });
    // Current month (February): must be included.
    await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
      serviceType: 2,
      network: 1,
      count: 2000,
      timestamp: new Date('2024-02-10T10:00:00Z'),
      trafficType: 1,
      bytesSent: 2048,
    });
    await refreshStatsAggregate(db);
    await refreshStatsPerMin(db);

    const preview = await getUsageChargePreview(db, TEST_CUSTOMER_ID, clock);

    const grpc = preview.services.find(s => s.serviceType === SERVICE_TYPE.GRPC);
    expect(grpc).toBeDefined();
    expect(grpc!.requestCount).toBe(2000);
    expect(grpc!.bandwidthBytes).toBe(2000 * 2048);
  });

  it('includes both request and bandwidth charges and they sum to chargeCents', async () => {
    const clock = new MockDBClock({ currentTime: new Date('2024-02-15T12:00:00Z') });

    // 10,000 requests × 4096 bytes in Feb.
    await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
      serviceType: 2,
      network: 1,
      count: 10000,
      timestamp: new Date('2024-02-10T10:00:00Z'),
      trafficType: 1,
      bytesSent: 4096,
    });
    await refreshStatsAggregate(db);
    await refreshStatsPerMin(db);

    const preview = await getUsageChargePreview(db, TEST_CUSTOMER_ID, clock);
    const grpc = preview.services.find(s => s.serviceType === SERVICE_TYPE.GRPC);
    expect(grpc).toBeDefined();

    const pricePer1000 = USAGE_PRICING_CENTS_PER_1000[SERVICE_TYPE.GRPC];
    const pricePerGb = BANDWIDTH_PRICING_CENTS_PER_GB[SERVICE_TYPE.GRPC];
    const expectedRequestCents = Math.floor((10000 * pricePer1000) / 1000);
    const expectedBandwidthCents = Math.floor(
      ((10000 * 4096) / (1024 * 1024 * 1024)) * pricePerGb
    );

    expect(grpc!.requestChargeCents).toBe(expectedRequestCents);
    expect(grpc!.bandwidthChargeCents).toBe(expectedBandwidthCents);
    expect(grpc!.chargeCents).toBe(expectedRequestCents + expectedBandwidthCents);
    expect(preview.totalCents).toBe(expectedRequestCents + expectedBandwidthCents);
  });

  it('returns empty services array when current month has no traffic', async () => {
    const clock = new MockDBClock({ currentTime: new Date('2024-02-15T12:00:00Z') });

    // Only prior-month traffic.
    await insertMockHAProxyLogs(db, TEST_CUSTOMER_ID, {
      serviceType: 2,
      network: 1,
      count: 1000,
      timestamp: new Date('2024-01-20T10:00:00Z'),
      trafficType: 1,
      bytesSent: 4096,
    });
    await refreshStatsAggregate(db);
    await refreshStatsPerMin(db);

    const preview = await getUsageChargePreview(db, TEST_CUSTOMER_ID, clock);
    expect(preview.services).toHaveLength(0);
    expect(preview.totalCents).toBe(0);
  });
});
