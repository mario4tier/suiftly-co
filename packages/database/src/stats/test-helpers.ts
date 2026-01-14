/**
 * Test helpers for stats system (STATS_DESIGN.md D6)
 *
 * Provides mock data insertion for testing stats queries and billing integration.
 * These helpers are used by unit tests and the /test/stats/* API endpoints.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../db';
import { haproxyRawLogs } from '../schema/logs';

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
 * Clear HAProxy logs for a customer (test cleanup)
 *
 * @param db Database instance
 * @param customerId Customer ID to clear logs for
 * @param serviceType Optional service type to filter (1=seal, 2=grpc, 3=graphql). If omitted, clears all services.
 */
export async function clearCustomerLogs(
  db: Database,
  customerId: number,
  serviceType?: number
): Promise<void> {
  if (serviceType !== undefined) {
    await db.execute(
      sql`DELETE FROM haproxy_raw_logs WHERE customer_id = ${customerId} AND service_type = ${serviceType}`
    );
  } else {
    await db.execute(
      sql`DELETE FROM haproxy_raw_logs WHERE customer_id = ${customerId}`
    );
  }
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
 * Options for inserting infrastructure log entries (for InfraStats page testing)
 */
export interface InfraLogOptions {
  /** Service type: 1=Seal, 2=gRPC, 3=GraphQL */
  serviceType: 1 | 2 | 3;
  /** Network: 0=testnet, 1=mainnet */
  network: 0 | 1;
  /** Base timestamp for the logs */
  timestamp: Date;
  /** Event type (0=success, 10-17=auth, 20-21=ip, 30-39=authz, 50-54=backend, 60-63=infra) */
  eventType: number;
  /** HTTP status code (default: derived from event type) */
  statusCode?: number;
  /** Server ID (default: 1) */
  serverId?: number;
  /** Backend ID (default: 1) */
  backendId?: number;
  /** Total response time in ms */
  timeTotal?: number;
  /** Queue time in ms */
  timeQueue?: number;
  /** Connect time in ms */
  timeConnect?: number;
  /** Backend response time in ms */
  timeResponse?: number;
  /** Number of identical entries to insert as separate rows (default: 1) */
  count?: number;
  /**
   * Repeat count for a single row (default: 1)
   * Use this for efficiency when inserting many identical requests.
   * Creates a single row with repeat=N instead of N rows.
   */
  repeat?: number;
  /** Optional customer ID (null for anonymous/infra-only logs) */
  customerId?: number | null;
}

/**
 * Insert infrastructure log entries for InfraStats testing
 *
 * Unlike insertMockHAProxyLogs which focuses on customer traffic,
 * this function is designed for infra stats testing with:
 * - Various event types (errors)
 * - Fine-grained timing control
 * - Multi-server/backend support
 * - Optional customer association
 *
 * @param db Database instance
 * @param options Configuration for the logs
 * @returns Number of records inserted
 */
export async function insertInfraLogs(
  db: Database,
  options: InfraLogOptions
): Promise<number> {
  const {
    serviceType,
    network,
    timestamp,
    eventType,
    serverId = 1,
    backendId = 1,
    count = 1,
    repeat = 1,
    customerId = null,
  } = options;

  // Derive status code from event type if not provided
  let statusCode = options.statusCode;
  if (statusCode === undefined) {
    if (eventType === 0) {
      statusCode = 200;
    } else if (eventType >= 10 && eventType <= 17) {
      statusCode = 400; // Auth/protocol errors
    } else if (eventType >= 20 && eventType <= 21) {
      statusCode = 403; // IP access errors
    } else if (eventType >= 30 && eventType <= 39) {
      statusCode = 403; // Authorization errors
    } else if (eventType >= 50 && eventType <= 54) {
      // Backend errors
      const backendStatusMap: Record<number, number> = {
        50: 500, 51: 502, 52: 503, 53: 504, 54: 500,
      };
      statusCode = backendStatusMap[eventType] ?? 500;
    } else if (eventType >= 60 && eventType <= 63) {
      statusCode = 503; // Infrastructure errors
    } else {
      statusCode = 500;
    }
  }

  // Derive timing values if not provided
  const timeTotal = options.timeTotal ?? 100;
  const timeQueue = options.timeQueue ?? Math.floor(timeTotal * 0.05);
  const timeConnect = options.timeConnect ?? Math.floor(timeTotal * 0.1);
  const timeResponse = options.timeResponse ?? Math.floor(timeTotal * 0.85);

  const entries = [];
  const baseTime = timestamp.getTime();

  for (let i = 0; i < count; i++) {
    entries.push({
      timestamp: new Date(baseTime + i),
      customerId: customerId,
      pathPrefix: customerId ? '/v1/test' : null,
      configHex: null,
      network,
      serverId,
      serviceType,
      apiKeyFp: customerId ? 12345 : 0,
      feType: 1 as const,
      trafficType: 1, // guaranteed
      eventType,
      clientIp: '127.0.0.1',
      keyMetadata: null,
      statusCode,
      bytesSent: eventType === 0 ? 1024 : 0,
      timeTotal,
      timeRequest: Math.floor(timeTotal * 0.05),
      timeQueue,
      timeConnect,
      timeResponse,
      backendId: backendId as 0 | 1 | 2 | 3 | 4 | 5,
      terminationState: eventType === 0 ? '--' : 'sH',
      repeat,
    });
  }

  // Batch insert
  const BATCH_SIZE = 1000;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await db.insert(haproxyRawLogs).values(batch);
  }

  return count * repeat;
}

/**
 * Refresh the infrastructure continuous aggregates
 *
 * Forces an immediate refresh of infra_per_min, infra_per_hour, and infra_per_day.
 * Use this in tests after inserting mock data to make it available for queries.
 *
 * @param db Database instance
 * @param startTime Optional start time for refresh window (default: 5 years ago)
 * @param endTime Optional end time for refresh window (default: 1 hour from now)
 */
export async function refreshInfraAggregates(
  db: Database,
  startTime?: Date,
  endTime?: Date
): Promise<void> {
  const start = startTime
    ? `'${startTime.toISOString()}'::timestamptz`
    : `NOW() - INTERVAL '5 years'`;
  const end = endTime
    ? `'${endTime.toISOString()}'::timestamptz`
    : `NOW() + INTERVAL '1 hour'`;

  // Refresh in order due to cascade dependencies: min -> hour -> day
  await db.execute(
    sql.raw(`CALL refresh_continuous_aggregate('infra_per_min', ${start}, ${end})`)
  );
  await db.execute(
    sql.raw(`CALL refresh_continuous_aggregate('infra_per_hour', ${start}, ${end})`)
  );
  await db.execute(
    sql.raw(`CALL refresh_continuous_aggregate('infra_per_day', ${start}, ${end})`)
  );
}

