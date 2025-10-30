/**
 * Test router for Phase 8
 * Protected endpoints for testing authentication
 */

import { router, protectedProcedure } from '../lib/trpc';

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
});
