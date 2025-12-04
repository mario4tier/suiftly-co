/**
 * Test helpers for stats system (STATS_DESIGN.md D6)
 *
 * Provides mock data insertion for testing stats queries and billing integration.
 * These helpers are used by unit tests and the /test/stats/* API endpoints.
 */

import { sql, eq } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import { haproxyRawLogs } from '../schema/logs';
import { billingRecords } from '../schema/escrow';
import { syncUsageToDraft, unsafeAsLockedTransaction } from '../billing';
import { dbClock } from '@suiftly/shared/db-clock';

/**
 * Options for inserting mock HAProxy logs
 */
export interface MockHAProxyLogOptions {
  /** Service type: 1=Seal, 2=gRPC, 3=GraphQL */
  serviceType: 1 | 2 | 3;
  /** Network: 0=testnet, 1=mainnet */
  network: 0 | 1;
  /** Number of log entries to insert */
  count: number;
  /** Base timestamp for the logs */
  timestamp: Date;
  /** HTTP status code (default: 200) */
  statusCode?: number;
  /** Traffic type: 1=guaranteed, 2=burst, 3-6=denied/dropped (default: 1) */
  trafficType?: number;
  /** Response time in ms (default: 50) */
  responseTimeMs?: number;
  /** Bytes sent (default: 1024) */
  bytesSent?: number;
  /** Server ID (default: 1) */
  serverId?: number;
  /** Spread logs across hours (default: false - all at same timestamp) */
  spreadAcrossHours?: number;
  /**
   * Pre-aggregated log repeat count (default: 1)
   * When >1, each log entry represents multiple identical requests.
   * The continuous aggregate uses SUM(repeat) to count all requests.
   */
  repeat?: number;
}

/**
 * Insert mock HAProxy log entries for testing
 *
 * @param db Database instance
 * @param customerId Customer ID (must exist in customers table)
 * @param options Configuration for the mock logs
 * @returns Number of records inserted
 *
 * @example
 * // Insert 1000 successful requests for customer 1
 * await insertMockHAProxyLogs(db, 1, {
 *   serviceType: 1,
 *   network: 1,
 *   count: 1000,
 *   timestamp: new Date('2024-01-15T12:00:00Z'),
 * });
 *
 * @example
 * // Insert logs spread across 24 hours
 * await insertMockHAProxyLogs(db, 1, {
 *   serviceType: 1,
 *   network: 1,
 *   count: 2400,
 *   timestamp: new Date('2024-01-15T00:00:00Z'),
 *   spreadAcrossHours: 24,
 * });
 */
export async function insertMockHAProxyLogs(
  db: Database,
  customerId: number,
  options: MockHAProxyLogOptions
): Promise<number> {
  const {
    serviceType,
    network,
    count,
    timestamp,
    statusCode = 200,
    trafficType = 1, // guaranteed
    responseTimeMs = 50,
    bytesSent = 1024,
    serverId = 1,
    spreadAcrossHours,
    repeat = 1, // default to single request per entry
  } = options;

  // Generate log entries
  const entries = [];
  const baseTime = timestamp.getTime();

  for (let i = 0; i < count; i++) {
    // Calculate timestamp (spread across hours if requested)
    let entryTime: Date;
    if (spreadAcrossHours && spreadAcrossHours > 0) {
      const hourOffset = Math.floor((i / count) * spreadAcrossHours);
      const msOffset = hourOffset * 60 * 60 * 1000;
      entryTime = new Date(baseTime + msOffset);
    } else {
      // Add small offset to avoid exact duplicates
      entryTime = new Date(baseTime + i);
    }

    entries.push({
      timestamp: entryTime,
      customerId,
      pathPrefix: `/v1/test`,
      configHex: null,
      network,
      serverId,
      serviceType,
      apiKeyFp: 12345, // Mock fingerprint
      feType: 1 as const, // Frontend type
      trafficType,
      eventType: 0 as const, // Normal request
      clientIp: '127.0.0.1',
      keyMetadata: null,
      statusCode,
      bytesSent,
      timeTotal: responseTimeMs,
      timeRequest: Math.floor(responseTimeMs * 0.1),
      timeQueue: 0,
      timeConnect: Math.floor(responseTimeMs * 0.1),
      timeResponse: Math.floor(responseTimeMs * 0.8),
      backendId: 1 as const,
      terminationState: '--',
      repeat, // Pre-aggregated log support
    });
  }

  // Batch insert (chunks of 1000 to avoid query size limits)
  const BATCH_SIZE = 1000;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await db.insert(haproxyRawLogs).values(batch);
  }

  return count;
}

