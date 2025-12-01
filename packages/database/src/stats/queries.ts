/**
 * Stats Query Functions (STATS_DESIGN.md D4)
 *
 * Query functions for stats_per_hour continuous aggregate.
 * Used by dashboard summary and service stats page.
 */

import { sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import type { DBClock } from '@suiftly/shared/db-clock';

// ============================================================================
// Types
// ============================================================================

/**
 * 24-hour summary stats for dashboard
 */
export interface StatsSummary {
  /** Count of 2xx responses */
  successCount: number;
  /** Count of rate limited requests (traffic_type 3-6) */
  droppedCount: number;
  /** Count of 4xx responses */
  clientErrorCount: number;
  /** Count of 5xx responses */
  serverErrorCount: number;
  /** Total requests (success + dropped + errors) */
  totalRequests: number;
}

/**
 * Usage data point for time-series graphs
 */
export interface UsageDataPoint {
  /** Time bucket (hour or day start) */
  bucket: Date;
  /** Billable request count (traffic_type 1 or 2) */
  billableRequests: number;
}

/**
 * Response time data point for time-series graphs
 */
export interface ResponseTimeDataPoint {
  /** Time bucket (hour or day start) */
  bucket: Date;
  /** Average response time in milliseconds */
  avgResponseTimeMs: number;
}

/**
 * Traffic breakdown data point for stacked chart (STATS_DESIGN.md R3b)
 */
export interface TrafficDataPoint {
  /** Time bucket (hour or day start) */
  bucket: Date;
  /** Guaranteed traffic with 2xx status */
  guaranteed: number;
  /** Burst traffic with 2xx status */
  burst: number;
  /** Dropped traffic (exceeded limits or congestion) */
  dropped: number;
  /** Client errors (4xx) across all traffic types */
  clientError: number;
  /** Server errors (5xx) across all traffic types */
  serverError: number;
}

/**
 * Time range options for queries
 */
export type TimeRange = '24h' | '7d' | '30d';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get interval and bucket size for time range
 */
function getTimeRangeParams(range: TimeRange): { interval: string; bucketSize: string } {
  switch (range) {
    case '24h':
      return { interval: '24 hours', bucketSize: '1 hour' };
    case '7d':
      return { interval: '7 days', bucketSize: '1 day' };
    case '30d':
      return { interval: '30 days', bucketSize: '1 day' };
    default:
      return { interval: '24 hours', bucketSize: '1 hour' };
  }
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get 24-hour summary stats for a customer's service
 *
 * Used by dashboard to show quick overview of request counts.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type (1=Seal, 2=SSFN, 3=Sealo)
 * @param clock DBClock for time reference
 * @returns Summary stats for last 24 hours
 */
export async function getStatsSummary(
  db: Database,
  customerId: number,
  serviceType: number,
  clock: DBClock
): Promise<StatsSummary> {
  const now = clock.now();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(success_count), 0)::integer AS success_count,
      COALESCE(SUM(dropped_count), 0)::integer AS dropped_count,
      COALESCE(SUM(client_error_count), 0)::integer AS client_error_count,
      COALESCE(SUM(server_error_count), 0)::integer AS server_error_count
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${startTime}
      AND bucket < ${now}
  `);

  const row = result.rows[0] as any;

  const successCount = Number(row?.success_count ?? 0);
  const droppedCount = Number(row?.dropped_count ?? 0);
  const clientErrorCount = Number(row?.client_error_count ?? 0);
  const serverErrorCount = Number(row?.server_error_count ?? 0);

  return {
    successCount,
    droppedCount,
    clientErrorCount,
    serverErrorCount,
    totalRequests: successCount + droppedCount + clientErrorCount + serverErrorCount,
  };
}

/**
 * Get usage stats over time for a customer's service
 *
 * Used by service stats page to show request volume graph.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type (1=Seal, 2=SSFN, 3=Sealo)
 * @param range Time range ('24h', '7d', '30d')
 * @param clock DBClock for time reference
 * @returns Array of usage data points
 */
export async function getUsageStats(
  db: Database,
  customerId: number,
  serviceType: number,
  range: TimeRange,
  clock: DBClock
): Promise<UsageDataPoint[]> {
  const now = clock.now();
  const { interval, bucketSize } = getTimeRangeParams(range);

  // For daily aggregation, we need to re-bucket the hourly data
  if (bucketSize === '1 day') {
    const result = await db.execute(sql.raw(`
      SELECT
        date_trunc('day', bucket) AS bucket,
        SUM(billable_requests)::bigint AS billable_requests
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= NOW() - INTERVAL '${interval}'
        AND bucket < '${now.toISOString()}'::timestamptz
      GROUP BY date_trunc('day', bucket)
      ORDER BY bucket ASC
    `));

    return result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      billableRequests: Number(row.billable_requests ?? 0),
    }));
  }

  // Hourly data - use directly from continuous aggregate
  const result = await db.execute(sql`
    SELECT
      bucket,
      billable_requests
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${new Date(now.getTime() - parseInterval(interval))}
      AND bucket < ${now}
    ORDER BY bucket ASC
  `);

  return result.rows.map((row: any) => ({
    bucket: new Date(row.bucket),
    billableRequests: Number(row.billable_requests ?? 0),
  }));
}

/**
 * Get response time stats over time for a customer's service
 *
 * Used by service stats page to show latency graph.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type (1=Seal, 2=SSFN, 3=Sealo)
 * @param range Time range ('24h', '7d', '30d')
 * @param clock DBClock for time reference
 * @returns Array of response time data points
 */
export async function getResponseTimeStats(
  db: Database,
  customerId: number,
  serviceType: number,
  range: TimeRange,
  clock: DBClock
): Promise<ResponseTimeDataPoint[]> {
  const now = clock.now();
  const { interval, bucketSize } = getTimeRangeParams(range);

  // For daily aggregation, compute weighted average
  if (bucketSize === '1 day') {
    const result = await db.execute(sql.raw(`
      SELECT
        date_trunc('day', bucket) AS bucket,
        AVG(avg_response_time_ms)::double precision AS avg_response_time_ms
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= NOW() - INTERVAL '${interval}'
        AND bucket < '${now.toISOString()}'::timestamptz
      GROUP BY date_trunc('day', bucket)
      ORDER BY bucket ASC
    `));

    return result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      avgResponseTimeMs: Number(row.avg_response_time_ms ?? 0),
    }));
  }

  // Hourly data - use directly from continuous aggregate
  const result = await db.execute(sql`
    SELECT
      bucket,
      avg_response_time_ms
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${new Date(now.getTime() - parseInterval(interval))}
      AND bucket < ${now}
    ORDER BY bucket ASC
  `);

  return result.rows.map((row: any) => ({
    bucket: new Date(row.bucket),
    avgResponseTimeMs: Number(row.avg_response_time_ms ?? 0),
  }));
}

/**
 * Get traffic breakdown stats over time for a customer's service
 *
 * Used by service stats page to show stacked traffic chart.
 * Shows: Guaranteed, Burst, Dropped, Client Errors, Server Errors
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type (1=Seal, 2=SSFN, 3=Sealo)
 * @param range Time range ('24h', '7d', '30d')
 * @param clock DBClock for time reference
 * @returns Array of traffic breakdown data points
 */
export async function getTrafficStats(
  db: Database,
  customerId: number,
  serviceType: number,
  range: TimeRange,
  clock: DBClock
): Promise<TrafficDataPoint[]> {
  const now = clock.now();
  const { interval, bucketSize } = getTimeRangeParams(range);

  // For daily aggregation, we need to re-bucket the hourly data
  if (bucketSize === '1 day') {
    const result = await db.execute(sql.raw(`
      SELECT
        date_trunc('day', bucket) AS bucket,
        SUM(guaranteed_success_count)::bigint AS guaranteed,
        SUM(burst_success_count)::bigint AS burst,
        SUM(dropped_count)::bigint AS dropped,
        SUM(client_error_count)::bigint AS client_error,
        SUM(server_error_count)::bigint AS server_error
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= NOW() - INTERVAL '${interval}'
        AND bucket < '${now.toISOString()}'::timestamptz
      GROUP BY date_trunc('day', bucket)
      ORDER BY bucket ASC
    `));

    return result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      guaranteed: Number(row.guaranteed ?? 0),
      burst: Number(row.burst ?? 0),
      dropped: Number(row.dropped ?? 0),
      clientError: Number(row.client_error ?? 0),
      serverError: Number(row.server_error ?? 0),
    }));
  }

  // Hourly data - use directly from continuous aggregate
  const result = await db.execute(sql`
    SELECT
      bucket,
      guaranteed_success_count AS guaranteed,
      burst_success_count AS burst,
      dropped_count AS dropped,
      client_error_count AS client_error,
      server_error_count AS server_error
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${new Date(now.getTime() - parseInterval(interval))}
      AND bucket < ${now}
    ORDER BY bucket ASC
  `);

  return result.rows.map((row: any) => ({
    bucket: new Date(row.bucket),
    guaranteed: Number(row.guaranteed ?? 0),
    burst: Number(row.burst ?? 0),
    dropped: Number(row.dropped ?? 0),
    clientError: Number(row.client_error ?? 0),
    serverError: Number(row.server_error ?? 0),
  }));
}

/**
 * Get total billable requests for a customer in a time range
 *
 * Used by billing to calculate usage charges.
 *
 * @param db Database instance
 * @param customerId Customer ID
 * @param serviceType Service type
 * @param startTime Start of billing period
 * @param endTime End of billing period
 * @returns Total billable request count
 */
export async function getBillableRequestCount(
  db: Database,
  customerId: number,
  serviceType: number,
  startTime: Date,
  endTime: Date
): Promise<number> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(billable_requests), 0)::bigint AS total
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${startTime}
      AND bucket < ${endTime}
  `);

  return Number((result.rows[0] as any)?.total ?? 0);
}

/**
 * Parse interval string to milliseconds
 */
function parseInterval(interval: string): number {
  const match = interval.match(/(\d+)\s*(hour|day|week|month)s?/i);
  if (!match) return 24 * 60 * 60 * 1000; // Default 24 hours

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'hour':
      return value * 60 * 60 * 1000;
    case 'day':
      return value * 24 * 60 * 60 * 1000;
    case 'week':
      return value * 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return value * 30 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}
