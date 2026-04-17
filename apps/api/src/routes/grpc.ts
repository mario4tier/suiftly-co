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
import { SERVICE_TYPE, GRPC_PORT } from '@suiftly/shared/constants';
import { isTestFeaturesEnabled } from '@mhaxbe/system-config';
import { dbClock } from '@suiftly/shared/db-clock';
import * as http2 from 'node:http2';
import { storeApiKey, getApiKeys } from '../lib/api-keys';
import { parseIpAddressList, ipAllowlistUpdateSchema } from '@suiftly/shared/schemas';
import { decryptSecret } from '../lib/encryption';
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

  /**
   * Generate real gRPC traffic through HAProxy metered port.
   *
   * Two modes:
   * - 'requests': inject `count` individual gRPC requests (each a separate
   *   HAProxy log entry, showing up as distinct requests in traffic stats).
   * - 'stream': open one streaming checkpoint subscription for `durationSecs`
   *   seconds (one long-lived connection, bandwidth reflected in stats).
   *
   * Traffic flows through the full production pipeline:
   *   HAProxy → rsyslog → fluentd → PostgreSQL (haproxy_raw_logs)
   * No forced stats refresh — stats reflect changes on their natural timescale.
   *
   * Dev/test only.
   */
  generateRealTraffic: protectedProcedure
    .input(z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('requests'),
        count: z.number().int().min(1).max(200),
      }),
      z.object({
        mode: z.literal('stream'),
        durationSecs: z.number().min(1).max(60),
      }),
    ]))
    .mutation(async ({ ctx, input }) => {
      if (!isTestFeaturesEnabled()) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only available in dev/test' });
      }
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }

      // Find active (not revoked/deleted) API key for this customer
      const key = await db.query.apiKeys.findFirst({
        where: and(
          eq(apiKeys.customerId, ctx.user.customerId),
          eq(apiKeys.serviceType, SERVICE_TYPE.GRPC),
          eq(apiKeys.isUserEnabled, true),
          isNull(apiKeys.revokedAt),
          isNull(apiKeys.deletedAt),
        ),
      });

      if (!key) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No active gRPC API key. Create one first.',
        });
      }

      const plaintextKey = decryptSecret(key.apiKeyId);
      const port = GRPC_PORT.MAINNET_PUBLIC;

      if (input.mode === 'requests') {
        return await injectRequests(port, plaintextKey, input.count);
      }
      return await injectStream(port, plaintextKey, input.durationSecs);
    }),
});

// ---------------------------------------------------------------------------
// Traffic injection helpers — real gRPC through HAProxy, no mock data
// ---------------------------------------------------------------------------

const GRPC_HEADERS = (apiKey: string): http2.OutgoingHttpHeaders => ({
  ':method': 'POST',
  ':path': '/sui.rpc.v2.SubscriptionService/SubscribeCheckpoints',
  'content-type': 'application/grpc',
  'te': 'trailers',
  'x-api-key': apiKey,
  'cf-connecting-ip': '127.0.0.1',
});

// Empty gRPC frame: [0x00 (not compressed), 0x00000000 (zero-length message)]
const EMPTY_GRPC_FRAME = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * Make a single short-lived gRPC streaming request: connect, receive one
 * checkpoint message, close. Each call generates one HAProxy log entry.
 */
function makeOneRequest(
  port: number,
  apiKey: string,
): Promise<{ bytes: number; ok: boolean }> {
  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);
    const timeoutId = setTimeout(() => {
      client.close();
      resolve({ bytes: 0, ok: false });
    }, 10_000);

    client.on('error', () => {
      clearTimeout(timeoutId);
      client.close();
      resolve({ bytes: 0, ok: false });
    });

    const req = client.request(GRPC_HEADERS(apiKey));
    req.write(EMPTY_GRPC_FRAME);
    req.end();

    let bytes = 0;
    let gotMessage = false;
    let frameBuf = Buffer.alloc(0);

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      frameBuf = Buffer.concat([frameBuf, chunk]);
      // Wait for at least one complete gRPC message
      while (frameBuf.length >= 5) {
        const msgLen = frameBuf.readUInt32BE(1);
        const frameLen = 5 + msgLen;
        if (frameBuf.length < frameLen) break;
        gotMessage = true;
        frameBuf = frameBuf.subarray(frameLen);
      }
      if (gotMessage) {
        req.close();
        setTimeout(() => {
          clearTimeout(timeoutId);
          client.close();
          resolve({ bytes, ok: true });
        }, 100);
      }
    });

    req.on('end', () => {
      clearTimeout(timeoutId);
      client.close();
      resolve({ bytes, ok: bytes > 0 });
    });

    req.on('error', () => {
      clearTimeout(timeoutId);
      client.close();
      resolve({ bytes, ok: false });
    });
  });
}

/**
 * Inject `count` individual gRPC requests sequentially. Each goes through the
 * full HAProxy pipeline and generates its own log entry.
 */
async function injectRequests(
  port: number,
  apiKey: string,
  count: number,
): Promise<{ mode: 'requests'; requests: number; successCount: number; totalBytes: number }> {
  let successCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < count; i++) {
    const r = await makeOneRequest(port, apiKey);
    if (r.ok) successCount++;
    totalBytes += r.bytes;
  }

  return { mode: 'requests', requests: count, successCount, totalBytes };
}

/**
 * Open one streaming checkpoint subscription for `durationSecs` seconds.
 * Generates one HAProxy log entry with cumulative bytes.
 */
function injectStream(
  port: number,
  apiKey: string,
  durationSecs: number,
): Promise<{ mode: 'stream'; checkpoints: number; bytes: number; durationMs: number; status: number }> {
  const durationMs = durationSecs * 1000;

  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);

    const timeoutId = setTimeout(() => {
      client.close();
      resolve({ mode: 'stream', checkpoints: 0, bytes: 0, durationMs, status: 0 });
    }, durationMs + 10_000);

    client.on('error', () => {
      clearTimeout(timeoutId);
      client.close();
      resolve({ mode: 'stream', checkpoints: 0, bytes: 0, durationMs, status: 0 });
    });

    const req = client.request(GRPC_HEADERS(apiKey));
    req.write(EMPTY_GRPC_FRAME);
    req.end();

    let status = 0;
    let totalBytes = 0;
    let messageCount = 0;
    let frameBuf = Buffer.alloc(0);

    req.on('response', (h) => { status = (h[':status'] as number) ?? 0; });

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      frameBuf = Buffer.concat([frameBuf, chunk]);
      while (frameBuf.length >= 5) {
        const msgLen = frameBuf.readUInt32BE(1);
        const frameLen = 5 + msgLen;
        if (frameBuf.length < frameLen) break;
        messageCount++;
        frameBuf = frameBuf.subarray(frameLen);
      }
    });

    const durationTimer = setTimeout(() => {
      req.close();
      setTimeout(() => {
        clearTimeout(timeoutId);
        client.close();
        resolve({ mode: 'stream', checkpoints: messageCount, bytes: totalBytes, durationMs, status });
      }, 200);
    }, durationMs);

    req.on('end', () => {
      clearTimeout(timeoutId);
      clearTimeout(durationTimer);
      client.close();
      resolve({ mode: 'stream', checkpoints: messageCount, bytes: totalBytes, durationMs, status });
    });

    req.on('error', () => {
      clearTimeout(timeoutId);
      clearTimeout(durationTimer);
      client.close();
      resolve({ mode: 'stream', checkpoints: messageCount, bytes: totalBytes, durationMs, status });
    });
  });
}
