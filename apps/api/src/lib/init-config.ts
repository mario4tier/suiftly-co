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
  fadd_pkg_usd: '2',
  fadd_apikey_usd: '5',
  fadd_ipv4_usd: '0',
  fadd_cidr_usd: '0',

  // Maximum limits
  fmax_skey: '10',
  fmax_pkg: '10',
  fmax_apikey: '10',
  fmax_ipv4: '20',
  fmax_cidr: '20',

  // Platform subscription prices (USD) — platform is the only subscription
  fpsubs_usd_sta: '2',
  fpsubs_usd_pro: '39',
};

/**
 * Initialize frontend configuration in database
 * Hard-coded defaults are the source of truth — missing keys are inserted
 * and stale values are updated to match.
 * Safe to call multiple times (idempotent)
 */
export async function initializeFrontendConfig(): Promise<void> {
  console.log('[Config Init] Syncing frontend configuration...');

  try {
    // Get all existing config values
    const existingConfigs = await db
      .select()
      .from(configGlobal);

    const existingMap = new Map(
      existingConfigs.map(c => [c.key, c.value])
    );

    // Find keys that need inserting or updating
    const toInsert: { key: string; value: string }[] = [];
    const toUpdate: { key: string; value: string }[] = [];

    for (const [key, value] of Object.entries(DEFAULT_FRONTEND_CONFIG)) {
      const existing = existingMap.get(key);
      if (existing === undefined) {
        toInsert.push({ key, value });
      } else if (existing !== value) {
        toUpdate.push({ key, value });
      }
    }

    if (toInsert.length === 0 && toUpdate.length === 0) {
      console.log('[Config Init] All frontend config keys up to date ✓');
      return;
    }

    // Insert missing keys
    if (toInsert.length > 0) {
      console.log(`[Config Init] Inserting ${toInsert.length} missing keys:`, toInsert.map(k => k.key));
      await db.insert(configGlobal).values(toInsert).onConflictDoNothing();
    }

    // Update stale values
    if (toUpdate.length > 0) {
      console.log(`[Config Init] Updating ${toUpdate.length} stale keys:`, toUpdate.map(k => k.key));
      for (const { key, value } of toUpdate) {
        await db.update(configGlobal)
          .set({ value, updatedAt: new Date() })
          .where(eq(configGlobal.key, key));
      }
    }

    console.log('[Config Init] Frontend configuration synced ✓');
  } catch (error) {
    console.error('[Config Init] Failed to sync frontend configuration:', error);
    throw new Error('Failed to sync frontend configuration - database may be unavailable');
  }
}
