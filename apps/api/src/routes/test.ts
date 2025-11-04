/**
 * Test router for Phase 8
 * Protected endpoints for testing authentication
 */

import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../lib/trpc';
import { testDelayManager } from '../lib/test-delays';

export const testRouter = router({
  /**
   * Protected endpoint - requires valid access token
   */
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    return {
      message: 'Protected endpoint accessed successfully!',
      user: ctx.user,
      timestamp: new Date().toISOString(),
    };
  }),

  /**
   * Set artificial delays for testing
   * Allows Playwright tests to slow down API responses
   */
  setDelays: publicProcedure
    .input(z.object({
      validateSubscription: z.number().optional(),
      subscribe: z.number().optional(),
    }))
    .mutation(({ input }) => {
      testDelayManager.setDelays(input);
      return {
        success: true,
        delays: input,
        message: 'Test delays configured'
      };
    }),

  /**
   * Clear all test delays
   */
  clearDelays: publicProcedure.mutation(() => {
    testDelayManager.clearDelays();
    return {
      success: true,
      message: 'Test delays cleared'
    };
  }),
});
