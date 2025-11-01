/**
 * Root tRPC router
 * Combines all route modules
 *
 * Note: Auth moved to REST at /i/auth/* (see rest-auth.ts)
 */

import { router } from '../lib/trpc';
import { testRouter } from './test';

export const appRouter = router({
  test: testRouter,
});

export type AppRouter = typeof appRouter;
