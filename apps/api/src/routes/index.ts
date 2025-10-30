/**
 * Root tRPC router
 * Combines all route modules
 */

import { router } from '../lib/trpc';
import { authRouter } from './auth';
import { testRouter } from './test';

export const appRouter = router({
  auth: authRouter,
  test: testRouter,
});

export type AppRouter = typeof appRouter;
