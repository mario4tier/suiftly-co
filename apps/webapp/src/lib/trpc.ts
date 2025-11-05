/**
 * tRPC client setup for React with React Query
 * Type-safe API calls to backend with auth support
 */

import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../../../api/src/routes';
import { useAuthStore } from '../stores/auth';

/**
 * Get access token from Zustand store
 * Note: We import dynamically to avoid circular dependencies
 */
function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = localStorage.getItem('suiftly-auth');
    if (!stored) return null;

    const state = JSON.parse(stored);
    return state.state?.accessToken || null;
  } catch {
    return null;
  }
}

/**
 * React Query tRPC client - USE THIS IN 99% OF CASES
 * Provides hooks (.useQuery, .useMutation) for use in React components
 * Includes automatic caching, refetching, and React state integration
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Vanilla tRPC client - ONLY USE FOR PRE-REACT INITIALIZATION
 * Used in config.ts to load frontend config before React mounts
 * Provides .query()/.mutate() methods without React dependency
 * If you're in a React component, use `trpc` instead
 */
export const vanillaTrpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/i/api',
      credentials: 'include',
      headers() {
        const token = getAccessToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});

// Create tRPC link configuration
export function getTRPCLinks() {
  return [
    httpBatchLink({
      url: '/i/api', // Same-origin (dev: proxied, prod: served by Fastify)
      credentials: 'include', // Send cookies (for refresh token)

      // Add Authorization header with access token
      headers() {
        const token = getAccessToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },

      // Custom fetch with auto-refresh on 401
      async fetch(url, options) {
        let response = await fetch(url, options);

        // If access token expired (401), try refresh once
        if (response.status === 401) {
          console.log('[TRPC] Got 401, attempting token refresh...');

          try {
            // Call REST auth refresh endpoint
            const refreshResponse = await fetch('/i/auth/refresh', {
              method: 'POST',
              credentials: 'include', // Send httpOnly cookie
            });

            if (refreshResponse.ok) {
              const refreshData = await refreshResponse.json();
              const newAccessToken = refreshData.accessToken;

              if (newAccessToken) {
                // Update token in localStorage
                const stored = localStorage.getItem('suiftly-auth');
                if (stored) {
                  const state = JSON.parse(stored);
                  state.state = state.state || {};
                  state.state.accessToken = newAccessToken;
                  localStorage.setItem('suiftly-auth', JSON.stringify(state));
                }

                console.log('[TRPC] Token refreshed, retrying request');

                // Retry with new token - rebuild headers with new Authorization
                const newHeaders = new Headers(options?.headers || {});
                newHeaders.set('Authorization', `Bearer ${newAccessToken}`);

                response = await fetch(url, {
                  ...options,
                  headers: newHeaders,
                });
              }
            } else {
              // Refresh failed (refresh token expired/revoked)
              console.log('[TRPC] Refresh failed, clearing auth state');
              useAuthStore.getState().clearAuth();
            }

            // IMPORTANT: Never use window.location.href here!
            // API calls should ONLY update state, not navigate
            // Let React components handle navigation based on state changes
            // Violating this principle causes page reloads and loss of user context
          } catch (error) {
            console.error('[TRPC] Refresh error:', error);
            // Clear auth state when refresh fails (refresh token expired/revoked)
            // This will trigger redirect to /login via routing guards
            useAuthStore.getState().clearAuth();
          }
        }

        return response;
      },
    }),
  ];
}
