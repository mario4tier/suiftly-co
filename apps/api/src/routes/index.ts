/**
 * Root tRPC router
 * Combines all route modules
 *
 * Note: Auth moved to REST at /i/auth/* (see rest-auth.ts)
 */

import { router } from '../lib/trpc';
import { testRouter } from './test';
import { configRouter } from './config';
import { servicesRouter } from './services';
import { sealRouter } from './seal';
import { activityRouter } from './activity';
import { billingRouter } from './billing';

export const appRouter = router({
  test: testRouter,
  config: configRouter,
  services: servicesRouter,
  seal: sealRouter,
  activity: activityRouter,
  billing: billingRouter,
});

export type AppRouter = typeof appRouter;