/**
 * Traffic distribution for test data generation (STATS_DESIGN.md R3b)
 */
export interface TrafficDistribution {
  /** Guaranteed success (traffic_type=1, status 2xx) - default 50% */
  guaranteed?: number;
  /** Burst success (traffic_type=2, status 2xx) - default 20% */
  burst?: number;
  /** Dropped (traffic_type=3-6) - default 10% */
  dropped?: number;
  /** Client errors (status 4xx) - default 15% */
  clientError?: number;
  /** Server errors (status 5xx) - default 5% */
  serverError?: number;
}

/**
 * Insert a mix of traffic logs for testing the stacked Traffic chart
 *
 * Creates realistic traffic distribution with:
 * - Guaranteed success (traffic_type=1, status 200)
 * - Burst success (traffic_type=2, status 200)
 * - Dropped requests (traffic_type=3, status 429)
 * - Client errors (traffic_type=1, status 4xx)
 * - Server errors (traffic_type=1, status 5xx)
 *
 * When spreadAcrossHours is set, adds realistic variation:
 * - Each hour varies by ±30% from base
 * - Occasional traffic dips (20% chance of 50% reduction)
 * - Distribution percentages vary ±5% per hour
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param options Base options (count is distributed across traffic types)
 * @param distribution Distribution percentages (should sum to 100)
 */
