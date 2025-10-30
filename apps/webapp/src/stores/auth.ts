/**
 * Authentication state store with Zustand
 * Manages session, login/logout, and auto-refresh
 * Based on AUTHENTICATION_DESIGN.md
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  walletAddress: string;
  // Customer ID is internal only (stored in JWT, not exposed to client)
}

interface AuthState {
  // Session state
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;

  // Actions
  setUser: (user: User) => void;
  setAccessToken: (token: string) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      // Initial state
      user: null,
      accessToken: null,
      isAuthenticated: false,

      // Set user and mark as authenticated
      setUser: (user) =>
        set({
          user,
          isAuthenticated: true,
        }),

      // Set access token
      setAccessToken: (token) =>
        set({
          accessToken: token,
        }),

      // Clear authentication state
      clearAuth: () =>
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
        }),
    }),
    {
      name: 'suiftly-auth', // localStorage key
      partialize: (state) => ({
        // Persist session data (survives page refresh)
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        accessToken: state.accessToken,
        // DO NOT persist isAuthenticating or isLoading (transient states)
      }),
    }
  )
);
