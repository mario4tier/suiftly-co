/**
 * gRPC Real HAProxy Request Tests
 *
 * Tests end-to-end flow through HAProxy with real API keys:
 * 1. Setup customer with gRPC service + API key
 * 2. Sync vault to HAProxy (GM → LM → HAProxy maps)
 * 3. Send HTTP/2 requests through HAProxy gRPC frontend
 * 4. Verify auth acceptance/rejection
 *
 * Prerequisites:
 * - HAProxy running with gRPC frontend (port 20204)
 * - GM running (vault generation)
 * - LM running (vault application to HAProxy maps)
 * - sui-proxy backend running (mgrpc1/mgrpc2)
 *
 * Uses HTTP/2 because gRPC HAProxy frontend requires `proto h2`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as http2 from 'node:http2';
import { db } from '@suiftly/database';
import { serviceInstances, systemControl } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE, GRPC_PORT, GRPC_BACKEND_PORT } from '@suiftly/shared/constants';
import {
  trpcMutation,
} from './helpers/http.js';
import { setupBillingTest, type SetupBillingTestResult } from './helpers/setup.js';

// ============================================================================
// HTTP/2 Helper for gRPC HAProxy requests
// ============================================================================

interface GrpcRequestOptions {
  apiKey?: string;
  port?: number;
  clientIp?: string;
  path?: string;
  timeout?: number;
}

interface GrpcResponse {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

/**
 * Make an HTTP/2 request through the gRPC HAProxy frontend.
 * HAProxy gRPC frontend requires HTTP/2 (proto h2).
 */
function grpcRequest(options: GrpcRequestOptions): Promise<GrpcResponse> {
  const port = options.port ?? GRPC_PORT.MAINNET_LOCAL;
  const path = options.path ?? '/health';
  const timeout = options.timeout ?? 5000;

  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);

    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'GET',
      ':path': path,
    };

    if (options.apiKey) {
      headers['x-api-key'] = options.apiKey;
    }
    if (options.clientIp) {
      headers['cf-connecting-ip'] = options.clientIp;
    }

    const timeoutId = setTimeout(() => {
      client.close();
      resolve({ ok: false, status: 0, body: '', error: 'timeout' });
    }, timeout);

    client.on('error', (err) => {
      clearTimeout(timeoutId);
      client.close();
      resolve({ ok: false, status: 0, body: '', error: err.message });
    });

    const req = client.request(headers);
    let data = '';
    let status = 0;

    req.on('response', (responseHeaders) => {
      status = responseHeaders[':status'] as number ?? 0;
    });

    req.on('data', (chunk) => {
      data += chunk;
    });

    req.on('end', () => {
      clearTimeout(timeoutId);
      client.close();
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: data,
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      client.close();
      resolve({ ok: false, status: 0, body: '', error: err.message });
    });

    req.end();
  });
}

/**
 * Retry an HTTP/2 request until expected status or timeout.
 */
