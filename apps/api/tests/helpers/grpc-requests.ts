/**
 * Helper functions for making real gRPC requests through HAProxy
 *
 * Mirrors seal-requests.ts but uses HTTP/2 (required by gRPC HAProxy frontend).
 * Port reference: ~/mhaxbe/PORT_MAP.md
 */

import * as http2 from 'node:http2';
import { GRPC_PORT, GRPC_BACKEND_PORT } from '@suiftly/shared/constants';

export { GRPC_PORT, GRPC_BACKEND_PORT };

const DEFAULT_GRPC_PORT = GRPC_PORT.MAINNET_LOCAL;

export interface GrpcRequestOptions {
  apiKey?: string;
  port?: number;
  clientIp?: string;
  path?: string;
  timeout?: number;
}

export interface GrpcResponse {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  expectedStatus?: number;
}

/**
 * Make an HTTP/2 request through the gRPC HAProxy frontend.
 * gRPC HAProxy uses `proto h2` so HTTP/2 is required.
 */
export function grpcRequest(options: GrpcRequestOptions): Promise<GrpcResponse> {
  const port = options.port ?? DEFAULT_GRPC_PORT;
  const path = options.path ?? '/health';
  const timeout = options.timeout ?? 5000;

  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);
    const headers: http2.OutgoingHttpHeaders = { ':method': 'GET', ':path': path };
    if (options.apiKey) headers['x-api-key'] = options.apiKey;
    if (options.clientIp) headers['cf-connecting-ip'] = options.clientIp;

    const timeoutId = setTimeout(() => { client.close(); resolve({ ok: false, status: 0, body: '', error: 'timeout' }); }, timeout);
    client.on('error', (err) => { clearTimeout(timeoutId); client.close(); resolve({ ok: false, status: 0, body: '', error: err.message }); });

    const req = client.request(headers);
    let data = '';
    let status = 0;
    req.on('response', (h) => { status = h[':status'] as number ?? 0; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { clearTimeout(timeoutId); client.close(); resolve({ ok: status >= 200 && status < 300, status, body: data }); });
    req.on('error', (err) => { clearTimeout(timeoutId); client.close(); resolve({ ok: false, status: 0, body: '', error: err.message }); });
    req.end();
  });
}

/**
 * Make an HTTP/2 request with retry logic.
 */
export async function grpcRequestWithRetry(
  options: GrpcRequestOptions,
  retryOptions: RetryOptions = {}
): Promise<GrpcResponse> {
  const maxAttempts = retryOptions.maxAttempts ?? 5;
  const delayMs = retryOptions.delayMs ?? 2000;
  const expectedStatus = retryOptions.expectedStatus ?? 200;

  let lastResponse: GrpcResponse = { ok: false, status: 0, body: '', error: 'no attempts' };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResponse = await grpcRequest(options);
    if (lastResponse.status === expectedStatus) return lastResponse;
    if (attempt < maxAttempts) {
      console.log(`  Attempt ${attempt}/${maxAttempts} got ${lastResponse.status}, retrying...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return lastResponse;
}

/**
 * Check if HAProxy gRPC frontend is available.
 */
export async function isHAProxyGrpcAvailable(): Promise<boolean> {
  try {
    const res = await grpcRequest({ path: '/health', timeout: 2000 });
    return res.status > 0;
  } catch { return false; }
}

/**
 * Check if gRPC backend (sui-proxy) is available.
 */
export async function isGrpcBackendAvailable(): Promise<boolean> {
  try {
    const res = await grpcRequest({ port: GRPC_BACKEND_PORT.MAINNET_1, path: '/health', timeout: 2000 });
    return res.ok;
  } catch { return false; }
}

/**
 * Trigger GM vault sync + sync-files + wait for LM to apply.
 */
export async function triggerGrpcVaultSync(timeoutMs = 20000): Promise<void> {
  const { db, systemControl } = await import('@suiftly/database');
  const { eq } = await import('drizzle-orm');

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await fetch('http://localhost:22600/api/queue/sync-all', { method: 'POST' });
    await fetch('http://localhost:22800/api/service/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'sync-files' }),
    });

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
        if (rmaVault?.applied?.seq >= (control?.rmaVaultSeq ?? 0) && (control?.rmaVaultSeq ?? 0) > 0) {
          return;
        }
      }
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for gRPC vault sync');
}

/**
 * Read a file via sudob API.
 */
export async function readFileViaSudob(path: string): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:22800/api/files/read?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const data = await res.json() as any;
      return data.content ?? null;
    }
  } catch { /* ignore */ }
  return null;
}
