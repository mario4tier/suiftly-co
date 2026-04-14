/**
 * gRPC Service tRPC router
 * API key management and settings for gRPC service.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../lib/trpc';
import { db, withCustomerLockForAPI } from '@suiftly/database';
import { serviceInstances, apiKeys, configGlobal, customers } from '@suiftly/database/schema';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';
import { storeApiKey, getApiKeys } from '../lib/api-keys';
import { parseIpAddressList, ipAllowlistUpdateSchema } from '@suiftly/shared/schemas';
import { decryptSecret } from '../lib/encryption';
import { dbClock } from '@suiftly/shared/db-clock';
import { triggerVaultSync, markConfigChanged } from '../lib/gm-sync';
import { assertPlatformSubscription, getCustomerPlatformTier } from '../lib/payment-gates';

export const grpcRouter = router({
  /**
   * Get usage stats for gRPC service
   */
  getUsageStats: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
    }

    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
      ),
    });

    if (!service) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'gRPC service not found' });
    }

    const config = service.config || {};

    // Get configuration from configGlobal
    const globalConfigRows = await db.select().from(configGlobal);
    const configMap = new Map(globalConfigRows.map(c => [c.key, c.value]));

    const getConfigInt = (key: string, defaultValue: number): number => {
      const value = configMap.get(key);
      return value ? parseInt(value, 10) : defaultValue;
    };
    const getConfigNumber = (key: string, defaultValue: number): number => {
      const value = configMap.get(key);
      return value ? parseFloat(value) : defaultValue;
    };

    // Count API keys (includes both active and revoked, excludes deleted)
    const usedApiKeys = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.customerId, ctx.user.customerId),
        eq(apiKeys.serviceType, SERVICE_TYPE.GRPC),
        isNull(apiKeys.deletedAt)
      ));

    const allowlistEntries = (config.ipAllowlist || []).length;
    const platformTier = await getCustomerPlatformTier(db, ctx.user.customerId);

    const apiKeysIncluded = getConfigInt('fapikey_incl', 2);
    const ipv4Included = getConfigInt('fipv4_incl', 2);
    const apiKeyPrice = getConfigNumber('fadd_apikey_usd', 5);
    const ipv4Price = getConfigNumber('fadd_ipv4_usd', 0);

    return {
      apiKeys: {
        used: usedApiKeys[0]?.count || 0,
        total: config.totalApiKeys || apiKeysIncluded,
        included: apiKeysIncluded,
        purchased: config.purchasedApiKeys || 0,
        pricePerAdditional: apiKeyPrice,
      },
      allowlist: {
        used: allowlistEntries,
        total: platformTier === 'starter' ? 0 : (config.totalIpv4Allowlist || ipv4Included),
        included: platformTier === 'starter' ? 0 : ipv4Included,
        pricePerAdditional: ipv4Price,
      },
    };
  }),

  /**
   * Create a new API key for the gRPC service
   */
  createApiKey: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'createApiKey',
        async (tx) => {
          await assertPlatformSubscription(tx, ctx.user!.customerId);

          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
            ),
          });

          if (!service) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'gRPC service not found' });
          }

          const config = service.config || {};
          const maxApiKeys = config.totalApiKeys || 2;

          // Check current count (includes both active and revoked keys, excludes deleted)
          const currentKeys = await tx.query.apiKeys.findMany({
            where: and(
              eq(apiKeys.customerId, ctx.user!.customerId),
              eq(apiKeys.serviceType, SERVICE_TYPE.GRPC),
              isNull(apiKeys.deletedAt)
            ),
          });

          if (currentKeys.length >= maxApiKeys) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Maximum API key limit reached (${maxApiKeys}). Delete a revoked key to free up a slot.`,
            });
          }

          const { plainKey, record } = await storeApiKey({
            customerId: ctx.user!.customerId,
            serviceType: SERVICE_TYPE.GRPC,
            metadata: { createdVia: 'user_request' },
            tx,
          });

          // Mark config change for vault sync
          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.GRPC, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({ rmaConfigChangeVaultSeq: expectedVaultSeq })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          return { apiKey: plainKey, created: record };
        },
        { serviceType: 'grpc' }
      );

      void triggerVaultSync();
      return result;
    }),

  /**
   * List API keys for the gRPC service
   */
  listApiKeys: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
    }

    const keys = await getApiKeys(ctx.user.customerId, SERVICE_TYPE.GRPC, true);

    return keys.map(key => {
      const plainKey = decryptSecret(key.apiKeyId);
      return {
        apiKeyFp: key.apiKeyFp,
        keyPreview: `${plainKey.slice(0, 8)}...${plainKey.slice(-4)}`,
        fullKey: plainKey,
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
    .input(z.object({ apiKeyFp: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'revokeApiKey',
        async (tx) => {
          const updated = await tx
            .update(apiKeys)
            .set({ isUserEnabled: false, revokedAt: dbClock.now() })
            .where(and(
              eq(apiKeys.apiKeyFp, input.apiKeyFp),
              eq(apiKeys.customerId, ctx.user!.customerId),
              isNull(apiKeys.deletedAt)
            ))
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'API key not found or already revoked' });
          }

          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
            ),
          });

          if (service) {
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.GRPC, 'mainnet');
            await tx
              .update(serviceInstances)
              .set({ rmaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, service.instanceId));
          }

          return { success: true };
        },
        { apiKeyFp: input.apiKeyFp }
      );

      void triggerVaultSync();
      return result;
    }),

  /**
   * Re-enable a revoked API key
   */
  reEnableApiKey: protectedProcedure
    .input(z.object({ apiKeyFp: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'reEnableApiKey',
        async (tx) => {
          const updated = await tx
            .update(apiKeys)
            .set({ isUserEnabled: true, revokedAt: null })
            .where(and(
              eq(apiKeys.apiKeyFp, input.apiKeyFp),
              eq(apiKeys.customerId, ctx.user!.customerId),
              isNull(apiKeys.deletedAt)
            ))
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'API key not found or cannot be re-enabled' });
          }

          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
            ),
          });

          if (service) {
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.GRPC, 'mainnet');
            await tx
              .update(serviceInstances)
              .set({ rmaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, service.instanceId));
          }

          return { success: true };
        },
        { apiKeyFp: input.apiKeyFp }
      );

      void triggerVaultSync();
      return result;
    }),

  /**
   * Delete an API key (soft delete)
   */
  deleteApiKey: protectedProcedure
    .input(z.object({ apiKeyFp: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'deleteApiKey',
        async (tx) => {
          const updated = await tx
            .update(apiKeys)
            .set({ deletedAt: dbClock.now() })
            .where(and(
              eq(apiKeys.apiKeyFp, input.apiKeyFp),
              eq(apiKeys.customerId, ctx.user!.customerId),
              isNull(apiKeys.deletedAt)
            ))
            .returning();

          if (updated.length === 0) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'API key not found or already deleted' });
          }

          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
            ),
          });

          if (service) {
            const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.GRPC, 'mainnet');
            await tx
              .update(serviceInstances)
              .set({ rmaConfigChangeVaultSeq: expectedVaultSeq })
              .where(eq(serviceInstances.instanceId, service.instanceId));
          }

          return { success: true };
        },
        { apiKeyFp: input.apiKeyFp }
      );

      void triggerVaultSync();
      return result;
    }),

  /**
   * Update burst setting for gRPC service
   */
  updateBurstSetting: protectedProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'toggleBurst',
        async (tx) => {
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
            ),
          });

          if (!service) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'gRPC service not found' });
          }

          const platformTierForBurst = await getCustomerPlatformTier(tx, ctx.user!.customerId);
          if (platformTierForBurst === 'starter') {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'Burst is only available for Pro tier' });
          }

          const config = service.config || {};
          config.burstEnabled = input.enabled;

          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.GRPC, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({ config, rmaConfigChangeVaultSeq: expectedVaultSeq })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          return { success: true, burstEnabled: input.enabled };
        },
        { enabled: input.enabled }
      );

      void triggerVaultSync();
      return result;
    }),

  /**
   * Update IP allowlist for gRPC service
   */
  updateIpAllowlist: protectedProcedure
    .input(ipAllowlistUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }

      const result = await withCustomerLockForAPI(
        ctx.user.customerId,
        'updateIpAllowlist',
        async (tx) => {
          const service = await tx.query.serviceInstances.findFirst({
            where: and(
              eq(serviceInstances.customerId, ctx.user!.customerId),
              eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
            ),
          });

          if (!service) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'gRPC service not found' });
          }

          const platformTierForAllowlist = await getCustomerPlatformTier(tx, ctx.user!.customerId);
          if (platformTierForAllowlist === 'starter') {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'IP Allowlist is only available for Pro tier' });
          }

          const config = { ...(service.config || {}) };

          if (input.entries !== undefined) {
            const { ips, errors } = parseIpAddressList(input.entries);

            if (errors.length > 0) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Invalid IP addresses:\n${errors.map(e => `• ${e.ip}: ${e.error}`).join('\n')}`,
              });
            }

            const globalConfigRows = await tx.select().from(configGlobal);
            const configMap = new Map<string, string>(globalConfigRows.map((c: typeof globalConfigRows[number]) => [c.key, c.value ?? '']));
            const ipv4Included = parseInt(configMap.get('fipv4_incl') || '2', 10);
            const maxIpv4 = config.totalIpv4Allowlist || ipv4Included;

            if (ips.length > maxIpv4) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Maximum ${maxIpv4} IPv4 addresses allowed. You provided ${ips.length}.`,
              });
            }

            config.ipAllowlist = ips;
          }

          config.ipAllowlistEnabled = input.enabled;

          const expectedVaultSeq = await markConfigChanged(tx, SERVICE_TYPE.GRPC, 'mainnet');

          await tx
            .update(serviceInstances)
            .set({ config, rmaConfigChangeVaultSeq: expectedVaultSeq })
            .where(eq(serviceInstances.instanceId, service.instanceId));

          return {
            success: true,
            enabled: input.enabled,
            entries: config.ipAllowlist || [],
            errors: [],
          };
        },
        { enabled: input.enabled }
      );

      void triggerVaultSync();
      return result;
    }),

  /**
   * Get More Settings configuration
   */
  getMoreSettings: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
    }

    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, ctx.user.customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
      ),
    });

    if (!service) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'gRPC service not found' });
    }

    const config = service.config || {};
    const platformTier = await getCustomerPlatformTier(db, ctx.user.customerId);

    return {
      burstEnabled: config.burstEnabled ?? (platformTier !== 'starter'),
      ipAllowlistEnabled: config.ipAllowlistEnabled ?? false,
      ipAllowlist: config.ipAllowlist || [],
    };
  }),
});
