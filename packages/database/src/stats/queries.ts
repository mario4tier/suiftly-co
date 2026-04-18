/**
 * Stats Query Functions (STATS_DESIGN.md D4)
 *
 * Hybrid query pattern: stats_per_hour for completed hours + stats_per_min
 * for the current-hour tail. Gives ~1-2 minute freshness without additional
 * infrastructure — stats_per_min is already maintained by TimescaleDB.
 *
 * Charts append a partial bar for the current hour (flagged with partial: true)
 * so the UI can render it with distinct visual treatment.
 */

import { sql } from 'drizzle-orm';
import type { Database, DatabaseOrTransaction } from '../db';
import type { DBClock } from '@suiftly/shared/db-clock';

// ============================================================================
// Types
// ============================================================================

/**
 * Summary stats for dashboard (configurable range)
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
  /** True if this bucket is still accumulating (current incomplete period) */
  partial?: boolean;
}

/**
 * Response time data point for time-series graphs (whisker chart)
 */
export interface ResponseTimeDataPoint {
  /** Time bucket (hour or day start) */
  bucket: Date;
  /** Average response time in milliseconds */
  avgResponseTimeMs: number;
  /** Minimum response time in milliseconds */
  minResponseTimeMs: number;
  /** Maximum response time in milliseconds */
  maxResponseTimeMs: number;
  /** True if this bucket is still accumulating (current incomplete period) */
  partial?: boolean;
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
  /** True if this bucket is still accumulating (current incomplete period) */
  partial?: boolean;
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

/**
 * Compute the cutoff time: start of the current hour.
 * stats_per_hour covers completed hours (bucket < cutoff).
 * stats_per_min covers the current hour tail (bucket >= cutoff).
 */
function hourCutoff(now: Date): Date {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  return d;
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get summary stats for a customer's service over the given time range.
 *
 * Uses hybrid query: stats_per_hour for completed hours, stats_per_min for
 * the current-hour tail (~1-2 min freshness).
 */
export async function getStatsSummary(
  db: Database,
  customerId: number,
  serviceType: number,
  clock: DBClock,
  range: TimeRange = '24h'
): Promise<StatsSummary> {
  const now = clock.now();
  const { interval } = getTimeRangeParams(range);
  const startTime = new Date(now.getTime() - parseInterval(interval));
  const cutoff = hourCutoff(now);

  // Hourly aggregate for completed hours
  const hourlyResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(success_count), 0)::integer AS success_count,
      COALESCE(SUM(dropped_count), 0)::integer AS dropped_count,
      COALESCE(SUM(client_error_count), 0)::integer AS client_error_count,
      COALESCE(SUM(server_error_count), 0)::integer AS server_error_count
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${startTime}
      AND bucket < ${cutoff}
  `);

  // Minute aggregate for current-hour tail
  const minuteResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 200 AND status_code < 300), 0)::integer AS success_count,
      COALESCE(SUM(request_count) FILTER (WHERE traffic_type IN (3, 4, 5, 6)), 0)::integer AS dropped_count,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 400 AND status_code < 500 AND traffic_type NOT IN (3, 4, 5, 6)), 0)::integer AS client_error_count,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 500 AND traffic_type NOT IN (3, 4, 5, 6)), 0)::integer AS server_error_count
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${now}
  `);

  const h = hourlyResult.rows[0] as any;
  const m = minuteResult.rows[0] as any;

  const successCount = Number(h?.success_count ?? 0) + Number(m?.success_count ?? 0);
  const droppedCount = Number(h?.dropped_count ?? 0) + Number(m?.dropped_count ?? 0);
  const clientErrorCount = Number(h?.client_error_count ?? 0) + Number(m?.client_error_count ?? 0);
  const serverErrorCount = Number(h?.server_error_count ?? 0) + Number(m?.server_error_count ?? 0);

