/**
 * Seal Keys & Packages tRPC router
 * Handles seal key and package management for Seal service
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db } from '@suiftly/database';
import { sealKeys, sealPackages, serviceInstances, apiKeys } from '@suiftly/database/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';
import { storeApiKey, getApiKeys, revokeApiKey, deleteApiKey, type SealType } from '../lib/api-keys';

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
          eq(sealPackages.isActive, true)
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
          isActive: false,
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
          isActive: input.active,
        })
        .where(eq(sealKeys.sealKeyId, input.sealKeyId))
        .returning();

      return updated;
    }),

  /**
   * Get usage statistics for seal service
   * Returns counts for seal keys, API keys, allowlist entries, and packages
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

    // Count active seal keys
    const activeSealKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sealKeys)
      .where(and(
        eq(sealKeys.instanceId, service.instanceId),
        eq(sealKeys.isActive, true)
      ));

    // Count active API keys
    const activeApiKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.customerId, ctx.user.customerId),
        eq(apiKeys.serviceType, SERVICE_TYPE.SEAL),
        eq(apiKeys.isActive, true)
      ));

    // Get package counts per seal key
    const packageCounts = await db
      .select({
        sealKeyId: sealPackages.sealKeyId,
        count: sql<number>`count(*)::int`,
      })
      .from(sealPackages)
      .innerJoin(sealKeys, eq(sealPackages.sealKeyId, sealKeys.sealKeyId))
      .where(and(
        eq(sealKeys.instanceId, service.instanceId),
        eq(sealPackages.isActive, true)
      ))
      .groupBy(sealPackages.sealKeyId);

    // Count allowlist entries (from config)
    const allowlistEntries = (config.ipAllowlist || []).length;

    return {
      sealKeys: {
        used: activeSealKeys[0]?.count || 0,
        total: config.totalSealKeys || 1,
        included: 1, // Base tier includes 1
        purchased: config.purchasedSealKeys || 0,
      },
      apiKeys: {
        used: activeApiKeys[0]?.count || 0,
        total: config.totalApiKeys || 2,
        included: 2, // Base tier includes 2
        purchased: config.purchasedApiKeys || 0,
      },
      allowlist: {
        used: allowlistEntries,
        total: service.tier === 'starter' ? 0 : 2, // Only Pro/Enterprise
        included: service.tier === 'starter' ? 0 : 2,
      },
      packages: packageCounts.map(pc => ({
        sealKeyId: pc.sealKeyId,
        used: pc.count,
        total: config.packagesPerSealKey || 3,
        included: 3, // Base tier includes 3
        purchased: config.purchasedPackages || 0,
      })),
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

      // Check current count
      const currentKeys = await getApiKeys(ctx.user.customerId, SERVICE_TYPE.SEAL, false);

      if (currentKeys.length >= maxApiKeys) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Maximum API key limit reached (${maxApiKeys})`,
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

    const keys = await getApiKeys(ctx.user.customerId, SERVICE_TYPE.SEAL, false);

    // Return keys with truncated IDs (don't show full keys after creation)
    return keys.map(key => ({
      apiKeyId: key.apiKeyId,
      keyPreview: `${key.apiKeyId.slice(0, 8)}...${key.apiKeyId.slice(-4)}`,
      metadata: key.metadata,
      isActive: key.isActive,
      createdAt: key.createdAt,
      revokedAt: key.revokedAt,
    }));
  }),

  /**
   * Revoke an API key
   */
  revokeApiKey: protectedProcedure
    .input(z.object({
      apiKeyId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const success = await revokeApiKey(input.apiKeyId, ctx.user.customerId);

      if (!success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'API key not found or already revoked',
        });
      }

      return { success: true };
    }),

  /**
   * Delete an API key permanently
   */
  deleteApiKey: protectedProcedure
    .input(z.object({
      apiKeyId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Not authenticated',
        });
      }

      const success = await deleteApiKey(input.apiKeyId, ctx.user.customerId);

      if (!success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'API key not found',
        });
      }

      return { success: true };
    }),
});
