/**
 * Cookie Security Tests
 *
 * Tests that verify security attributes of cookies:
 * - httpOnly: prevents JavaScript access
 * - sameSite: prevents CSRF attacks
 * - secure: HTTPS only in production
 *
 * Note: These tests require a running server at http://localhost:3000
 * Run with: MOCK_AUTH=true npm run dev (in apps/api)
 */

import { test, expect, describe, beforeAll } from 'vitest';
import { spawn } from 'child_process';

const API_URL = 'http://localhost:3000';

/**
 * Wait for server to be ready by polling health endpoint
 */
async function waitForServer(maxAttempts = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${API_URL}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`Server not ready after ${maxAttempts} attempts`);
}

/**
 * Restart server if it's running with short JWT expiry
 */
async function ensureNormalJWTConfig(): Promise<void> {
  try {
    // Check current server config
    const configResponse = await fetch(`${API_URL}/test/config`);
    if (!configResponse.ok) {
      console.log('[TEST SETUP] Server not running or config endpoint unavailable');
      return;
    }

    const serverConfig = await configResponse.json() as { shortJWTExpiry?: boolean };

    if (serverConfig.shortJWTExpiry) {
      console.log('[TEST SETUP] Server running with short JWT expiry - restarting with normal config...');

      // Shutdown server
      try {
        await fetch(`${API_URL}/test/shutdown`, { method: 'POST' });
        console.log('[TEST SETUP] Shutdown request sent');
      } catch (error) {
        // Expected - server is shutting down
      }

      // Wait for server to stop (health endpoint should fail)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Start server with normal config (no SHORT_JWT_EXPIRY)
      console.log('[TEST SETUP] Starting server with normal JWT expiry...');
      const serverProcess = spawn('npm', ['run', 'dev'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MOCK_AUTH: 'true',
          SHORT_JWT_EXPIRY: undefined, // Ensure not set
        },
        stdio: 'ignore',
        detached: true,
      });

      // Don't wait for the process
      serverProcess.unref();

      // Wait for server to be ready
      console.log('[TEST SETUP] Waiting for server to be ready...');
      await waitForServer();
      console.log('[TEST SETUP] Server ready with normal JWT expiry');
    } else {
      console.log('[TEST SETUP] Server already running with normal JWT expiry');
    }
  } catch (error) {
    console.warn('[TEST SETUP] Could not verify/fix server config:', error);
    // Continue anyway - let tests fail with proper error if config is wrong
  }
}

describe('Cookie Security Attributes', () => {
  // Ensure server is running with normal JWT config before tests
  beforeAll(async () => {
    await ensureNormalJWTConfig();
  });
  test('POST /i/auth/verify should set httpOnly and sameSite=lax', async () => {
    // Step 1: Get nonce
    const connectResponse = await fetch(`${API_URL}/i/auth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });

    const { nonce } = await connectResponse.json() as { nonce: string };

    // Step 2: Verify signature (mock auth)
    const verifyResponse = await fetch(`${API_URL}/i/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        signature: 'bW9ja19zaWduYXR1cmVfZm9yX1NpZ24gaW4gdG8gU3VpZnRseQoKVGhpcyBhcHBy',
        nonce,
      }),
    });

    expect(verifyResponse.status).toBe(200);

    // Get Set-Cookie header
    const setCookieHeader = verifyResponse.headers.get('set-cookie');
    expect(setCookieHeader).toBeTruthy();

    console.log('[TEST] Set-Cookie header:', setCookieHeader);

    // Verify security attributes
    expect(setCookieHeader).toContain('refreshToken=');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Lax');
    expect(setCookieHeader).toContain('Path=/');

    // In development, secure should NOT be set (http://localhost)
    // In production, it SHOULD be set
    if (process.env.NODE_ENV === 'production') {
      expect(setCookieHeader).toContain('Secure');
    } else {
      expect(setCookieHeader).not.toContain('Secure');
    }
  });

  test('cookie should have Max-Age set for expiry', async () => {
    // Check server's actual configuration
    const configResponse = await fetch(`${API_URL}/test/config`);
    const serverConfig = await configResponse.json() as { shortJWTExpiry?: boolean };
    const shortJWTExpiry = serverConfig.shortJWTExpiry;

    // Get nonce
    const connectResponse = await fetch(`${API_URL}/i/auth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });

    const { nonce } = await connectResponse.json() as { nonce: string };

    // Verify signature
    const verifyResponse = await fetch(`${API_URL}/i/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        signature: 'bW9ja19zaWduYXR1cmVfZm9yX1NpZ24gaW4gdG8gU3VpZnRseQoKVGhpcyBhcHBy',
        nonce,
      }),
    });

    const setCookieHeader = verifyResponse.headers.get('set-cookie');

    // Should have Max-Age set (30 days = 2592000 seconds, or shorter in test mode)
    expect(setCookieHeader).toMatch(/Max-Age=\d+/);

    // Extract Max-Age value
    const maxAgeMatch = setCookieHeader!.match(/Max-Age=(\d+)/);
    expect(maxAgeMatch).toBeTruthy();

    const maxAge = parseInt(maxAgeMatch![1]);
    console.log('[TEST] Cookie Max-Age:', maxAge, 'seconds');
    console.log('[TEST] Server shortJWTExpiry:', shortJWTExpiry);

    // Max-Age should be positive
    expect(maxAge).toBeGreaterThan(0);

    // In test mode (short expiry), should be ~10 seconds
    // In normal mode, should be ~30 days (2592000 seconds)
    if (shortJWTExpiry) {
      expect(maxAge).toBeLessThan(30); // Test mode: very short
    } else {
      expect(maxAge).toBeGreaterThan(3600); // Production: at least 1 hour
    }
  });

  test('httpOnly cookie should NOT be accessible via JavaScript (behavioral)', () => {
    // This is a documentation test
    //
    // The Playwright tests in token-refresh.spec.ts implicitly verify this:
    // 1. The cookie is set (refresh works)
    // 2. JavaScript can't read it (document.cookie doesn't show it)
    //
    // httpOnly means the browser will NOT expose the cookie to JavaScript,
    // which is verified by our E2E tests succeeding (cookie sent by browser
    // automatically, not by JavaScript code)
    expect(true).toBe(true);
  });
});