  return {
    successCount,
    droppedCount,
    clientErrorCount,
    serverErrorCount,
    totalRequests: successCount + droppedCount + clientErrorCount + serverErrorCount,
  };
}

/**
 * Get usage stats over time with a partial current-hour bar from stats_per_min.
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
  const startTime = new Date(now.getTime() - parseInterval(interval));
  const cutoff = hourCutoff(now);

  let points: UsageDataPoint[];

  if (bucketSize === '1 day') {
    const result = await db.execute(sql.raw(`
      SELECT
        date_trunc('day', bucket) AS bucket,
        SUM(billable_requests)::bigint AS billable_requests
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= '${startTime.toISOString()}'::timestamptz
        AND bucket < '${cutoff.toISOString()}'::timestamptz
      GROUP BY date_trunc('day', bucket)
      ORDER BY bucket ASC
    `));

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      billableRequests: Number(row.billable_requests ?? 0),
    }));
  } else {
    const result = await db.execute(sql`
      SELECT bucket, billable_requests
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= ${startTime}
        AND bucket < ${cutoff}
      ORDER BY bucket ASC
    `);

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      billableRequests: Number(row.billable_requests ?? 0),
    }));
  }

  // Append partial current-period bar from stats_per_min
  const tailResult = await db.execute(sql`
    SELECT COALESCE(SUM(request_count) FILTER (WHERE traffic_type IN (1, 2)), 0)::bigint AS billable_requests
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${now}
  `);
  const tailRow = tailResult.rows[0] as any;
  const tailCount = Number(tailRow?.billable_requests ?? 0);

  if (tailCount > 0) {
    // For daily view, merge into today's bucket if it exists
    if (bucketSize === '1 day') {
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const existing = points.find(p => p.bucket.getTime() === todayStart.getTime());
      if (existing) {
        existing.billableRequests += tailCount;
        existing.partial = true;
      } else {
        points.push({ bucket: todayStart, billableRequests: tailCount, partial: true });
      }
    } else {
      points.push({ bucket: cutoff, billableRequests: tailCount, partial: true });
    }
  }

  return points;
}

/**
 * Get response time stats with a partial current-hour bar from stats_per_min.
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
  const startTime = new Date(now.getTime() - parseInterval(interval));
  const cutoff = hourCutoff(now);

  let points: ResponseTimeDataPoint[];
  // Per-bucket hourly request totals, kept alongside points so the current-hour
  // tail can be weighted-merged into today's bar for 7d/30d (daily) views.
  // Not returned to callers.
  const dailyCounts = new Map<number, number>();

  if (bucketSize === '1 day') {
    const result = await db.execute(sql.raw(`
      SELECT
        date_trunc('day', bucket) AS bucket,
        SUM(avg_response_time_ms * COALESCE(billable_requests, 0))::double precision / SUM(COALESCE(billable_requests, 0)) AS avg_response_time_ms,
        MIN(min_response_time_ms)::integer AS min_response_time_ms,
        MAX(max_response_time_ms)::integer AS max_response_time_ms,
        SUM(COALESCE(billable_requests, 0))::bigint AS daily_count
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= '${startTime.toISOString()}'::timestamptz
        AND bucket < '${cutoff.toISOString()}'::timestamptz
      GROUP BY date_trunc('day', bucket)
      HAVING SUM(COALESCE(billable_requests, 0)) > 0
      ORDER BY bucket ASC
    `));

    points = result.rows.map((row: any) => {
      const bucket = new Date(row.bucket);
      dailyCounts.set(bucket.getTime(), Number(row.daily_count ?? 0));
      return {
        bucket,
        avgResponseTimeMs: Number(row.avg_response_time_ms),
        minResponseTimeMs: Number(row.min_response_time_ms),
        maxResponseTimeMs: Number(row.max_response_time_ms),
      };
    });
  } else {
    const result = await db.execute(sql`
      SELECT bucket, avg_response_time_ms, min_response_time_ms, max_response_time_ms
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= ${startTime}
        AND bucket < ${cutoff}
        AND billable_requests > 0
      ORDER BY bucket ASC
    `);

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      avgResponseTimeMs: Number(row.avg_response_time_ms),
      minResponseTimeMs: Number(row.min_response_time_ms),
      maxResponseTimeMs: Number(row.max_response_time_ms),
    }));
  }

  // Append partial current-hour response times from stats_per_min
  // Only include billable traffic (traffic_type 1,2) to match hourly behavior
  const tailResult = await db.execute(sql`
    SELECT
      avg_rt_ms,
      min_rt_ms,
      max_rt_ms,
      request_count
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${now}
      AND traffic_type IN (1, 2)
  `);

  if (tailResult.rows.length > 0) {
    let weightedSum = 0;
    let totalCount = 0;
    let minRt = Infinity;
    let maxRt = 0;
    for (const row of tailResult.rows as any[]) {
      const count = Number(row.request_count ?? 0);
      const avg = Number(row.avg_rt_ms ?? 0);
      const mn = Number(row.min_rt_ms ?? 0);
      const mx = Number(row.max_rt_ms ?? 0);
      if (count > 0) {
        weightedSum += avg * count;
        totalCount += count;
        if (mn < minRt) minRt = mn;
        if (mx > maxRt) maxRt = mx;
      }
    }
    if (totalCount > 0) {
      const tailPoint: ResponseTimeDataPoint = {
        bucket: cutoff,
        avgResponseTimeMs: weightedSum / totalCount,
        minResponseTimeMs: minRt === Infinity ? 0 : minRt,
        maxResponseTimeMs: maxRt,
        partial: true,
      };
      // For daily view, merge tail into today's bar (weighted avg on hourly
      // billable_requests + tail count; simple min/max across both sources).
      if (bucketSize === '1 day') {
        const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const existing = points.find(p => p.bucket.getTime() === todayStart.getTime());
        if (existing) {
          const hourlyCount = dailyCounts.get(existing.bucket.getTime()) ?? 0;
          const combinedCount = hourlyCount + totalCount;
          if (combinedCount > 0) {
            existing.avgResponseTimeMs =
              (existing.avgResponseTimeMs * hourlyCount + weightedSum) / combinedCount;
            existing.minResponseTimeMs = Math.min(existing.minResponseTimeMs, tailPoint.minResponseTimeMs);
            existing.maxResponseTimeMs = Math.max(existing.maxResponseTimeMs, tailPoint.maxResponseTimeMs);
          }
          existing.partial = true;
        } else {
          tailPoint.bucket = todayStart;
          points.push(tailPoint);
        }
      } else {
        points.push(tailPoint);
      }
    }
  }

  return points;
}

/**
 * Get traffic breakdown stats with a partial current-hour bar from stats_per_min.
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
  const startTime = new Date(now.getTime() - parseInterval(interval));
  const cutoff = hourCutoff(now);

  let points: TrafficDataPoint[];

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
        AND bucket >= '${startTime.toISOString()}'::timestamptz
        AND bucket < '${cutoff.toISOString()}'::timestamptz
      GROUP BY date_trunc('day', bucket)
      ORDER BY bucket ASC
    `));

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      guaranteed: Number(row.guaranteed ?? 0),
      burst: Number(row.burst ?? 0),
      dropped: Number(row.dropped ?? 0),
      clientError: Number(row.client_error ?? 0),
      serverError: Number(row.server_error ?? 0),
    }));
  } else {
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
        AND bucket >= ${startTime}
        AND bucket < ${cutoff}
      ORDER BY bucket ASC
    `);

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      guaranteed: Number(row.guaranteed ?? 0),
      burst: Number(row.burst ?? 0),
      dropped: Number(row.dropped ?? 0),
      clientError: Number(row.client_error ?? 0),
      serverError: Number(row.server_error ?? 0),
    }));
  }

  // Append partial current-hour from stats_per_min
  const tailResult = await db.execute(sql`
    SELECT
      COALESCE(SUM(request_count) FILTER (WHERE traffic_type = 1 AND status_code >= 200 AND status_code < 300), 0)::bigint AS guaranteed,
      COALESCE(SUM(request_count) FILTER (WHERE traffic_type = 2 AND status_code >= 200 AND status_code < 300), 0)::bigint AS burst,
      COALESCE(SUM(request_count) FILTER (WHERE traffic_type IN (3, 4, 5, 6)), 0)::bigint AS dropped,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 400 AND status_code < 500 AND traffic_type NOT IN (3, 4, 5, 6)), 0)::bigint AS client_error,
      COALESCE(SUM(request_count) FILTER (WHERE status_code >= 500 AND traffic_type NOT IN (3, 4, 5, 6)), 0)::bigint AS server_error
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${now}
  `);
  const t = tailResult.rows[0] as any;
  const tailTotal = Number(t?.guaranteed ?? 0) + Number(t?.burst ?? 0) + Number(t?.dropped ?? 0) + Number(t?.client_error ?? 0) + Number(t?.server_error ?? 0);

  if (tailTotal > 0) {
    const tailPoint: TrafficDataPoint = {
      bucket: cutoff,
      guaranteed: Number(t.guaranteed ?? 0),
      burst: Number(t.burst ?? 0),
      dropped: Number(t.dropped ?? 0),
      clientError: Number(t.client_error ?? 0),
      serverError: Number(t.server_error ?? 0),
      partial: true,
    };

    if (bucketSize === '1 day') {
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const existing = points.find(p => p.bucket.getTime() === todayStart.getTime());
      if (existing) {
        existing.guaranteed += tailPoint.guaranteed;
        existing.burst += tailPoint.burst;
        existing.dropped += tailPoint.dropped;
        existing.clientError += tailPoint.clientError;
        existing.serverError += tailPoint.serverError;
        existing.partial = true;
      } else {
        tailPoint.bucket = todayStart;
        points.push(tailPoint);
      }
    } else {
      points.push(tailPoint);
    }
  }

  return points;
}

/**
 * Get bandwidth stats with a partial current-hour bar from stats_per_min.
 */
