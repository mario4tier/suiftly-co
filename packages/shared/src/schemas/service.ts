import { z } from 'zod';
import { serviceTierEnum } from '@suiftly/database/schema';

/**
 * Service configuration schemas
 * Pricing values loaded from config_global table at runtime
 *
 * IMPORTANT: Enum schemas derive from database enum definitions.
 * See docs/ENUM_IMPLEMENTATION.md for the complete enum architecture.
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
  tier: z.enum(serviceTierEnum.enumValues),
  burstEnabled: z.boolean().default(false),
  totalSealKeys: z.number().int().min(1).default(1),
  packagesPerSealKey: z.number().int().min(3).default(3),
  totalApiKeys: z.number().int().min(1).default(2),
  purchasedSealKeys: z.number().int().min(0).default(0),
  purchasedPackages: z.number().int().min(0).default(0),
  purchasedApiKeys: z.number().int().min(0).default(0),
  ipAllowlist: z.array(z.string()).max(4).optional(),
}).refine((data) => {
  // Burst only available for Pro and Enterprise
  if (data.burstEnabled && data.tier === 'starter') {
    return false;
  }

  // IP allowlist only for Pro and Enterprise
  if (data.ipAllowlist && data.ipAllowlist.length > 0 && data.tier === 'starter') {
    return false;
  }

  // Validate IP allowlist limits based on tier
  if (data.ipAllowlist && data.tier === 'pro' && data.ipAllowlist.length > 2) {
    return false; // Pro: max 2 IPv4 addresses
  }

  if (data.ipAllowlist && data.tier === 'enterprise' && data.ipAllowlist.length > 4) {
    return false; // Enterprise: max 2 IPv4 + 2 CIDR ranges
  }

  return true;
}, {
  message: "Invalid configuration for tier",
});

export type SealConfig = z.infer<typeof sealConfigSchema>;

// Pricing constants (fallback/default values only)
// Note: Production values are fetched from config_global table at runtime
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
    enterprise: {
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
