import { z } from 'zod';

/**
 * Service configuration schemas
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

/**
 * Service instance configuration schema (shared by all service types).
 * Seal-specific fields (totalSealKeys, packagesPerSealKey, etc.) are
 * ignored by gRPC/GraphQL but stored in the same JSON column.
 * Tier is derived from the platform subscription at runtime.
 */
export const serviceConfigSchema = z.object({
  burstEnabled: z.boolean().default(false),
  ipAllowlistEnabled: z.boolean().default(false),
  ipAllowlist: z.array(z.string()).max(4).optional(),
  totalIpv4Allowlist: z.number().int().optional(),
  totalSealKeys: z.number().int().min(1).default(1),
  packagesPerSealKey: z.number().int().min(3).default(3),
  totalApiKeys: z.number().int().min(1).default(2),
  purchasedSealKeys: z.number().int().min(0).default(0),
  purchasedPackages: z.number().int().min(0).default(0),
  purchasedApiKeys: z.number().int().min(0).default(0),
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

/**
 * Default config for non-platform services (seal, grpc, graphql).
 * Used during account creation and platform subscription auto-provisioning.
 */
export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  burstEnabled: false,
  ipAllowlistEnabled: false,
  totalSealKeys: 1,
  packagesPerSealKey: 3,
  totalApiKeys: 2,
  purchasedSealKeys: 0,
  purchasedPackages: 0,
  purchasedApiKeys: 0,
  ipAllowlist: [],
};

/**
 * Build provision config with burst enabled based on platform tier.
 * Pro tier gets burst enabled by default; Starter does not.
 */
export function buildProvisionConfig(platformTier: string | null): ServiceConfig {
  return {
    ...DEFAULT_SERVICE_CONFIG,
    burstEnabled: platformTier !== null && platformTier !== 'starter',
  };
}
