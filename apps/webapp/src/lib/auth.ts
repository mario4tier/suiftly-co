/**
 * Authentication service
 * Handles wallet-based authentication with challenge-response flow
 *
 * Key features:
 * - Idempotent operations (safe to call multiple times)
 * - Single operation lock (prevents concurrent login/logout conflicts)
 * - Supports both mock and real wallets
 * - Auto-refresh access tokens (user signs once, works for 30 days)
 */

import { useSignPersonalMessage, useCurrentAccount } from '@mysten/dapp-kit';
import { useAuthStore } from '../stores/auth';
import { toast } from 'sonner';
import { getMockWallet, mockSignMessage } from './mockWallet';
import { useCallback } from 'react';

/**
 * Module-level operation tracker
 * Ensures only ONE auth operation at a time (login OR logout)
 * Prevents race conditions from React.StrictMode and user actions
 */
let currentOperation: Promise<any> | null = null;
let currentOperationType: 'login' | 'logout' | null = null;

export function useAuth() {
  const {
    user,
    isAuthenticated,
    setUser,
    setAccessToken,
    clearAuth,
  } = useAuthStore();
  const currentAccount = useCurrentAccount();
  const { mutateAsync: signMessage } = useSignPersonalMessage();

  /**
   * Login with wallet signature
   * Idempotent - safe to call multiple times
   */
  const login = useCallback(async (): Promise<boolean> => {
    // Check wallet exists before acquiring lock
    const mockAccount = getMockWallet();
    const account = mockAccount || currentAccount;

    if (!account) return false;
    if (isAuthenticated) return true;

    // Wait for any in-progress operation
    if (currentOperation) {
      await currentOperation;
      return isAuthenticated;
    }

    // Acquire lock and perform login
    currentOperationType = 'login';
    currentOperation = performLogin(account);

    try {
      return await currentOperation;
    } finally {
      currentOperation = null;
      currentOperationType = null;
    }
  }, [isAuthenticated, currentAccount, setUser, setAccessToken, signMessage]);

  async function performLogin(account: {address: string}): Promise<boolean> {
    const mockAccount = getMockWallet();
    const useMock = !!mockAccount;

    try {
      // Step 1: Get challenge nonce (REST endpoint)
      const connectResponse = await fetch('/i/auth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: account.address }),
      });

      if (!connectResponse.ok) {
        throw new Error('Failed to connect wallet');
      }

      const challenge = await connectResponse.json();

      // Step 2: Sign message (mock or real wallet)
      let signatureResult;
      if (useMock) {
        signatureResult = mockSignMessage(new TextEncoder().encode(challenge.message));
      } else {
        signatureResult = await signMessage({
          message: new TextEncoder().encode(challenge.message),
        });
      }

      // Step 3: Verify signature and get JWT (REST endpoint, sets httpOnly cookie)
      const verifyResponse = await fetch('/i/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Important: send/receive cookies
        body: JSON.stringify({
          walletAddress: account.address,
          signature: signatureResult.signature,
          nonce: challenge.nonce,
        }),
      });

      if (!verifyResponse.ok) {
        throw new Error('Failed to verify signature');
      }

      const result = await verifyResponse.json();

      // Step 4: Store session
      setUser({ walletAddress: result.walletAddress });
      setAccessToken(result.accessToken);

      toast.success('Successfully authenticated!');
      return true;
    } catch (error: any) {
      console.error('[AUTH] Authentication failed:', error.message);
      toast.error(`Authentication failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Logout and revoke refresh token
   * Idempotent - safe to call multiple times
   */
  const logout = useCallback(async (): Promise<void> => {
    if (!isAuthenticated) return;

    // Wait for any in-progress operation
    if (currentOperation) {
      await currentOperation;
      if (!isAuthenticated) return;
    }

    // Acquire lock and perform logout
    currentOperationType = 'logout';
    currentOperation = performLogout();

    try {
      await currentOperation;
    } finally {
      currentOperation = null;
      currentOperationType = null;
    }
  }, [isAuthenticated, clearAuth]);

  async function performLogout(): Promise<void> {
    try {
      // Call REST logout endpoint (clears httpOnly cookie)
      await fetch('/i/auth/logout', {
        method: 'POST',
        credentials: 'include', // Important: send cookies
      });
    } catch (error) {
      console.error('[AUTH] Logout error:', error);
    }

    // Clear all auth state
    clearAuth();

    // Clear mock wallet from localStorage (if exists)
    // This ensures switching between mock and real wallets works
    localStorage.removeItem('suiftly_mock_wallet');

    toast.info('Logged out');
  }

  return {
    user,
    isAuthenticated,
    login,
    logout,
  };
}