export async function getBandwidthStats(
  db: DatabaseOrTransaction,
  customerId: number,
  serviceType: number,
  interval: string = '24 hours',
  clock?: DBClock
): Promise<Array<{ bucket: Date; bytes: number; partial?: boolean }>> {
  const now = clock?.now() ?? new Date();
  const cutoff = hourCutoff(now);
  const isDaily = interval === '7 days' || interval === '30 days';

  let points: Array<{ bucket: Date; bytes: number; partial?: boolean }>;

  if (isDaily) {
    const result = await db.execute(sql`
      SELECT
        date_trunc('day', bucket) AS bucket,
        COALESCE(SUM(total_bytes), 0)::bigint AS bytes
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= ${new Date(now.getTime() - parseInterval(interval))}
        AND bucket < ${cutoff}
      GROUP BY date_trunc('day', bucket)
      ORDER BY bucket ASC
    `);

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      bytes: Number(row.bytes ?? 0),
    }));
  } else {
    const result = await db.execute(sql`
      SELECT bucket, COALESCE(total_bytes, 0)::bigint AS bytes
      FROM stats_per_hour
      WHERE customer_id = ${customerId}
        AND service_type = ${serviceType}
        AND bucket >= ${new Date(now.getTime() - parseInterval(interval))}
        AND bucket < ${cutoff}
      ORDER BY bucket ASC
    `);

    points = result.rows.map((row: any) => ({
      bucket: new Date(row.bucket),
      bytes: Number(row.bytes ?? 0),
    }));
  }

  // Append partial current-period from stats_per_min.
  // Exclude traffic_type=8 stream-close echoes — the underlying bytes were
  // already counted via the poller's traffic_type=7 rows.
  const tailResult = await db.execute(sql`
    SELECT COALESCE(SUM(total_bytes) FILTER (WHERE traffic_type <> 8), 0)::bigint AS bytes
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${now}
  `);
  const tailBytes = Number((tailResult.rows[0] as any)?.bytes ?? 0);

  if (tailBytes > 0) {
    if (isDaily) {
      const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const existing = points.find(p => p.bucket.getTime() === todayStart.getTime());
      if (existing) {
        existing.bytes += tailBytes;
        existing.partial = true;
      } else {
        points.push({ bucket: todayStart, bytes: tailBytes, partial: true });
      }
    } else {
      points.push({ bucket: cutoff, bytes: tailBytes, partial: true });
    }
  }

  return points;
}

