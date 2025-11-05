/**
 * Activity logs router
 * Provides endpoints for fetching user activity logs
 */

import { router, protectedProcedure } from '../lib/trpc';
import { getActivityLogs, getActivityLogCount } from '@suiftly/database';
import { z } from 'zod';

export const activityRouter = router({
  /**
   * Get paginated activity logs for the authenticated user
   */
  getLogs: protectedProcedure
    .input(
      z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const { offset, limit } = input;
      const customerId = ctx.user.customerId;

      // Get logs and total count in parallel
      const [logs, totalCount] = await Promise.all([
        getActivityLogs(customerId, offset, limit),
        getActivityLogCount(customerId),
      ]);

      // Determine if there are more logs to load
      const hasMore = offset + logs.length < Math.min(totalCount, 100);

      return {
        logs: logs.map(log => ({
          timestamp: log.timestamp.toISOString(),
          clientIp: log.clientIp,
          message: log.message,
        })),
        totalCount: Math.min(totalCount, 100), // Cap at 100 for display
        hasMore,
      };
    }),
});
