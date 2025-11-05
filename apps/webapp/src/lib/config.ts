/**
 * Global configuration loader
 * Fetches frontend configuration from backend once on app initialization
 * Exposes simple variables for zero-cost access throughout the app
 *
 * Usage:
 *   import { fsubs_usd_pro } from '@/lib/config'
 *   const price = fsubs_usd_pro; // Direct variable access - fastest possible
 */

import { vanillaTrpc } from './trpc';

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
export let fapikey_incl = 2;
export let fipv4_incl = 2;
export let fcidr_incl = 2;
export let fadd_skey_usd = 5;
export let fadd_pkg_usd = 1;
export let fadd_apikey_usd = 1;
export let fadd_ipv4_usd = 0;
export let fadd_cidr_usd = 0;
export let fmax_skey = 10;
export let fmax_pkg = 10;
export let fmax_apikey = 10;
export let fmax_ipv4 = 20;
export let fmax_cidr = 20;
export let mockAuth = false;

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
        const config = await vanillaTrpc.config.getFrontendConfig.query();

        // Validate that all required keys are present (mockAuth is optional)
        if (!config.fver || !config.freg_count || !config.fbw_sta || !config.fbw_pro ||
            !config.fbw_ent || !config.fsubs_usd_sta || !config.fsubs_usd_pro ||
            !config.fsubs_usd_ent || !config.freqs_usd || !config.freqs_count ||
            !config.fskey_incl || !config.fskey_pkg_incl || !config.fapikey_incl ||
            !config.fipv4_incl || !config.fcidr_incl || !config.fadd_skey_usd ||
            !config.fadd_pkg_usd || !config.fadd_apikey_usd || !config.fadd_ipv4_usd ||
            !config.fadd_cidr_usd || !config.fmax_skey || !config.fmax_pkg ||
            !config.fmax_apikey || !config.fmax_ipv4 || !config.fmax_cidr) {
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
        fapikey_incl = parseInt(config.fapikey_incl);
        fipv4_incl = parseInt(config.fipv4_incl);
        fcidr_incl = parseInt(config.fcidr_incl);
        fadd_skey_usd = parseFloat(config.fadd_skey_usd);
        fadd_pkg_usd = parseFloat(config.fadd_pkg_usd);
        fadd_apikey_usd = parseFloat(config.fadd_apikey_usd);
        fadd_ipv4_usd = parseFloat(config.fadd_ipv4_usd);
        fadd_cidr_usd = parseFloat(config.fadd_cidr_usd);
        fmax_skey = parseInt(config.fmax_skey);
        fmax_pkg = parseInt(config.fmax_pkg);
        fmax_apikey = parseInt(config.fmax_apikey);
        fmax_ipv4 = parseInt(config.fmax_ipv4);
        fmax_cidr = parseInt(config.fmax_cidr);
        mockAuth = config.mockAuth === 'true';

        isInitialized = true;
        console.log(`[Config] Configuration loaded successfully (version: ${fver}, mockAuth: ${mockAuth})`);
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
    const config = await vanillaTrpc.config.getFrontendConfig.query();
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
