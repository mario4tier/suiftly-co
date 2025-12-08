/**
 * Config router
 * Public endpoint for fetching frontend configuration
 */

import { router, publicProcedure } from '../lib/trpc';
import { getAllConfig } from '../lib/config-cache';
import { config } from '../lib/config.js';

const MOCK_AUTH = config.MOCK_AUTH;

export const configRouter = router({
  /**
   * Get all frontend configuration values (f* keys)
   * Public endpoint - no authentication required
   * Uses in-memory cache for fast access (no database query)
   */
  getFrontendConfig: publicProcedure.query(async () => {
    // Get all config from cache (O(1) lookup, no database query)
    const allConfig = getAllConfig();

    // Filter to frontend keys (f* prefix)
    const configObj: Record<string, string> = {};
    for (const [key, value] of Object.entries(allConfig)) {
      if (key.startsWith('f')) {
        configObj[key] = value;
      }
    }

    // Add mockAuth flag so frontend knows if Mock Wallet should be shown
    configObj['mockAuth'] = MOCK_AUTH ? 'true' : 'false';

    return configObj;
  }),

  // Note: Backend configuration (b* keys) is not implemented.
  // If needed in the future, add getBackendConfig as protectedProcedure
  // and define b* keys in init-config.ts.
});