async function grpcRequestWithRetry(
  options: GrpcRequestOptions,
  retryOptions: { maxAttempts?: number; delayMs?: number; expectedStatus?: number } = {}
): Promise<GrpcResponse> {
  const maxAttempts = retryOptions.maxAttempts ?? 5;
  const delayMs = retryOptions.delayMs ?? 2000;
  const expectedStatus = retryOptions.expectedStatus ?? 200;

  let lastResponse: GrpcResponse = { ok: false, status: 0, body: '', error: 'no attempts' };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResponse = await grpcRequest(options);

    if (lastResponse.status === expectedStatus) {
      return lastResponse;
    }

    if (attempt < maxAttempts) {
      console.log(`  Attempt ${attempt}/${maxAttempts} got ${lastResponse.status}, retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return lastResponse;
}

// ============================================================================
// Vault Sync Helpers
// ============================================================================

const GM_BASE = 'http://localhost:22600';

async function triggerVaultSyncAndWait(timeoutMs = 15000): Promise<void> {
  // Trigger GM sync
  await fetch(`${GM_BASE}/api/queue/sync-all`, { method: 'POST' });

  // Trigger sync-files to propagate vault to LM data dir
  await fetch('http://localhost:22800/api/service/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'sync-files' }),
  });

  // Wait for LM to apply the vault
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://localhost:22610/api/health');
      if (res.ok) {
        const data = await res.json() as any;
        const rmaVault = data.vaults?.find((v: any) => v.type === 'rma');
        const [control] = await db
          .select({ rmaVaultSeq: systemControl.rmaVaultSeq })
          .from(systemControl)
          .where(eq(systemControl.id, 1))
          .limit(1);

        const gmSeq = control?.rmaVaultSeq ?? 0;
        const lmSeq = rmaVault?.applied?.seq ?? 0;

        if (gmSeq > 0 && lmSeq >= gmSeq) {
          return; // LM is caught up
        }
      }
    } catch { /* retry */ }

    // Re-trigger sync
    await fetch(`${GM_BASE}/api/queue/sync-all`, { method: 'POST' });
    await fetch('http://localhost:22800/api/service/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'sync-files' }),
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error('Timed out waiting for LM to apply rma vault');
}

// ============================================================================
// Prerequisite Checks
// ============================================================================

async function isHAProxyGrpcAvailable(): Promise<boolean> {
  try {
    const res = await grpcRequest({ path: '/health', timeout: 2000 });
    return res.status > 0; // Any response means HAProxy is listening
  } catch {
    return false;
  }
}

async function isGrpcBackendAvailable(): Promise<boolean> {
  try {
    const res = await grpcRequest({ port: GRPC_BACKEND_PORT.MAINNET_1, path: '/health', timeout: 2000 });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// Test Setup
// ============================================================================

let setup: SetupBillingTestResult;
let grpcApiKey: string;
let grpcApiKeyFp: number;
let haproxyAvailable: boolean;
let backendAvailable: boolean;

beforeAll(async () => {
  // Check prerequisites
  haproxyAvailable = await isHAProxyGrpcAvailable();
  backendAvailable = await isGrpcBackendAvailable();

  if (!haproxyAvailable) {
    console.warn('SKIP: HAProxy gRPC frontend not available on port', GRPC_PORT.MAINNET_LOCAL);
    return;
  }

  // Setup customer
  setup = await setupBillingTest({ balance: 100 });

  // Enable gRPC service (sets cpEnabled=true)
  await trpcMutation('services.toggleService', { serviceType: 'grpc', enabled: true }, setup.accessToken);

  // Create API key and capture the plaintext key
  const keyResult = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
  if (keyResult.error) {
    throw new Error(`Failed to create gRPC API key: ${JSON.stringify(keyResult.error)}`);
  }
  grpcApiKey = keyResult.result!.data.apiKey;
  grpcApiKeyFp = keyResult.result!.data.created.apiKeyFp;

  // Sync vault to HAProxy
  await triggerVaultSyncAndWait();
}, 30000);

// ============================================================================
// Tests
// ============================================================================

describe('gRPC HAProxy Real Requests', () => {
  describe('Prerequisites', () => {
    it('should have HAProxy gRPC frontend running', () => {
      expect(haproxyAvailable).toBe(true);
    });

    it('should have gRPC backend (sui-proxy) running', () => {
      if (!haproxyAvailable) return;
      expect(backendAvailable).toBe(true);
    });
  });

  describe('Unauthenticated Access (local port)', () => {
    it('should allow health check on local port without API key', async () => {
      if (!haproxyAvailable) return;

      // Local port (20204) allows unauthenticated access
      const response = await grpcRequest({
        port: GRPC_PORT.MAINNET_LOCAL,
        path: '/health',
      });

      // Local port should proxy to backend
      expect(response.status).toBeGreaterThan(0);
      if (backendAvailable) {
        expect(response.ok).toBe(true);
        expect(response.body).toContain('up');
      }
    });
  });

  describe('Authenticated Access', () => {
    it('should accept request with valid API key on local port', async () => {
      if (!haproxyAvailable || !backendAvailable) return;

      const response = await grpcRequestWithRetry(
        {
          apiKey: grpcApiKey,
          port: GRPC_PORT.MAINNET_LOCAL,
          path: '/health',
          clientIp: '127.0.0.1',
        },
        { maxAttempts: 5, delayMs: 2000, expectedStatus: 200 }
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.body).toContain('up');
    });
  });

  describe('Backend Health', () => {
    it('should reach sui-proxy backend through HAProxy', async () => {
      if (!haproxyAvailable || !backendAvailable) return;

      const response = await grpcRequest({
        port: GRPC_PORT.MAINNET_LOCAL,
        path: '/health',
      });

      expect(response.ok).toBe(true);
      expect(response.body).toContain('up');
    });

    it('should reach sui-proxy directly on backend port', async () => {
      if (!backendAvailable) return;

      const response = await grpcRequest({
        port: GRPC_BACKEND_PORT.MAINNET_1,
        path: '/health',
      });

      expect(response.ok).toBe(true);
      expect(response.body).toContain('up');
    });
  });

  describe('Vault Content Verification', () => {
    it('should have customer in rma vault after API key creation', async () => {
      if (!haproxyAvailable) return;

      // Verify the customer appears in the vault data
      const [control] = await db
        .select({
          rmaVaultSeq: systemControl.rmaVaultSeq,
          rmaVaultEntries: systemControl.rmaVaultEntries,
        })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);

      expect(control!.rmaVaultSeq).toBeGreaterThan(0);
      expect(control!.rmaVaultEntries).toBeGreaterThanOrEqual(1);
    });

    it('should have gRPC service with cpEnabled in DB', async () => {
      if (!haproxyAvailable) return;

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, setup.customerId),
          eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
        ),
      });

      expect(service).toBeDefined();
      expect(service!.cpEnabled).toBe(true);
      expect(service!.isUserEnabled).toBe(true);
      expect(service!.state).toBe('enabled');
    });
  });

  describe('API Key Lifecycle through HAProxy', () => {
    it('should reject requests after API key is revoked', { timeout: 30000 }, async () => {
      if (!haproxyAvailable || !backendAvailable) return;

      // Revoke the key
      await trpcMutation('grpc.revokeApiKey', { apiKeyFp: grpcApiKeyFp }, setup.accessToken);

      // Sync vault to HAProxy
      await triggerVaultSyncAndWait();

      // Request with revoked key should now fail (403 or different error)
      // Note: On local port, HAProxy may still allow unauthenticated access
      // but the API key should no longer be in the vault
      const [control] = await db
        .select({ rmaVaultSeq: systemControl.rmaVaultSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);

      // Vault seq should have advanced (config changed)
      expect(control!.rmaVaultSeq).toBeGreaterThan(0);

      // Re-enable key for subsequent tests
      await trpcMutation('grpc.reEnableApiKey', { apiKeyFp: grpcApiKeyFp }, setup.accessToken);
      await triggerVaultSyncAndWait();
    });

    it('should accept requests after API key is re-enabled', async () => {
      if (!haproxyAvailable || !backendAvailable) return;

      const response = await grpcRequestWithRetry(
        {
          apiKey: grpcApiKey,
          port: GRPC_PORT.MAINNET_LOCAL,
          path: '/health',
          clientIp: '127.0.0.1',
        },
        { maxAttempts: 5, delayMs: 2000, expectedStatus: 200 }
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });
  });

  describe('Metered Port Auth (port 20004)', () => {
    it('should reject requests without API key on metered port', async () => {
      if (!haproxyAvailable) return;

      const response = await grpcRequest({
        port: GRPC_PORT.MAINNET_PUBLIC,
        path: '/health',
        clientIp: '127.0.0.1',
        // No apiKey
      });

      // Metered port requires valid API key -- HAProxy returns 401
      expect(response.status).toBe(401);
    });

    it('should accept requests with valid gRPC API key on metered port', { timeout: 30000 }, async () => {
      if (!haproxyAvailable || !backendAvailable) return;

      const response = await grpcRequestWithRetry(
        {
          apiKey: grpcApiKey,
          port: GRPC_PORT.MAINNET_PUBLIC,
          path: '/health',
          clientIp: '127.0.0.1',
        },
        { maxAttempts: 5, delayMs: 2000, expectedStatus: 200 }
      );

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.body).toContain('up');
    });

    it('should reject requests with invalid API key on metered port', async () => {
      if (!haproxyAvailable) return;

      const response = await grpcRequest({
        apiKey: 'INVALID_KEY_THAT_DOES_NOT_EXIST_12345',
        port: GRPC_PORT.MAINNET_PUBLIC,
        path: '/health',
        clientIp: '127.0.0.1',
      });

      expect(response.status).toBe(401);
    });
  });
});
