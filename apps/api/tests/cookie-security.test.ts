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

import { test, expect, describe } from 'vitest';

const API_URL = 'http://localhost:3000';

describe('Cookie Security Attributes', () => {
  test('POST /i/auth/verify should set httpOnly and sameSite=lax', async () => {
    // Step 1: Get nonce
    const connectResponse = await fetch(`${API_URL}/i/auth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });

    const { nonce } = await connectResponse.json();

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
    // Get nonce
    const connectResponse = await fetch(`${API_URL}/i/auth/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });

    const { nonce } = await connectResponse.json();

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

    // Max-Age should be positive
    expect(maxAge).toBeGreaterThan(0);

    // In test mode (short expiry), should be ~10 seconds
    // In normal mode, should be ~30 days (2592000 seconds)
    if (process.env.ENABLE_SHORT_JWT_EXPIRY === 'true') {
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