export async function insertMockMixedLogs(
  db: Database,
  customerId: number,
  options: Omit<MockHAProxyLogOptions, 'statusCode'>,
  distribution: TrafficDistribution = {}
): Promise<{
  guaranteed: number;
  burst: number;
  dropped: number;
  clientError: number;
  serverError: number;
  // Legacy fields for backwards compatibility
  success: number;
}> {
  // Default distribution: 50% guaranteed, 20% burst, 10% dropped, 15% client error, 5% server error
  const baseDist = {
    guaranteed: distribution.guaranteed ?? 50,
    burst: distribution.burst ?? 20,
    dropped: distribution.dropped ?? 10,
    clientError: distribution.clientError ?? 15,
    serverError: distribution.serverError ?? 5,
  };

  const totals = {
    guaranteed: 0,
    burst: 0,
    dropped: 0,
    clientError: 0,
    serverError: 0,
  };

  // If spreading across hours, insert per-hour with variation
  if (options.spreadAcrossHours && options.spreadAcrossHours > 1) {
    const hours = options.spreadAcrossHours;
    const basePerHour = Math.floor(options.count / hours);
    const baseTime = options.timestamp.getTime();

    for (let h = 0; h < hours; h++) {
      // Vary total traffic: ±30%, with 20% chance of a dip (50% reduction)
      let hourMultiplier = 0.7 + Math.random() * 0.6; // 0.7 to 1.3
      if (Math.random() < 0.2) {
        hourMultiplier *= 0.5; // Occasional dip
      }
      const hourCount = Math.max(1, Math.floor(basePerHour * hourMultiplier));

      // Vary response time per hour: 100-600ms base, with guaranteed spikes above 1s
      // First few hours and last hour get guaranteed spikes to ensure threshold visualization works
      let hourResponseTimeMs: number;
      if (h === 2 || h === 3 || h === hours - 2) {
        // Guaranteed spikes above 1 second for testing threshold visualization
        hourResponseTimeMs = 1050 + Math.floor(Math.random() * 450); // 1050-1500ms
      } else if (Math.random() < 0.1) {
        // 10% random chance of spike to 1000-1400ms
        hourResponseTimeMs = 1000 + Math.floor(Math.random() * 400);
      } else {
        // Normal: 100-700ms
        hourResponseTimeMs = 100 + Math.floor(Math.random() * 600);
      }

      // Vary distribution percentages ±5% for each category
      const hourDist = {
        guaranteed: Math.max(0, baseDist.guaranteed + (Math.random() - 0.5) * 10),
        burst: Math.max(0, baseDist.burst + (Math.random() - 0.5) * 10),
        dropped: Math.max(0, baseDist.dropped + (Math.random() - 0.5) * 10),
        clientError: Math.max(0, baseDist.clientError + (Math.random() - 0.5) * 10),
        serverError: Math.max(0, baseDist.serverError + (Math.random() - 0.5) * 10),
      };

      // Normalize to 100%
      const distTotal = hourDist.guaranteed + hourDist.burst + hourDist.dropped + hourDist.clientError + hourDist.serverError;
      const normalize = 100 / distTotal;
      hourDist.guaranteed *= normalize;
      hourDist.burst *= normalize;
      hourDist.dropped *= normalize;
      hourDist.clientError *= normalize;
      hourDist.serverError *= normalize;

      const hourTimestamp = new Date(baseTime + h * 60 * 60 * 1000);
      // Override response time for this hour
      const hourOptions = { ...options, responseTimeMs: hourResponseTimeMs };

      const guaranteedCount = Math.floor(hourCount * (hourDist.guaranteed / 100));
      const burstCount = Math.floor(hourCount * (hourDist.burst / 100));
      const droppedCount = Math.floor(hourCount * (hourDist.dropped / 100));
      const clientErrorCount = Math.floor(hourCount * (hourDist.clientError / 100));
      const serverErrorCount = Math.max(0, hourCount - guaranteedCount - burstCount - droppedCount - clientErrorCount);

      // Insert each type for this hour (using hourOptions for per-hour response time)
      if (guaranteedCount > 0) {
        await insertMockHAProxyLogs(db, customerId, {
          ...hourOptions,
          count: guaranteedCount,
          trafficType: 1,
          statusCode: 200,
          timestamp: hourTimestamp,
          spreadAcrossHours: undefined,
        });
        totals.guaranteed += guaranteedCount;
      }

      if (burstCount > 0) {
        await insertMockHAProxyLogs(db, customerId, {
          ...hourOptions,
          count: burstCount,
          trafficType: 2,
          statusCode: 200,
          timestamp: new Date(hourTimestamp.getTime() + 1),
          spreadAcrossHours: undefined,
        });
        totals.burst += burstCount;
      }

      if (droppedCount > 0) {
        await insertMockHAProxyLogs(db, customerId, {
          ...hourOptions,
          count: droppedCount,
          trafficType: 3,
          statusCode: 429,
          timestamp: new Date(hourTimestamp.getTime() + 2),
          spreadAcrossHours: undefined,
        });
        totals.dropped += droppedCount;
      }

      if (clientErrorCount > 0) {
        await insertMockHAProxyLogs(db, customerId, {
          ...hourOptions,
          count: clientErrorCount,
          trafficType: 1,
          statusCode: 400,
          timestamp: new Date(hourTimestamp.getTime() + 3),
          spreadAcrossHours: undefined,
        });
        totals.clientError += clientErrorCount;
      }

      if (serverErrorCount > 0) {
        await insertMockHAProxyLogs(db, customerId, {
          ...hourOptions,
          count: serverErrorCount,
          trafficType: 1,
          statusCode: 500,
          timestamp: new Date(hourTimestamp.getTime() + 4),
          spreadAcrossHours: undefined,
        });
        totals.serverError += serverErrorCount;
      }
    }

    return {
      ...totals,
      success: totals.guaranteed + totals.burst,
    };
  }

  // No spreading - use uniform distribution
  const total = options.count;
  const guaranteedCount = Math.floor(total * (baseDist.guaranteed / 100));
  const burstCount = Math.floor(total * (baseDist.burst / 100));
  const droppedCount = Math.floor(total * (baseDist.dropped / 100));
  const clientErrorCount = Math.floor(total * (baseDist.clientError / 100));
  const serverErrorCount = total - guaranteedCount - burstCount - droppedCount - clientErrorCount;

  // Insert guaranteed success (traffic_type=1, status 200)
  if (guaranteedCount > 0) {
    await insertMockHAProxyLogs(db, customerId, {
      ...options,
      count: guaranteedCount,
      trafficType: 1,
      statusCode: 200,
    });
  }

  // Insert burst success (traffic_type=2, status 200)
  if (burstCount > 0) {
    await insertMockHAProxyLogs(db, customerId, {
      ...options,
      count: burstCount,
      trafficType: 2,
      statusCode: 200,
      timestamp: new Date(options.timestamp.getTime() + 1),
    });
  }

  // Insert dropped (traffic_type=3, status 429 Too Many Requests)
  if (droppedCount > 0) {
    await insertMockHAProxyLogs(db, customerId, {
      ...options,
      count: droppedCount,
      trafficType: 3, // Denied/dropped
      statusCode: 429,
      timestamp: new Date(options.timestamp.getTime() + 2),
    });
  }

  // Insert client errors (traffic_type=1, status 400)
  if (clientErrorCount > 0) {
    await insertMockHAProxyLogs(db, customerId, {
      ...options,
      count: clientErrorCount,
      trafficType: 1,
      statusCode: 400,
      timestamp: new Date(options.timestamp.getTime() + 3),
    });
  }

  // Insert server errors (traffic_type=1, status 500)
  if (serverErrorCount > 0) {
    await insertMockHAProxyLogs(db, customerId, {
      ...options,
      count: serverErrorCount,
      trafficType: 1,
      statusCode: 500,
      timestamp: new Date(options.timestamp.getTime() + 4),
    });
  }

  return {
    guaranteed: guaranteedCount,
    burst: burstCount,
    dropped: droppedCount,
    clientError: clientErrorCount,
    serverError: serverErrorCount,
    // Legacy: success = guaranteed + burst (for backwards compatibility)
    success: guaranteedCount + burstCount,
  };
}

