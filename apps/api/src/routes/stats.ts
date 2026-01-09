/**
 * Stats Router (STATS_DESIGN.md D4)
 *
 * tRPC endpoints for stats queries.
 * All endpoints require authentication.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../lib/trpc';
import { db } from '@suiftly/database';
import { dbClockProvider } from '@suiftly/shared/db-clock';
import { SERVICE_TYPE_NUMBER, type ServiceType } from '@suiftly/shared';
import {
  getStatsSummary,
  getUsageStats,
  getResponseTimeStats,
  getTrafficStats,
  insertMockHAProxyLogs,
  insertMockMixedLogs,
  refreshStatsAggregate,
  clearCustomerLogs,
  type TimeRange,
} from '@suiftly/database/stats';
import { getUsageChargePreview, forceSyncUsageToDraft } from '@suiftly/database/billing';
import { config } from '../lib/config';

// Validation schemas
const serviceTypeSchema = z.enum(['seal', 'grpc', 'graphql']);
const timeRangeSchema = z.enum(['24h', '7d', '30d']);

export const statsRouter = router({
  /**
   * Get 24-hour summary stats for dashboard
   *
   * Returns success/error counts for the last 24 hours.
   */
  getSummary: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .query(async ({ ctx, input }) => {
      const clock = dbClockProvider.getClock();
      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType];

      const summary = await getStatsSummary(
        db,
        ctx.user.customerId,
        serviceTypeNum,
        clock
      );

      return summary;
    }),

  /**
   * Get usage stats over time for stats page
   *
   * Returns billable request counts per time bucket.
   */
  getUsage: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      range: timeRangeSchema.default('24h'),
    }))
    .query(async ({ ctx, input }) => {
      const clock = dbClockProvider.getClock();
      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType];

      const stats = await getUsageStats(
        db,
        ctx.user.customerId,
        serviceTypeNum,
        input.range as TimeRange,
        clock
      );

      // Transform dates to ISO strings for JSON serialization
      return stats.map(point => ({
        bucket: point.bucket.toISOString(),
        billableRequests: point.billableRequests,
      }));
    }),

  /**
   * Get response time stats over time for stats page
   *
   * Returns average response time per time bucket.
   */
  getResponseTime: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      range: timeRangeSchema.default('24h'),
    }))
    .query(async ({ ctx, input }) => {
      const clock = dbClockProvider.getClock();
      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType];

      const stats = await getResponseTimeStats(
        db,
        ctx.user.customerId,
        serviceTypeNum,
        input.range as TimeRange,
        clock
      );

      // Transform dates to ISO strings for JSON serialization
      return stats.map(point => ({
        bucket: point.bucket.toISOString(),
        avgResponseTimeMs: point.avgResponseTimeMs,
        minResponseTimeMs: point.minResponseTimeMs,
        maxResponseTimeMs: point.maxResponseTimeMs,
      }));
    }),

  /**
   * Get traffic breakdown stats over time for stats page
   *
   * Returns stacked traffic data: guaranteed, burst, dropped, client/server errors.
   */
  getTraffic: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      range: timeRangeSchema.default('24h'),
    }))
    .query(async ({ ctx, input }) => {
      const clock = dbClockProvider.getClock();
      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType];

      const stats = await getTrafficStats(
        db,
        ctx.user.customerId,
        serviceTypeNum,
        input.range as TimeRange,
        clock
      );

      // Transform dates to ISO strings for JSON serialization
      return stats.map(point => ({
        bucket: point.bucket.toISOString(),
        guaranteed: point.guaranteed,
        burst: point.burst,
        dropped: point.dropped,
        clientError: point.clientError,
        serverError: point.serverError,
      }));
    }),

  /**
   * Get preview of pending usage charges
   *
   * Shows what usage charges would be added at next billing.
   * Useful for dashboard "pending charges" display.
   */
  getUsagePreview: protectedProcedure.query(async ({ ctx }) => {
    const clock = dbClockProvider.getClock();

    const preview = await getUsageChargePreview(
      db,
      ctx.user.customerId,
      clock
    );

    return {
      totalCents: preview.totalCents,
      totalUsd: preview.totalCents / 100,
      services: preview.services.map(s => ({
        ...s,
        chargeUsd: s.chargeCents / 100,
      })),
    };
  }),

  /**
   * Inject test data (development/test only)
   *
   * Inserts mock HAProxy logs for testing stats display.
   * Only available when NODE_ENV !== 'production'
   */
  injectTestData: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
      hoursOfData: z.number().min(1).max(48).default(1),
      requestsPerHour: z.number().min(10).max(1000).default(100),
    }))
    .mutation(async ({ ctx, input }) => {
      // Only allow in development/test
      if (config.NODE_ENV === 'production') {
        throw new Error('Test data injection not available in production');
      }

      const clock = dbClockProvider.getClock();
      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType];

      // Calculate timestamp: start from now and go back
      const now = clock.now();
      const startTime = new Date(now.getTime() - (input.hoursOfData * 60 * 60 * 1000));

      // Total count = hours * requests per hour
      const totalCount = input.hoursOfData * input.requestsPerHour;

      // Insert mixed logs with traffic distribution:
      // 50% guaranteed, 20% burst, 10% dropped, 15% client error, 5% server error
      const result = await insertMockMixedLogs(
        db,
        ctx.user.customerId,
        {
          serviceType: serviceTypeNum as 1 | 2 | 3,
          network: 1, // mainnet
          count: totalCount,
          timestamp: startTime,
          responseTimeMs: 50 + Math.floor(Math.random() * 100), // 50-150ms
          spreadAcrossHours: input.hoursOfData,
        }
      );

      // Refresh the aggregate to make data immediately visible
      await refreshStatsAggregate(db);

      // Sync usage to DRAFT invoice using production code path (force=true bypasses debouncing)
      await forceSyncUsageToDraft(db, ctx.user.customerId, clock);

      return {
        success: true,
        inserted: {
          total: result.guaranteed + result.burst + result.dropped + result.clientError + result.serverError,
          guaranteed: result.guaranteed,
          burst: result.burst,
          dropped: result.dropped,
          clientError: result.clientError,
          serverError: result.serverError,
        },
        hoursOfData: input.hoursOfData,
        startTime: startTime.toISOString(),
      };
    }),

  /**
   * Clear stats data (development/test only)
   *
   * Removes HAProxy logs for the customer for the specified service.
   * Only available when NODE_ENV !== 'production'
   */
  clearStats: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      // Only allow in development/test
      if (config.NODE_ENV === 'production') {
        throw new Error('Clear stats not available in production');
      }

      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType];
      await clearCustomerLogs(db, ctx.user.customerId, serviceTypeNum);
      await refreshStatsAggregate(db);

      return { success: true, serviceType: input.serviceType };
    }),

  /**
   * Inject demo data (development/test only)
   *
   * Inserts a nice-looking 24h demo dataset:
   * - Mostly guaranteed traffic with some burst mid-day
   * - No server errors, no dropped
   * - Just a couple of client errors
   * - Response times mostly 100-400ms with a couple >1s spikes
   *
   * Only available when NODE_ENV !== 'production'
   */
  injectDemoData: protectedProcedure
    .input(z.object({
      serviceType: serviceTypeSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      // Only allow in development/test
      if (config.NODE_ENV === 'production') {
        throw new Error('Demo data injection not available in production');
      }

      const clock = dbClockProvider.getClock();
      const serviceTypeNum = SERVICE_TYPE_NUMBER[input.serviceType as ServiceType] as 1 | 2 | 3;
      const now = clock.now();

      // Clear existing data first
      await clearCustomerLogs(db, ctx.user.customerId);

      // Insert 24 hours of nice demo data
      const baseOptions = {
        serviceType: serviceTypeNum,
        network: 1 as const,
      };

      // Demo pattern for 24 hours - Pro tier with 45 req/s guaranteed limit
      // Guaranteed cap: 45 req/s × 3600 = 162,000 requests/hour
      // Burst only appears when traffic exceeds 45 req/s
      //
      // For whisker chart visualization, we insert 5 logs per hour with varying response times
      // to create realistic min/avg/max spread. Each log uses repeat to represent the request count.
      const GUARANTEED_CAP = 45 * 60 * 60; // 162,000 req/hour

      // Define traffic as req/s for each hour, then calculate guaranteed vs burst
      // responseTimeMs is the BASE (average), we'll create spread around it
      const trafficPattern = [
        // Night hours (0-7) - low traffic, all fits in guaranteed, tight response times
        { hour: 0, reqPerSec: 30, clientError: 0, responseTimeMs: 85, spread: 30 },
        { hour: 1, reqPerSec: 25, clientError: 0, responseTimeMs: 65, spread: 25 },
        { hour: 2, reqPerSec: 20, clientError: 0, responseTimeMs: 55, spread: 20 },
        { hour: 3, reqPerSec: 15, clientError: 0, responseTimeMs: 50, spread: 15 },
        { hour: 4, reqPerSec: 18, clientError: 0, responseTimeMs: 52, spread: 18 },
        { hour: 5, reqPerSec: 25, clientError: 0, responseTimeMs: 68, spread: 25 },
        { hour: 6, reqPerSec: 35, clientError: 0, responseTimeMs: 95, spread: 40 },
        { hour: 7, reqPerSec: 42, clientError: 1, responseTimeMs: 120, spread: 60 },
        // Morning ramp-up (8-11) - traffic starts exceeding 45 req/s, wider spread
        { hour: 8, reqPerSec: 48, clientError: 0, responseTimeMs: 145, spread: 80 },
        { hour: 9, reqPerSec: 52, clientError: 0, responseTimeMs: 165, spread: 100 },
        { hour: 10, reqPerSec: 55, clientError: 1, responseTimeMs: 180, spread: 120 },
        { hour: 11, reqPerSec: 53, clientError: 0, responseTimeMs: 175, spread: 110 },
        // Peak hours (12-16) - consistently above 45 req/s, burst active, high variance
        { hour: 12, reqPerSec: 58, clientError: 0, responseTimeMs: 195, spread: 150 },
        { hour: 13, reqPerSec: 56, clientError: 0, responseTimeMs: 200, spread: 180 },
        { hour: 14, reqPerSec: 60, clientError: 1, responseTimeMs: 350, spread: 700 }, // Spike hour: max ~1050ms
        { hour: 15, reqPerSec: 55, clientError: 0, responseTimeMs: 175, spread: 140 },
        { hour: 16, reqPerSec: 50, clientError: 0, responseTimeMs: 155, spread: 100 },
        // Evening decline (17-20)
        { hour: 17, reqPerSec: 47, clientError: 0, responseTimeMs: 140, spread: 80 },
        { hour: 18, reqPerSec: 44, clientError: 0, responseTimeMs: 125, spread: 60 },
        { hour: 19, reqPerSec: 40, clientError: 0, responseTimeMs: 110, spread: 50 },
        { hour: 20, reqPerSec: 35, clientError: 0, responseTimeMs: 95, spread: 40 },
        // Late night (21-23)
        { hour: 21, reqPerSec: 32, clientError: 0, responseTimeMs: 80, spread: 30 },
        { hour: 22, reqPerSec: 28, clientError: 0, responseTimeMs: 72, spread: 25 },
        { hour: 23, reqPerSec: 30, clientError: 0, responseTimeMs: 78, spread: 28 },
      ];

      // Add small random jitter (±4%) to make values look realistic
      const jitter = (value: number) => {
        const variation = 0.96 + Math.random() * 0.08; // 0.96 to 1.04 (±4%)
        return Math.round(value * variation);
      };

      // Convert req/s to guaranteed/burst counts (real numbers with jitter)
      const demoData = trafficPattern.map(p => {
        const totalReqPerHour = p.reqPerSec * 60 * 60; // actual requests per hour
        const guaranteed = jitter(Math.min(totalReqPerHour, GUARANTEED_CAP));
        const burst = jitter(Math.max(0, totalReqPerHour - GUARANTEED_CAP));
        return {
          hour: p.hour,
          guaranteed,
          burst,
          clientError: p.clientError,
          responseTimeMs: p.responseTimeMs,
          spread: p.spread,
        };
      });

      let totalRequests = 0;

      // Insert 5 logs per hour with varying response times for whisker chart visualization
      // This creates realistic min/avg/max spread within each hour
      for (const data of demoData) {
        const hourTimestamp = new Date(now.getTime() - ((24 - data.hour) * 60 * 60 * 1000));

        // Calculate response time distribution: min, below-avg, avg, above-avg, max
        const baseRt = data.responseTimeMs;
        const spread = data.spread;
        const responseTimes = [
          Math.max(20, baseRt - spread),           // min
          Math.max(25, baseRt - spread * 0.4),     // below avg
          baseRt,                                   // avg
          baseRt + spread * 0.4,                   // above avg
          baseRt + spread,                         // max
        ];

        // Distribute guaranteed traffic across 5 logs with different response times
        if (data.guaranteed > 0) {
          const perLog = Math.floor(data.guaranteed / 5);
          const remainder = data.guaranteed - perLog * 5;

          for (let i = 0; i < 5; i++) {
            const count = perLog + (i === 2 ? remainder : 0); // Give remainder to middle (avg) log
            if (count > 0) {
              await insertMockHAProxyLogs(db, ctx.user.customerId, {
                ...baseOptions,
                count: 1,
                repeat: count,
                trafficType: 1,
                statusCode: 200,
                responseTimeMs: Math.round(responseTimes[i]),
                timestamp: new Date(hourTimestamp.getTime() + i),
              });
            }
          }
          totalRequests += data.guaranteed;
        }

        // Insert burst traffic (distribute across 3 logs for variety)
        if (data.burst > 0) {
          const burstRts = [baseRt + 30, baseRt + 50, baseRt + 80]; // Burst is slightly slower
          const perLog = Math.floor(data.burst / 3);
          const remainder = data.burst - perLog * 3;

          for (let i = 0; i < 3; i++) {
            const count = perLog + (i === 1 ? remainder : 0);
            if (count > 0) {
              await insertMockHAProxyLogs(db, ctx.user.customerId, {
                ...baseOptions,
                count: 1,
                repeat: count,
                trafficType: 2,
                statusCode: 200,
                responseTimeMs: burstRts[i],
                timestamp: new Date(hourTimestamp.getTime() + 10 + i),
              });
            }
          }
          totalRequests += data.burst;
        }

        // Insert client errors (1 row with repeat=count)
        if (data.clientError > 0) {
          await insertMockHAProxyLogs(db, ctx.user.customerId, {
            ...baseOptions,
            count: 1,
            repeat: data.clientError,
            trafficType: 1,
            statusCode: 400,
            responseTimeMs: 50, // Errors are fast
            timestamp: new Date(hourTimestamp.getTime() + 20),
          });
          totalRequests += data.clientError;
        }
      }

      // Refresh the aggregate to make data immediately visible
      await refreshStatsAggregate(db);

      // Sync usage to DRAFT invoice using production code path (force=true bypasses debouncing)
      await forceSyncUsageToDraft(db, ctx.user.customerId, clock);

      return {
        success: true,
        inserted: totalRequests, // Total requests represented (via repeat field)
        hoursOfData: 24,
      };
    }),
});
