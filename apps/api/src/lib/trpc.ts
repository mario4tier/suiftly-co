/**
 * tRPC initialization and context
 * Provides type-safe API with automatic validation
 */

import { initTRPC } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';

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
 * Will be implemented in Phase 8 (auth flow complete)
 */
export const protectedProcedure = t.procedure; // TODO: Add auth middleware
