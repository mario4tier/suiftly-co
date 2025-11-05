/**
 * Seal Keys & Packages tRPC router
 * Handles seal key and package management for Seal service
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db } from '@suiftly/database';
import { sealKeys, sealPackages, serviceInstances } from '@suiftly/database/schema';
import { eq, and, sql } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';

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
});
