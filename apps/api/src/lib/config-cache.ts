/**
 * Backend Configuration Cache
 * Loads config_global values on server startup and caches them in memory
 * Provides fast, zero-database-query access to configuration values
 *
 * Performance: O(1) lookups, no database queries after initialization
 * Thread-safe: Single initialization, read-only thereafter
 */

import { db } from '@suiftly/database';
import { configGlobal } from '@suiftly/database/schema';

/**
 * In-memory cache of all config_global values
 * Loaded once on server startup, read-only thereafter
 */
const configCache = new Map<string, string>();

/**
 * Track initialization state
 */
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize config cache by loading all values from database
 * Called once during server startup
 * Retries for up to 60 seconds, then fails fast (better for production monitoring)
 * Subsequent calls return immediately (idempotent)
 */
export async function initializeConfigCache(): Promise<void> {
  // If already initialized, return immediately
  if (isInitialized) {
    return;
  }

  // If initialization is in progress, return the existing promise
  if (initPromise) {
    return initPromise;
  }

  // Start initialization with retry logic
  initPromise = (async () => {
    const maxRetryDuration = 60000; // 60 seconds total
    const retryInterval = 3000;     // 3 seconds between attempts
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxRetryDuration) {
      attempt++;

      try {
        if (attempt > 1) {
          console.log(`[Config Cache] Retry attempt ${attempt} (${Math.round((Date.now() - startTime) / 1000)}s elapsed)...`);
        } else {
          console.log('[Config Cache] Loading configuration from database...');
        }

        // Load all config values in a single query
        const allConfigs = await db
          .select()
          .from(configGlobal);

        // Populate cache
        configCache.clear();
        for (const config of allConfigs) {
          configCache.set(config.key, config.value);
        }

        isInitialized = true;
        console.log(`[Config Cache] Loaded ${configCache.size} configuration values ✓`);

        // Log pricing config for verification
        const starterPrice = configCache.get('fsubs_usd_sta');
        const proPrice = configCache.get('fsubs_usd_pro');
        const entPrice = configCache.get('fsubs_usd_ent');
        console.log(`[Config Cache] Tier pricing: STARTER=$${starterPrice}, PRO=$${proPrice}, ENTERPRISE=$${entPrice}`);

        return; // Success - exit retry loop
      } catch (error) {
        const elapsed = Date.now() - startTime;
        const remaining = maxRetryDuration - elapsed;

        if (remaining <= 0) {
          // Out of time - fail fast
          initPromise = null;
          console.error(`[Config Cache] Failed after ${attempt} attempts (${Math.round(elapsed / 1000)}s)`);
          console.error('[Config Cache] Final error:', error);
          throw new Error(
            `FATAL: Failed to initialize config cache after ${Math.round(elapsed / 1000)}s. ` +
            `Database may be unavailable. Server cannot start without config.`
          );
        }

        // Log error and wait before retry
        console.error(`[Config Cache] Attempt ${attempt} failed:`, error);
        console.log(`[Config Cache] Retrying in ${retryInterval / 1000}s (${Math.round(remaining / 1000)}s remaining)...`);
        await new Promise(resolve => setTimeout(resolve, retryInterval));
      }
    }

    // Timeout reached (shouldn't get here due to check above, but safety)
    initPromise = null;
    throw new Error('FATAL: Config cache initialization timeout');
  })();

  return initPromise;
}

/**
 * Get a configuration value from cache
 * @throws Error if cache not initialized or key not found
 */
export function getConfig(key: string): string {
  if (!isInitialized) {
    throw new Error(`Config cache not initialized. Call initializeConfigCache() first.`);
  }

  const value = configCache.get(key);
  if (value === undefined) {
    throw new Error(`Configuration key not found: ${key}`);
  }

  return value;
}

/**
 * Get a configuration value from cache as a number
 * @throws Error if cache not initialized, key not found, or value is not a valid number
 */
export function getConfigNumber(key: string): number {
  const value = getConfig(key);
  const num = parseFloat(value);

  if (isNaN(num)) {
    throw new Error(`Configuration value for ${key} is not a valid number: ${value}`);
  }

  return num;
}

/**
 * Get a configuration value from cache as an integer
 * @throws Error if cache not initialized, key not found, or value is not a valid integer
 */
export function getConfigInt(key: string): number {
  const value = getConfig(key);
  const num = parseInt(value, 10);

  if (isNaN(num)) {
    throw new Error(`Configuration value for ${key} is not a valid integer: ${value}`);
  }

  return num;
}

/**
 * Get tier price in USD cents
 * Fast O(1) lookup from memory cache
 */
export function getTierPriceUsdCents(tier: string): number {
  let configKey: string;

  switch (tier.toLowerCase()) {
    case 'starter':
      configKey = 'fsubs_usd_sta';
      break;
    case 'pro':
      configKey = 'fsubs_usd_pro';
      break;
    case 'enterprise':
      configKey = 'fsubs_usd_ent';
      break;
    default:
      throw new Error(`Invalid tier: ${tier}`);
  }

  // Get price from cache and convert to cents
  const priceUsd = getConfigNumber(configKey);
  return Math.round(priceUsd * 100);
}

/**
 * Get all cached configuration (for debugging)
 */
export function getAllConfig(): Record<string, string> {
  if (!isInitialized) {
    throw new Error('Config cache not initialized');
  }

  return Object.fromEntries(configCache);
}

/**
 * Check if cache is initialized
 */
export function isConfigCacheReady(): boolean {
  return isInitialized;
}