/**
 * Get total billable requests using hybrid query (hourly + minute tail).
 * Used by billing to calculate usage charges with near-real-time accuracy.
 *
 * Contract: `startTime` must be hour-aligned. Billing windows are defined by
 * calendar cycles (e.g. start-of-month), not by per-service timestamps like
 * `enabledAt`. Callers compute the window boundary.
 */
export async function getBillableRequestCount(
  db: DatabaseOrTransaction,
  customerId: number,
  serviceType: number,
  startTime: Date,
  endTime: Date
): Promise<number> {
  const cutoff = hourCutoff(endTime);

  // Hourly aggregate for completed hours
  const hourlyResult = await db.execute(sql`
    SELECT COALESCE(SUM(billable_requests), 0)::bigint AS total
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${startTime}
      AND bucket < ${cutoff}
  `);

  // Minute tail for the current hour.
  // Contract: startTime is hour-aligned (billing window = calendar cycle).
  const minuteResult = await db.execute(sql`
    SELECT COALESCE(SUM(request_count) FILTER (WHERE traffic_type IN (1, 2)), 0)::bigint AS total
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${endTime}
  `);

  return Number((hourlyResult.rows[0] as any)?.total ?? 0) + Number((minuteResult.rows[0] as any)?.total ?? 0);
}

