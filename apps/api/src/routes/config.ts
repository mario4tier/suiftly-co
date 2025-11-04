/**
 * Config router
 * Public endpoints for fetching system configuration
 */

import { router, publicProcedure } from '../lib/trpc';
import { db } from '@suiftly/database';
import { configGlobal } from '@suiftly/database/schema';
import { like } from 'drizzle-orm';

export const configRouter = router({
  /**
   * Get all frontend configuration values (f* keys)
   * Public endpoint - no authentication required
   */
  getFrontendConfig: publicProcedure.query(async () => {
    const feConfigs = await db
      .select()
      .from(configGlobal)
      .where(like(configGlobal.key, 'f%'));

    // Convert array to object for easier access
    const configObj: Record<string, string> = {};
    for (const config of feConfigs) {
      configObj[config.key] = config.value;
    }

    return configObj;
  }),

  /**
   * Get backend configuration values (b* keys)
   * Protected in production - used by backend services
   */
  getBackendConfig: publicProcedure.query(async () => {
    const beConfigs = await db
      .select()
      .from(configGlobal)
      .where(like(configGlobal.key, 'b%'));

    // Convert array to object for easier access
    const configObj: Record<string, string> = {};
    for (const config of beConfigs) {
      configObj[config.key] = config.value;
    }

    return configObj;
  }),
});