/**
 * Refresh the stats_per_hour continuous aggregate
 *
 * Forces an immediate refresh of the continuous aggregate.
 * Use this in tests after inserting mock data to make it available for queries.
 *
 * @param db Database instance
 * @param startTime Optional start time for refresh window (default: 1 year ago)
 * @param endTime Optional end time for refresh window (default: now)
 */
export async function refreshStatsAggregate(
  db: Database,
  startTime?: Date,
  endTime?: Date
): Promise<void> {
  // TimescaleDB requires explicit time range for refresh
  // Use 5 years to ensure test data from any date is covered (tests often use 2024 dates)
  const start = startTime
    ? `'${startTime.toISOString()}'::timestamptz`
    : `NOW() - INTERVAL '5 years'`;
  const end = endTime
    ? `'${endTime.toISOString()}'::timestamptz`
    : `NOW() + INTERVAL '1 hour'`;

  await db.execute(
    sql.raw(`CALL refresh_continuous_aggregate('stats_per_hour', ${start}, ${end})`)
  );
}

/**
 * Clear all HAProxy logs for a customer (test cleanup)
 *
 * @param db Database instance
 * @param customerId Customer ID to clear logs for
 */
export async function clearCustomerLogs(
  db: Database,
  customerId: number
): Promise<void> {
  await db.execute(
    sql`DELETE FROM haproxy_raw_logs WHERE customer_id = ${customerId}`
  );
}

/**
 * Clear all HAProxy logs (full test reset)
 *
 * @param db Database instance
 */
export async function clearAllLogs(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE haproxy_raw_logs`);
}

/**
 * Sync usage charges to DRAFT invoice for a customer
 *
 * @deprecated Use `forceSyncUsageToDraft` from `@suiftly/database/billing` instead.
 * This function bypasses production locking (unsafeAsLockedTransaction).
 * The billing version uses proper customer locking and the same production code path.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @returns Result of the sync operation
 */
export async function syncCustomerDraftInvoice(
  db: Database,
  customerId: number
): Promise<{
  success: boolean;
  invoiceId?: string;
  totalUsageChargesCents?: number;
  lineItemsCount?: number;
  error?: string;
}> {
  // Find the DRAFT invoice for this customer
  const draftInvoice = await db.query.billingRecords.findFirst({
    where: eq(billingRecords.customerId, customerId),
  });

  // Filter to find the draft status invoice
  const drafts = await db
    .select()
    .from(billingRecords)
    .where(eq(billingRecords.customerId, customerId));

  const draft = drafts.find(d => d.status === 'draft');

  if (!draft) {
    return {
      success: false,
      error: 'No DRAFT invoice found for customer',
    };
  }

  // Use transaction with unsafeAsLockedTransaction for test context
  const result = await db.transaction(async (tx) => {
    const lockedTx = unsafeAsLockedTransaction(tx);
    return syncUsageToDraft(lockedTx, customerId, draft.id, dbClock);
  });

  return {
    success: result.success,
    invoiceId: draft.id,
    totalUsageChargesCents: result.totalUsageChargesCents,
    lineItemsCount: result.lineItemsCount,
    error: result.error,
  };
}
