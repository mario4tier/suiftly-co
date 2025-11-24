/**
 * Pricing Configuration
 *
 * Centralized pricing logic for billing calculations.
 * Single source of truth - all billing code imports from here.
 *
 * Note: These are default/fallback values. Production uses config_global table
 * loaded by apps/api/src/lib/config-cache.ts at server startup.
 */

/**
 * Tier pricing in USD cents
 * Source: config_global table keys: fsubs_usd_sta, fsubs_usd_pro, fsubs_usd_ent
 */
export const TIER_PRICES_USD_CENTS = {
  starter: 900,      // $9.00/month
  pro: 2900,         // $29.00/month
  enterprise: 18500, // $185.00/month
} as const;

/**
 * Add-on pricing in USD cents
 * Source: UI_DESIGN.md pricing section
 */
export const ADDON_PRICES_USD_CENTS = {
  sealKey: 500,    // $5.00/month per extra Seal key
  package: 200,    // $2.00/month per extra package
  apiKey: 500,     // $5.00/month per extra API key
} as const;

/**
 * Get tier price in cents
 *
 * @param tier Tier name (starter, pro, enterprise) - case insensitive
 * @returns Price in cents
 */
export function getTierPriceUsdCents(tier: string): number {
  const tierKey = tier.toLowerCase() as keyof typeof TIER_PRICES_USD_CENTS;
  return TIER_PRICES_USD_CENTS[tierKey] ?? 0;
}
