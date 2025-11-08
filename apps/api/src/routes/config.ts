/**
 * Config router
 * Public endpoints for fetching system configuration
 */

import { router, publicProcedure } from '../lib/trpc';
import { getAllConfig } from '../lib/config-cache';

const MOCK_AUTH = process.env.MOCK_AUTH === 'true';

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

  /**
   * Get backend configuration values (b* keys)
   * Protected in production - used by backend services
   * Uses in-memory cache for fast access (no database query)
   */
  getBackendConfig: publicProcedure.query(async () => {
    // Get all config from cache (O(1) lookup, no database query)
    const allConfig = getAllConfig();

    // Filter to backend keys (b* prefix)
    const configObj: Record<string, string> = {};
    for (const [key, value] of Object.entries(allConfig)) {
      if (key.startsWith('b')) {
        configObj[key] = value;
      }
    }

    return configObj;
  }),
});