/**
 * Get total billable bandwidth using hybrid query (hourly + minute tail).
 * Used by billing to calculate bandwidth charges with near-real-time accuracy.
 *
 * Contract: same as `getBillableRequestCount` — `startTime` must be hour-aligned.
 */
export async function getBillableBandwidth(
  db: DatabaseOrTransaction,
  customerId: number,
  serviceType: number,
  startTime: Date,
  endTime: Date
): Promise<number> {
  const cutoff = hourCutoff(endTime);

  const hourlyResult = await db.execute(sql`
    SELECT COALESCE(SUM(billable_bytes), 0)::bigint AS total
    FROM stats_per_hour
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${startTime}
      AND bucket < ${cutoff}
  `);

  // stats_per_min doesn't have billable_bytes; compute from traffic_type filter.
  // Contract: startTime is hour-aligned (billing window = calendar cycle).
  // traffic_type = 7 = stream_delta (periodic bytes from long-lived streams);
  // see docs/STREAM_METERING_FEATURE.md. Stream deltas count toward billable
  // bandwidth but not toward billable_requests.
  const minuteResult = await db.execute(sql`
    SELECT COALESCE(SUM(total_bytes) FILTER (WHERE traffic_type IN (1, 2, 7)), 0)::bigint AS total
    FROM stats_per_min
    WHERE customer_id = ${customerId}
      AND service_type = ${serviceType}
      AND bucket >= ${cutoff}
      AND bucket < ${endTime}
  `);

  return Number((hourlyResult.rows[0] as any)?.total ?? 0) + Number((minuteResult.rows[0] as any)?.total ?? 0);
}

/**
 * Parse interval string to milliseconds
 */
function parseInterval(interval: string): number {
  const match = interval.match(/(\d+)\s*(hour|day|week|month)s?/i);
  if (!match) return 24 * 60 * 60 * 1000;

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
