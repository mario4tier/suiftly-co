/**
 * Helper functions for making real Seal requests through HAProxy
 *
 * These helpers enable E2E tests that verify the full flow:
 * customer → API key → vault sync → HAProxy → Seal backend
 *
 * Port reference: ~/walrus/PORT_MAP.md (single source of truth)
 * Constants defined in: @suiftly/shared/constants
 */

import { SEAL_PORT, SEAL_BACKEND_PORT } from '@suiftly/shared';

// Re-export for convenience (avoid breaking existing imports)
export const SEAL_PORTS = SEAL_PORT;
export const SEAL_BACKEND_PORTS = SEAL_BACKEND_PORT;

// Default to local access port for development testing
const DEFAULT_SEAL_PORT = SEAL_PORT.MAINNET_LOCAL;

export interface SealRequestOptions {
  /** The API key to authenticate with */
  apiKey: string;
  /** HAProxy port to use (default: 20202 local access) */
  port?: number;
  /** Client IP to simulate (for CF-Connecting-IP header) */
  clientIp?: string;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
}

export interface SealHealthResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body?: unknown;
  error?: string;
  headers?: Record<string, string>;
}

/**
 * Make a health check request to the Seal service through HAProxy
 *
 * This tests the full authentication flow:
 * 1. HAProxy receives request with X-API-Key header
 * 2. HAProxy Lua validates API key (HMAC, decryption)
 * 3. HAProxy looks up customer config from vault map
 * 4. If valid, request is proxied to Seal backend
 * 5. Seal backend returns health status
 *
 * @param options Request configuration
 * @returns Health check response with status and body
 */
export async function sealHealthCheck(
  options: SealRequestOptions
): Promise<SealHealthResponse> {
  const port = options.port ?? DEFAULT_SEAL_PORT;
  const timeout = options.timeout ?? 10000;
  const clientIp = options.clientIp ?? '127.0.0.1';

  const url = `http://localhost:${port}/health`;

  const headers: Record<string, string> = {
    'X-API-Key': options.apiKey,
    // CF-Connecting-IP is required by HAProxy (simulates Cloudflare proxy)
    'CF-Connecting-IP': clientIp,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    // Try to parse response body
    let body: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    // Extract relevant response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
      headers: responseHeaders,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Check for specific error types
    if (errorMessage.includes('ECONNREFUSED')) {
      return {
        ok: false,
        status: 0,
        statusText: 'Connection refused',
        error: `HAProxy not running on port ${port}`,
      };
    }

    if (errorMessage.includes('aborted') || errorMessage.includes('timeout')) {
      return {
        ok: false,
        status: 0,
        statusText: 'Request timeout',
        error: `Request timed out after ${timeout}ms`,
      };
    }

    return {
      ok: false,
      status: 0,
      statusText: 'Request failed',
      error: errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Make a generic Seal API request through HAProxy
 *
 * @param path API path (e.g., '/v1/key/list')
 * @param options Request configuration
 * @param method HTTP method (default: GET)
 * @param body Request body (for POST/PUT)
 */
export async function sealRequest(
  path: string,
  options: SealRequestOptions,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown
): Promise<SealHealthResponse> {
  const port = options.port ?? DEFAULT_SEAL_PORT;
  const timeout = options.timeout ?? 10000;
  const clientIp = options.clientIp ?? '127.0.0.1';

  const url = `http://localhost:${port}${path}`;

  const headers: Record<string, string> = {
    'X-API-Key': options.apiKey,
    'CF-Connecting-IP': clientIp,
    'Content-Type': 'application/json',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    // Try to parse response body
    let responseBody: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      status: 0,
      statusText: 'Request failed',
      error: errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if HAProxy is running and accessible (via stats endpoint on port 1936)
 */
export async function isHAProxyAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    // HAProxy stats endpoint is always available
    const response = await fetch(`http://localhost:1936/haproxy?stats`, {
      signal: controller.signal,
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check if the Seal backend is running (bypassing HAProxy)
 * Uses the direct backend port (SEAL_BACKEND_PORT.MAINNET_1 = 20401 for mseal1)
 */
export async function isSealBackendAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    // Direct backend health check
    const response = await fetch(`http://localhost:${SEAL_BACKEND_PORT.MAINNET_1}/health`, {
      signal: controller.signal,
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
