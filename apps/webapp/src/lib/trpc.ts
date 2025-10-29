/**
 * tRPC client setup for React
 * Type-safe API calls to backend
 */

import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../../api/src/routes';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
      credentials: 'include', // Send cookies
    }),
  ],
});
