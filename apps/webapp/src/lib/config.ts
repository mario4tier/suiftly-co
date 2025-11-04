/**
 * Global configuration loader
 * Fetches frontend configuration from backend once on app initialization
 * Exposes simple variables for zero-cost access throughout the app
 *
 * Usage:
 *   import { fsubs_usd_pro } from '@/lib/config'
 *   const price = fsubs_usd_pro; // Direct variable access - fastest possible
 */

import { trpc } from './trpc';

// Frontend configuration variables (loaded once at startup)
// Direct variable access for maximum performance
export let fver = 1;
export let freg_count = 3;
export let fbw_sta = 3;
export let fbw_pro = 15;
export let fbw_ent = 100;
export let fsubs_usd_sta = 9;
export let fsubs_usd_pro = 29;
export let fsubs_usd_ent = 185;
export let freqs_usd = 1.00;
export let freqs_count = 10000;
export let fskey_incl = 1;
export let fskey_pkg_incl = 3;

// Track initialization state
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

/**
 * Load configuration from backend and populate global variables
 * Called once during app initialization (before rendering)
 * Returns a promise that resolves when config is loaded
 */
export async function loadFrontendConfig(): Promise<void> {
  // If already initialized, return immediately
  if (isInitialized) {
    return;
  }

  // If initialization is in progress, return the existing promise
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  initializationPromise = (async () => {
    let retryCount = 0;
    const maxRetries = Infinity; // Keep retrying forever
    const retryDelay = 3000; // 3 seconds between retries

    while (retryCount < maxRetries) {
      try {
        console.log('[Config] Loading frontend configuration from backend...');
        const config = await trpc.config.getFrontendConfig.query();

        // Validate that all required keys are present
        if (!config.fver || !config.freg_count || !config.fbw_sta || !config.fbw_pro ||
            !config.fbw_ent || !config.fsubs_usd_sta || !config.fsubs_usd_pro ||
            !config.fsubs_usd_ent || !config.freqs_usd || !config.freqs_count ||
            !config.fskey_incl || !config.fskey_pkg_incl) {
          throw new Error('Missing required configuration keys from database');
        }

        // Populate global variables with values from backend (NO DEFAULTS)
        fver = parseInt(config.fver);
        freg_count = parseInt(config.freg_count);
        fbw_sta = parseInt(config.fbw_sta);
        fbw_pro = parseInt(config.fbw_pro);
        fbw_ent = parseInt(config.fbw_ent);
        fsubs_usd_sta = parseFloat(config.fsubs_usd_sta);
        fsubs_usd_pro = parseFloat(config.fsubs_usd_pro);
        fsubs_usd_ent = parseFloat(config.fsubs_usd_ent);
        freqs_usd = parseFloat(config.freqs_usd);
        freqs_count = parseInt(config.freqs_count);
        fskey_incl = parseInt(config.fskey_incl);
        fskey_pkg_incl = parseInt(config.fskey_pkg_incl);

        isInitialized = true;
        console.log(`[Config] Configuration loaded successfully (version: ${fver})`);
        return; // Success - exit the retry loop
      } catch (error) {
        retryCount++;
        console.error(`[Config] Failed to load frontend configuration (attempt ${retryCount}):`, error);
        console.log(`[Config] Retrying in ${retryDelay / 1000} seconds...`);

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    // This should never be reached with Infinity retries, but kept for safety
    throw new Error('[Config] Failed to load configuration after maximum retries');
  })();

  return initializationPromise;
}

/**
 * Check if configuration has been loaded
 */
export function isConfigLoaded(): boolean {
  return isInitialized;
}

/**
 * Check if config version has changed (for future background polling)
 * Returns true if version mismatch detected
 */
export async function checkVersionMismatch(): Promise<boolean> {
  try {
    const config = await trpc.config.getFrontendConfig.query();
    const serverVersion = parseInt(config.fver || '1');

    if (serverVersion !== fver) {
      console.warn(`[Config] Version mismatch detected! Client: ${fver}, Server: ${serverVersion}`);
      return true;
    }

    return false;
  } catch (error) {
    console.error('[Config] Failed to check version:', error);
    return false;
  }
}

/**
 * Force reload the app (for version mismatch)
 */
export function forceReload(): void {
  console.log('[Config] Force reloading app due to config version mismatch...');
  window.location.reload();
}
