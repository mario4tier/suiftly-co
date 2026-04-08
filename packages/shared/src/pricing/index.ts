/**
 * Pricing Configuration — Default/Fallback Values
 *
 * The runtime source of truth is the config_global database table,
 * loaded into memory by apps/api/src/lib/config-cache.ts at server startup.
 * These constants serve as:
 * - Fallback defaults when config_global hasn't been loaded (billing engine,
 *   packages/database code that doesn't have access to config-cache)
 * - Seed values for init-config.ts (which populates config_global on first run)
 * - Reference values for tests
 *
 * Keep in sync with: apps/api/src/lib/init-config.ts (DEFAULT_FRONTEND_CONFIG)
 *
 * TODO: Unify with config-cache.ts via provider injection (same pattern as
 * PaymentServices in packages/database/src/billing/providers/). Both the API
 * server and Global Manager would inject a getPriceUsdCents callback at startup,
 * eliminating the risk of hardcoded values diverging from config_global.
 */

/**
 * Platform tier pricing in USD cents.
 * Platform is the only subscription — seal/grpc/graphql have no subscription fee.
 *
 * config_global keys: fpsubs_usd_sta, fpsubs_usd_pro
 */
export const PLATFORM_TIER_PRICES_USD_CENTS = {
  starter: 200,   // $2.00/month
  pro: 3900,      // $39.00/month
} as const;

/**
 * Add-on pricing in USD cents
 */
export const ADDON_PRICES_USD_CENTS = {
  sealKey: 500,    // $5.00/month per extra Seal key
  package: 200,    // $2.00/month per extra package
  apiKey: 500,     // $5.00/month per extra API key
} as const;

/**
 * Get tier price in cents for platform.
 *
 * @param tier Tier name (starter, pro) - case insensitive
 * @returns Price in cents
 * @throws Error if tier is not recognized
 */
export function getTierPriceUsdCents(tier: string): number {
  const tierKey = tier.toLowerCase() as keyof typeof PLATFORM_TIER_PRICES_USD_CENTS;
  const price = PLATFORM_TIER_PRICES_USD_CENTS[tierKey];
  if (price === undefined) {
    throw new Error(`Tier '${tier}' is not available. Available tiers: ${Object.keys(PLATFORM_TIER_PRICES_USD_CENTS).join(', ')}`);
  }
  return price;
}

/**
 * Get the list of available tiers for a service type.
 * Only platform has tiers; all other services (seal, grpc, graphql) have no subscription tiers.
 */
export function getAvailableTiers(serviceType: string): string[] {
  if (serviceType === 'platform') return ['starter', 'pro'];
  return [];
}
