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
 * Seal service configuration schema.
 * Note: tier is derived from the platform subscription at runtime,
 * not stored in the seal config itself.
 */
export const sealConfigSchema = z.object({
  burstEnabled: z.boolean().default(false),
  totalSealKeys: z.number().int().min(1).default(1),
  packagesPerSealKey: z.number().int().min(3).default(3),
  totalApiKeys: z.number().int().min(1).default(2),
  purchasedSealKeys: z.number().int().min(0).default(0),
  purchasedPackages: z.number().int().min(0).default(0),
  purchasedApiKeys: z.number().int().min(0).default(0),
  ipAllowlist: z.array(z.string()).max(4).optional(),
});

export type SealConfig = z.infer<typeof sealConfigSchema>;

/**
 * Default config for non-platform services (seal, grpc, graphql).
 * Used during account creation and platform subscription auto-provisioning.
 */
export const DEFAULT_SERVICE_CONFIG: SealConfig = {
  burstEnabled: false,
  totalSealKeys: 1,
  packagesPerSealKey: 3,
  totalApiKeys: 2,
  purchasedSealKeys: 0,
  purchasedPackages: 0,
  purchasedApiKeys: 0,
  ipAllowlist: [],
};
