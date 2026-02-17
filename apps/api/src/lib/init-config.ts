/**
 * Configuration Initialization
 * Ensures all required frontend configuration keys exist in database
 * Runs on server startup to guarantee production servers have valid config
 */

import { db } from '@suiftly/database';
import { configGlobal } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

/**
 * Default frontend configuration values
 * These are inserted if missing from the database
 */
const DEFAULT_FRONTEND_CONFIG: Record<string, string> = {
  // Version
  fver: '1',

  // Registration limits
  freg_count: '3',

  // Bandwidth limits (GB)
  fbw_sta: '3',
  fbw_pro: '15',
  fbw_ent: '100',

  // Subscription prices (USD)
  fsubs_usd_sta: '9',
  fsubs_usd_pro: '29',
  fsubs_usd_ent: '185',

  // Request pricing
  freqs_usd: '1.00',
  freqs_count: '10000',

  // Included resources
  fskey_incl: '1',
  fskey_pkg_incl: '3',
  fapikey_incl: '2',
  fipv4_incl: '2',
  fcidr_incl: '2',

  // Add-on pricing (USD)
  fadd_skey_usd: '5',
  fadd_pkg_usd: '1',
  fadd_apikey_usd: '1',
  fadd_ipv4_usd: '0',
  fadd_cidr_usd: '0',

  // Maximum limits
  fmax_skey: '10',
  fmax_pkg: '10',
  fmax_apikey: '10',
  fmax_ipv4: '20',
  fmax_cidr: '20',
};

/**
 * Initialize frontend configuration in database
 * Ensures all required keys exist, inserting defaults for missing keys
 * Safe to call multiple times (idempotent)
 */
export async function initializeFrontendConfig(): Promise<void> {
  console.log('[Config Init] Checking frontend configuration...');

  try {
    // Get all existing config keys starting with 'f'
    const existingConfigs = await db
      .select()
      .from(configGlobal)
      .where(eq(configGlobal.key, configGlobal.key)); // Get all rows

    const existingKeys = new Set(
      existingConfigs
        .filter(c => c.key.startsWith('f'))
        .map(c => c.key)
    );

    // Find missing keys
    const missingKeys = Object.keys(DEFAULT_FRONTEND_CONFIG).filter(
      key => !existingKeys.has(key)
    );

    if (missingKeys.length === 0) {
      console.log('[Config Init] All frontend config keys present ✓');
      return;
    }

    // Insert missing keys
    console.log(`[Config Init] Inserting ${missingKeys.length} missing config keys:`, missingKeys);

    await db.insert(configGlobal).values(
      missingKeys.map(key => ({
        key,
        value: DEFAULT_FRONTEND_CONFIG[key],
      }))
    ).onConflictDoNothing();

    console.log('[Config Init] Frontend configuration initialized successfully ✓');
  } catch (error) {
    console.error('[Config Init] Failed to initialize frontend configuration:', error);
    throw new Error('Failed to initialize frontend configuration - database may be unavailable');
  }
}
