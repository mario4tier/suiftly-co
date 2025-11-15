/**
 * Seal Keys & Packages tRPC router
 * Handles seal key and package management for Seal service
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db } from '@suiftly/database';
import { sealKeys, sealPackages, serviceInstances, apiKeys, configGlobal } from '@suiftly/database/schema';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';
import { storeApiKey, getApiKeys, revokeApiKey, deleteApiKey, reEnableApiKey, type SealType } from '../lib/api-keys';
import { parseIpAddressList, ipAllowlistUpdateSchema } from '@suiftly/shared/schemas';
import { decryptSecret } from '../lib/encryption';

export const sealRouter = router({
  /**
   * List all seal keys for current user's Seal service
   */
  listKeys: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get service instance first
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    if (!service) {
      return [];
    }

    // Get all seal keys with their packages
    const keys = await db.query.sealKeys.findMany({
      where: eq(sealKeys.instanceId, service.instanceId),
      with: {
        packages: true,
      },
    });

    return keys;
  }),

  /**
   * List packages for a specific seal key
   */
  listPackages: protectedProcedure
    .input(z.object({
      sealKeyId: z.string().uuid(),
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the seal key belongs to the user
      const key = await db.query.sealKeys.findFirst({
        where: and(
          eq(sealKeys.sealKeyId, input.sealKeyId),
          eq(sealKeys.customerId, ctx.user.customerId)
        ),
      });

      if (!key) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal key not found',
        });
      }

      const packages = await db.query.sealPackages.findMany({
        where: eq(sealPackages.sealKeyId, input.sealKeyId),
      });

      return packages;
    }),

  /**
   * Add a new package to a seal key
   */
  addPackage: protectedProcedure
    .input(z.object({
      sealKeyId: z.string().uuid(),
      packageAddress: z.string().length(66), // Sui object address
      name: z.string().max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the seal key belongs to the user
      const key = await db.query.sealKeys.findFirst({
        where: and(
          eq(sealKeys.sealKeyId, input.sealKeyId),
          eq(sealKeys.customerId, ctx.user.customerId)
        ),
      });

      if (!key) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal key not found',
        });
      }

      // Check package count limit (max 10 per key)
      const existingPackages = await db.query.sealPackages.findMany({
        where: and(
          eq(sealPackages.sealKeyId, input.sealKeyId),
          eq(sealPackages.isUserEnabled, true)
        ),
      });

      if (existingPackages.length >= 10) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Maximum package limit reached (10 per seal key)',
        });
      }

      // Create the package
      const [newPackage] = await db
        .insert(sealPackages)
        .values({
          sealKeyId: input.sealKeyId,
          packageAddress: input.packageAddress,
          name: input.name,
        })
        .returning();

      return newPackage;
    }),

  /**
   * Update package address/name
   */
  updatePackage: protectedProcedure
    .input(z.object({
      packageId: z.string().uuid(),
      packageAddress: z.string().length(66).optional(),
      name: z.string().max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the package belongs to the user via seal key
      const pkg = await db.query.sealPackages.findFirst({
        where: eq(sealPackages.packageId, input.packageId),
        with: {
          sealKey: true,
        },
      });

      if (!pkg || pkg.sealKey.customerId !== ctx.user.customerId) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Package not found',
        });
      }

      const [updated] = await db
        .update(sealPackages)
        .set({
          ...(input.packageAddress && { packageAddress: input.packageAddress }),
          ...(input.name !== undefined && { name: input.name }),
        })
        .where(eq(sealPackages.packageId, input.packageId))
        .returning();

      return updated;
    }),

  /**
   * Delete a package
   */
  deletePackage: protectedProcedure
    .input(z.object({
      packageId: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the package belongs to the user via seal key
      const pkg = await db.query.sealPackages.findFirst({
        where: eq(sealPackages.packageId, input.packageId),
        with: {
          sealKey: true,
        },
      });

      if (!pkg || pkg.sealKey.customerId !== ctx.user.customerId) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Package not found',
        });
      }

      // Soft delete (mark as inactive)
      const [deleted] = await db
        .update(sealPackages)
        .set({
          isUserEnabled: false,
        })
        .where(eq(sealPackages.packageId, input.packageId))
        .returning();

      return deleted;
    }),

  /**
   * Toggle seal key active/inactive state
   */
  toggleKey: protectedProcedure
    .input(z.object({
      sealKeyId: z.string().uuid(),
      active: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Verify the seal key belongs to the user
      const key = await db.query.sealKeys.findFirst({
        where: and(
          eq(sealKeys.sealKeyId, input.sealKeyId),
          eq(sealKeys.customerId, ctx.user.customerId)
        ),
      });

      if (!key) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal key not found',
        });
      }

      const [updated] = await db
        .update(sealKeys)
        .set({
          isUserEnabled: input.active,
        })
        .where(eq(sealKeys.sealKeyId, input.sealKeyId))
        .returning();

      return updated;
    }),

  /**
   * Get service configuration and resource usage for seal service
   * Returns usage counts, limits, pricing, and configuration
   */
  getUsageStats: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get service instance
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    if (!service) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Seal service not found',
      });
    }

    const config = service.config as any || {};

    // Get configuration from configGlobal
    const globalConfigRows = await db
      .select()
      .from(configGlobal);

    const configMap = new Map(globalConfigRows.map(c => [c.key, c.value]));

    const getConfigInt = (key: string, defaultValue: number): number => {
      const value = configMap.get(key);
      return value ? parseInt(value, 10) : defaultValue;
    };

    const getConfigNumber = (key: string, defaultValue: number): number => {
      const value = configMap.get(key);
      return value ? parseFloat(value) : defaultValue;
    };

    // Count active seal keys
    const activeSealKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sealKeys)
      .where(and(
        eq(sealKeys.instanceId, service.instanceId),
        eq(sealKeys.isUserEnabled, true)
      ));

    // Count API keys (includes both active and revoked, excludes deleted)
    // Business rule: Revoked keys count as "used" slots
    const usedApiKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.customerId, ctx.user.customerId),
        eq(apiKeys.serviceType, SERVICE_TYPE.SEAL),
        isNull(apiKeys.deletedAt)
      ));

    // Count allowlist entries (from config)
    const allowlistEntries = (config.ipAllowlist || []).length;

    // Get limits and pricing from configGlobal
    const sealKeysIncluded = getConfigInt('fskey_incl', 1);
    const packagesIncluded = getConfigInt('fskey_pkg_incl', 3);
    const apiKeysIncluded = getConfigInt('fapikey_incl', 2);
    const ipv4Included = getConfigInt('fipv4_incl', 2);

    const sealKeyPrice = getConfigNumber('fadd_skey_usd', 5);
    const packagePrice = getConfigNumber('fadd_pkg_usd', 1);
    const apiKeyPrice = getConfigNumber('fadd_apikey_usd', 1);
    const ipv4Price = getConfigNumber('fadd_ipv4_usd', 0);

    return {
      sealKeys: {
        used: activeSealKeys[0]?.count || 0,
        total: config.totalSealKeys || sealKeysIncluded,
        included: sealKeysIncluded,
        purchased: config.purchasedSealKeys || 0,
        pricePerAdditional: sealKeyPrice,
      },
      apiKeys: {
        used: usedApiKeys[0]?.count || 0,
        total: config.totalApiKeys || apiKeysIncluded,
        included: apiKeysIncluded,
        purchased: config.purchasedApiKeys || 0,
        pricePerAdditional: apiKeyPrice,
      },
      allowlist: {
        used: allowlistEntries,
        total: service.tier === 'starter' ? 0 : (config.totalIpv4Allowlist || ipv4Included),
        included: service.tier === 'starter' ? 0 : ipv4Included,
        pricePerAdditional: ipv4Price,
      },
      packagesPerKey: {
        max: config.packagesPerSealKey || packagesIncluded,
        included: packagesIncluded,
        pricePerAdditional: packagePrice,
      },
    };
  }),

  /**
   * Create a new API key for the seal service
   */
  createApiKey: protectedProcedure
    .input(z.object({
      sealType: z.object({
        network: z.enum(['mainnet', 'testnet']),
        access: z.enum(['permission', 'open']),
        source: z.enum(['imported', 'derived']).optional(),
      }).optional(),
      procGroup: z.number().min(0).max(7).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Get service instance
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, ctx.user.customerId),
          eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
        ),
      });

      if (!service) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal service not found',
        });
      }

      const config = service.config as any || {};
      const maxApiKeys = config.totalApiKeys || 2;

      // Check current count (includes both active and revoked keys, excludes deleted)
      // Business rule: Revoked keys count as "used" slots
      const currentKeys = await getApiKeys(ctx.user.customerId, SERVICE_TYPE.SEAL, true);

      if (currentKeys.length >= maxApiKeys) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Maximum API key limit reached (${maxApiKeys}). Delete a revoked key to free up a slot.`,
        });
      }

      // Create new API key
      const { plainKey, record } = await storeApiKey({
        customerId: ctx.user.customerId,
        serviceType: SERVICE_TYPE.SEAL,
        sealType: input.sealType as SealType,
        procGroup: input.procGroup,
        metadata: {
          createdVia: 'user_request',
        },
      });

      return {
        apiKey: plainKey, // Show only once!
        created: record,
      };
    }),

  /**
   * List API keys for the seal service
   */
  listApiKeys: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    const keys = await getApiKeys(ctx.user.customerId, SERVICE_TYPE.SEAL, true);

    // Decrypt keys and return with truncated preview
    // API keys are encrypted in database, but we show a preview based on the decrypted key
    return keys.map(key => {
      const plainKey = decryptSecret(key.apiKeyId); // Decrypt the stored key
      return {
        apiKeyFp: key.apiKeyFp, // Use fingerprint (PRIMARY KEY) for identification
        keyPreview: `${plainKey.slice(0, 8)}...${plainKey.slice(-4)}`, // Preview from decrypted key
        metadata: key.metadata,
        isUserEnabled: key.isUserEnabled,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt,
      };
    });
  }),

  /**
   * Revoke an API key
   */
  revokeApiKey: protectedProcedure
    .input(z.object({
      apiKeyFp: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Revoke by fingerprint (primary key) - no decryption needed
      const result = await db
        .update(apiKeys)
        .set({
          isUserEnabled: false,
          revokedAt: new Date(),
        })
        .where(
          and(
            eq(apiKeys.apiKeyFp, input.apiKeyFp),
            eq(apiKeys.customerId, ctx.user.customerId)
          )
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'API key not found or already revoked',
        });
      }

      return { success: true };
    }),

  /**
   * Re-enable a revoked API key
   */
  reEnableApiKey: protectedProcedure
    .input(z.object({
      apiKeyFp: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Re-enable by fingerprint (primary key) - no decryption needed
      const result = await db
        .update(apiKeys)
        .set({
          isUserEnabled: true,
          revokedAt: null,
        })
        .where(
          and(
            eq(apiKeys.apiKeyFp, input.apiKeyFp),
            eq(apiKeys.customerId, ctx.user.customerId),
            isNull(apiKeys.deletedAt) // Cannot re-enable deleted keys
          )
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'API key not found or cannot be re-enabled',
        });
      }

      return { success: true };
    }),

  /**
   * Delete an API key (soft delete - irreversible from UI)
   */
  deleteApiKey: protectedProcedure
    .input(z.object({
      apiKeyFp: z.number().int(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Soft delete by fingerprint (primary key) - no decryption needed
      const result = await db
        .update(apiKeys)
        .set({
          deletedAt: new Date(),
        })
        .where(
          and(
            eq(apiKeys.apiKeyFp, input.apiKeyFp),
            eq(apiKeys.customerId, ctx.user.customerId)
          )
        )
        .returning();

      if (result.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'API key not found',
        });
      }

      return { success: true };
    }),

  /**
   * Update burst setting for seal service
   */
  updateBurstSetting: protectedProcedure
    .input(z.object({
      enabled: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Get service instance
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, ctx.user.customerId),
          eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
        ),
      });

      if (!service) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal service not found',
        });
      }

      // Starter tier doesn't support burst
      if (service.tier === 'starter') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Burst is only available for Pro and Enterprise tiers',
        });
      }

      // Update config
      const config = service.config as any || {};
      config.burstEnabled = input.enabled;

      await db
        .update(serviceInstances)
        .set({ config })
        .where(eq(serviceInstances.instanceId, service.instanceId));

      return { success: true, burstEnabled: input.enabled };
    }),

  /**
   * Update IP allowlist for seal service
   *
   * Independent operations:
   * - Toggle ON/OFF: Send { enabled: true/false } without entries
   * - Save IP list: Send { enabled: current_state, entries: "ip1, ip2" }
   */
  updateIpAllowlist: protectedProcedure
    .input(ipAllowlistUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      // Get service instance
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, ctx.user.customerId),
          eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
        ),
      });

      if (!service) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Seal service not found',
        });
      }

      // Starter tier doesn't support IP allowlist
      if (service.tier === 'starter') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'IP Allowlist is only available for Pro and Enterprise tiers',
        });
      }

      // Create a new config object so Drizzle detects changes
      const config = { ...(service.config as any || {}) };

      // If entries are provided, validate and update the IP list
      if (input.entries !== undefined) {
        const { ips, errors } = parseIpAddressList(input.entries);

        if (errors.length > 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid IP addresses:\n${errors.map(e => `• ${e.ip}: ${e.error}`).join('\n')}`,
          });
        }

        // Get actual tier limit from configGlobal
        // This ensures customers with purchased additional capacity aren't blocked
        const globalConfigRows = await db.select().from(configGlobal);
        const configMap = new Map(globalConfigRows.map(c => [c.key, c.value]));
        const ipv4Included = parseInt(configMap.get('fipv4_incl') || '2', 10);

        // Use customer-specific limit or fall back to default
        const maxIpv4 = config.totalIpv4Allowlist || ipv4Included;

        if (ips.length > maxIpv4) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Maximum ${maxIpv4} IPv4 addresses allowed for your configuration. You provided ${ips.length}.`,
          });
        }

        // Update IP list
        config.ipAllowlist = ips;
      }

      // Always update the enabled flag (independent of IP list changes)
      config.ipAllowlistEnabled = input.enabled;

      await db
        .update(serviceInstances)
        .set({ config })
        .where(eq(serviceInstances.instanceId, service.instanceId));

      return {
        success: true,
        enabled: input.enabled,
        entries: config.ipAllowlist || [], // Return current IPs (may be unchanged)
        errors: [],
      };
    }),

  /**
   * Get More Settings configuration
   */
  getMoreSettings: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Not authenticated',
      });
    }

    // Get service instance
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });

    if (!service) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Seal service not found',
      });
    }

    const config = service.config as any || {};

    return {
      burstEnabled: config.burstEnabled ?? (service.tier !== 'starter'),
      ipAllowlistEnabled: config.ipAllowlistEnabled ?? false,
      ipAllowlist: config.ipAllowlist || [],
    };
  }),
});
