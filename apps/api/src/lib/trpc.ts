/**
 * tRPC initialization and context
 * Provides type-safe API with automatic validation
 */

import { initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { isTestFeaturesEnabled } from '@mhaxbe/system-config';

/**
 * Context passed to all tRPC procedures
 * Contains: request, reply, database, user session, etc.
 */
export async function createContext({ req, res }: CreateFastifyContextOptions) {
  return {
    req,
    res,
    // User will be added after auth middleware
    user: null as { customerId: number; walletAddress: string } | null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

/**
 * Initialize tRPC with context
 */
const t = initTRPC.context<Context>().create();

/**
 * Export tRPC utilities
 */
export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Protected procedure (requires authentication)
 * Validates JWT access token from Authorization header
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  // Import here to avoid circular dependency
  const { verifyAccessToken } = await import('./jwt');
  const { TRPCError } = await import('@trpc/server');

  // Sync clock from test_kv in non-production (for testing)
  // This ensures API sees mock time set by GM
  if (isTestFeaturesEnabled()) {
    const { dbClockProvider } = await import('@suiftly/shared/db-clock');
    if (dbClockProvider.isTestKvSyncEnabled()) {
      await dbClockProvider.syncFromTestKv();
    }
  }

  // Get token from Authorization header
  const authHeader = ctx.req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'No access token provided',
    });
  }

  try {
    // Verify JWT
    const payload = await verifyAccessToken(token);

    // Add user to context
    return next({
      ctx: {
        ...ctx,
        user: {
          customerId: payload.customerId,
          walletAddress: payload.walletAddress,
        },
      },
    });
  } catch (error) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired access token',
    });
  }
});
