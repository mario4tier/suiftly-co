import { z } from 'zod';

/**
 * Service configuration schemas
 * Based on SEAL_SERVICE_CONFIG.md pricing model
 */

/**
 * Service status enum
 * - NotProvisioned: Never been enabled, no billing history
 * - Enabled: Provisioned and currently active (billing)
 * - Disabled: Provisioned but currently paused (no billing)
 */
export const serviceStatusSchema = z.enum(['NotProvisioned', 'Enabled', 'Disabled']);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const sealConfigSchema = z.object({
  tier: z.enum(['starter', 'pro', 'business']),
  burstEnabled: z.boolean(),
  totalSealKeys: z.number().int().min(1),
  packagesPerSealKey: z.number().int().min(3),
  totalApiKeys: z.number().int().min(1),
}).refine((data) => {
  // Burst only available for Pro and Business
  if (data.burstEnabled && data.tier === 'starter') {
    return false;
  }
  return true;
}, {
  message: "Burst is only available for Pro and Business tiers",
  path: ["burstEnabled"],
});

export type SealConfig = z.infer<typeof sealConfigSchema>;

// Pricing constants from SEAL_SERVICE_CONFIG.md
// Note: These are default values. Production values should be fetched from service_tier_config table
export const SEAL_PRICING = {
  tiers: {
    starter: {
      base: 20,
      reqPerSecRegion: 20,
      reqPerSecGlobal: 60,
      burstAllowed: false
    },
    pro: {
      base: 100,
      reqPerSecRegion: 300,
      reqPerSecGlobal: 1200,
      burstAllowed: true
    },
    business: {
      base: 300,
      reqPerSecRegion: 1000,
      reqPerSecGlobal: 4000,
      burstAllowed: true
    },
  },
  burst: 10,                    // +$10/month
  additionalSealKey: 5,         // +$5/month per key (after 1)
  additionalPackagePerKey: 1,   // +$1/month per package (after 3) per seal key
  additionalApiKey: 1,          // +$1/month per key (after 1)
  usageFee: 1.00,               // $1 per 10K requests (metered separately)
};

/**
 * Calculate total monthly fee
 */
export function calculateMonthlyFee(config: SealConfig): number {
  let total = SEAL_PRICING.tiers[config.tier].base;

  if (config.burstEnabled) {
    total += SEAL_PRICING.burst;
  }

  // Additional seal keys (1 included)
  total += Math.max(0, config.totalSealKeys - 1) * SEAL_PRICING.additionalSealKey;

  // Additional packages per seal key (3 included per key)
  const additionalPackagesPerKey = Math.max(0, config.packagesPerSealKey - 3);
  total += additionalPackagesPerKey * config.totalSealKeys * SEAL_PRICING.additionalPackagePerKey;

  // Additional API keys (1 included)
  total += Math.max(0, config.totalApiKeys - 1) * SEAL_PRICING.additionalApiKey;

  return total;
}
