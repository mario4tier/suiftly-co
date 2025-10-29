/**
 * Root tRPC router
 * Combines all route modules
 */

import { router } from '../lib/trpc';
import { authRouter } from './auth';

export const appRouter = router({
  auth: authRouter,
});

export type AppRouter = typeof appRouter;
