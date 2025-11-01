/**
 * tRPC client setup for React
 * Type-safe API calls to backend with auth support
 */

import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import type { AppRouter } from '../../../api/src/routes';
import { useAuthStore } from '../stores/auth';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
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
            const refreshResponse = await fetch(`${API_URL}/trpc/auth.refresh`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });

            if (refreshResponse.ok) {
              const refreshData = await refreshResponse.json();
              const newAccessToken = refreshData.result?.data?.accessToken;

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
  ],
});
