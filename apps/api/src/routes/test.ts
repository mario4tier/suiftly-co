/**
 * Test router
 * Development/test endpoints for verifying authentication
 * All endpoints disabled in production (NODE_ENV === 'production')
 */

import { router, protectedProcedure } from '../lib/trpc';
import { config } from '../lib/config';

export const testRouter = router({
  /**
   * Protected endpoint - requires valid access token
   * Used by tests to verify authentication is working
   * Only available in development/test
   */
  getProfile: protectedProcedure.query(async ({ ctx }) => {
    if (config.NODE_ENV === 'production') {
      throw new Error('Test endpoint not available in production');
    }

    return {
      message: 'Protected endpoint accessed successfully!',
      user: ctx.user,
      timestamp: new Date().toISOString(),
    };
  }),

  // Note: Test delays are managed via REST endpoints at /test/delays
  // See server.ts for implementation (used by Playwright E2E tests)
});
