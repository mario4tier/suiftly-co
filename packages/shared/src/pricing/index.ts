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
 * Default per-service tier pricing in USD cents.
 * Each service defines only the tiers it offers.
 *
 * config_global keys:
 * - seal/grpc/graphql: fsubs_usd_sta, fsubs_usd_pro, fsubs_usd_ent
 * - platform: fpsubs_usd_sta, fpsubs_usd_pro
 */
export const SERVICE_TIER_PRICES_USD_CENTS = {
  seal:     { starter: 900, pro: 2900, enterprise: 18500 },
  grpc:     { starter: 900, pro: 2900, enterprise: 18500 },
  graphql:  { starter: 900, pro: 2900, enterprise: 18500 },
  platform: { starter: 100, pro: 2900 },
} as const satisfies Record<string, Partial<Record<string, number>>>;

/**
 * Default per-service tier prices (seal/grpc/graphql share the same pricing).
 * Derived from SERVICE_TIER_PRICES_USD_CENTS to avoid duplication.
 * Used by tests that reference TIER_PRICES_USD_CENTS.starter etc.
 */
export const TIER_PRICES_USD_CENTS = SERVICE_TIER_PRICES_USD_CENTS.seal;

/**
 * Add-on pricing in USD cents
 */
export const ADDON_PRICES_USD_CENTS = {
  sealKey: 500,    // $5.00/month per extra Seal key
  package: 200,    // $2.00/month per extra package
  apiKey: 500,     // $5.00/month per extra API key
} as const;

/**
 * Get tier price in cents for a given service type.
 *
 * @param tier Tier name (starter, pro, enterprise) - case insensitive
 * @param serviceType Service type. Determines which price table to use.
 *   When omitted, uses the default per-service pricing (seal/grpc/graphql).
 * @returns Price in cents
 * @throws Error if tier is not recognized or not offered for the service type
 */
// Type-safe accessor for SERVICE_TIER_PRICES_USD_CENTS
type ServicePriceKey = keyof typeof SERVICE_TIER_PRICES_USD_CENTS;

function getServicePrices(serviceType: string): Record<string, number> | undefined {
  if (serviceType in SERVICE_TIER_PRICES_USD_CENTS) {
    return SERVICE_TIER_PRICES_USD_CENTS[serviceType as ServicePriceKey] as Record<string, number>;
  }
  return undefined;
}

export function getTierPriceUsdCents(tier: string, serviceType?: string): number {
  const tierKey = tier.toLowerCase();
  const priceTable: Record<string, number> | undefined = serviceType
    ? getServicePrices(serviceType)
    : (TIER_PRICES_USD_CENTS as Record<string, number>);
  if (!priceTable) {
    throw new Error(`Unknown service type: ${serviceType}`);
  }
  const price = priceTable[tierKey];
  if (price === undefined) {
    throw new Error(`Tier '${tier}' is not available for ${serviceType ?? 'default'} service. Available tiers: ${Object.keys(priceTable).join(', ')}`);
  }
  return price;
}

/**
 * Get the list of available tiers for a service type.
 * Returns tier names in order (starter, pro, enterprise) filtered to those offered.
 */
export function getAvailableTiers(serviceType: string): string[] {
  const priceTable = getServicePrices(serviceType);
  if (!priceTable) return [];
  return ['starter', 'pro', 'enterprise'].filter(t => t in priceTable);
}
