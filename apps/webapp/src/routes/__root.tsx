/**
 * Root route for TanStack Router
 * Wraps all pages with layout
 *
 * SECURITY: Global auth guard with explicit public route allowlist
 * All routes require authentication UNLESS explicitly listed as public
 */

import { createRootRoute, Outlet, redirect } from '@tanstack/react-router';
import { useAuthStore } from '../stores/auth';

/**
 * PUBLIC ROUTES ALLOWLIST
 * These are the ONLY routes accessible without authentication
 *
 * IMPORTANT: This is a security-critical list. Only add routes that:
 * 1. Must be accessible to unauthenticated users
 *
 * DO NOT add routes here without security review
 */
const PUBLIC_ROUTES = new Set([
  '/',       // Index route - handles its own auth check and redirects
  '/login',  // Login page
]);

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    const pathname = location.pathname;

    // Allow public routes
    if (PUBLIC_ROUTES.has(pathname)) {
      return;
    }

    // All other routes require authentication
    const { isAuthenticated } = useAuthStore.getState();

    if (!isAuthenticated) {
      throw redirect({
        to: '/login',
        search: {
          redirect: location.href,
        },
      });
    }
  },
  component: () => (
    <div className="min-h-screen bg-gray-50">
      <Outlet />
    </div>
  ),
});
