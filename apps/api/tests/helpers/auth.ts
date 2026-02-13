/**
 * Authentication test utilities
 *
 * Helpers for authenticating in API tests.
 * Uses MOCK_AUTH mode to bypass signature verification.
 */

import { restCall } from './http.js';

const API_BASE = 'http://localhost:22700'; // See ~/mhaxbe/PORT_MAP.md

// Default test wallet address (same as E2E tests)
export const TEST_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Login and get session cookie
 *
 * This uses the REST auth endpoint with MOCK_AUTH enabled.
 * In mock mode, signature verification is skipped.
 *
 * @param walletAddress - Wallet address to login as
 * @returns Session cookie string for subsequent requests
 */
export async function login(walletAddress: string = TEST_WALLET): Promise<string> {
  // Step 1: Connect - POST /i/auth/connect with { walletAddress }
  const connectResponse = await fetch(`${API_BASE}/i/auth/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress }),
  });
  if (!connectResponse.ok) {
    throw new Error(`Failed to connect: ${await connectResponse.text()}`);
  }
  const { nonce } = await connectResponse.json() as { nonce: string };

  // Step 2: Verify - POST /i/auth/verify with { walletAddress, signature, nonce }
  // In MOCK_AUTH mode, any signature is accepted
  const verifyResponse = await fetch(`${API_BASE}/i/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress,
      signature: 'mock_signature_for_testing',
      nonce,
    }),
  });

  if (!verifyResponse.ok) {
    throw new Error(`Login failed: ${await verifyResponse.text()}`);
  }

  // Verify returns accessToken in the response body (for tRPC Authorization header)
  const { accessToken } = await verifyResponse.json() as { accessToken: string };
  if (!accessToken) {
    throw new Error(`Login succeeded but no access token returned`);
  }

  return accessToken;
}

/**
 * Login and return both cookie and customer ID
 */
export async function loginWithCustomerId(
  walletAddress: string = TEST_WALLET
): Promise<{ cookie: string; customerId: number }> {
  const cookie = await login(walletAddress);

  // Get customer info
  const result = await restCall<any>('GET', `/test/data/customer?walletAddress=${walletAddress}`, undefined, cookie);
  if (!result.success || !result.data?.customer) {
    throw new Error(`Failed to get customer info: ${result.error}`);
  }

  return {
    cookie,
    customerId: result.data.customer.customerId,
  };
}

/**
 * Logout (clear session)
 */
export async function logout(cookie: string): Promise<void> {
  await fetch(`${API_BASE}/i/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
}
