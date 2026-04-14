/**
 * gRPC Checkpoint Streaming E2E Tests
 *
 * Verifies that:
 * 1. SubscribeCheckpoints streams consecutive checkpoints through sui-proxy
 * 2. At least 2 checkpoints arrive within 2 seconds (mainnet ~2-4 cp/s)
 * 3. HAProxy meters bytes_sent accurately for the streaming connection
 *
 * Prerequisites:
 * - HAProxy running with gRPC frontend (port 20204 local, 20004 metered)
 * - sui-proxy backend (mgrpc1) running on port 20601
 * - GM + LM + API running (for metered port tests only)
 * - Mainnet Sui fullnode reachable (fullnode.mainnet.sui.io)
 *
 * Tests use the local unmetered port (20204) for streaming verification
 * and the metered port (20004) for HAProxy metering verification.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@suiftly/database';
import { haproxyRawLogs } from '@suiftly/database/schema';
import { eq, and, sql, gte } from 'drizzle-orm';
import { GRPC_PORT, SERVICE_TYPE_NUMBER } from '@suiftly/shared/constants';
import { trpcMutation } from './helpers/http.js';
import { setupBillingTest, type SetupBillingTestResult } from './helpers/setup.js';
import {
  grpcSubscribeCheckpoints,
  isGrpcBackendAvailable,
  isHAProxyGrpcAvailable,
  triggerGrpcVaultSync,
} from './helpers/grpc-requests.js';

// ============================================================================
// Streaming Tests (local port — only needs HAProxy + sui-proxy, no API server)
// ============================================================================

describe('Checkpoint Streaming via sui-proxy', () => {
  let haproxyAvailable: boolean;
  let backendAvailable: boolean;

  beforeAll(async () => {
    haproxyAvailable = await isHAProxyGrpcAvailable();
    backendAvailable = await isGrpcBackendAvailable();
    if (!haproxyAvailable || !backendAvailable) {
      console.warn('SKIP: HAProxy or gRPC backend not available');
    }
  });

  it('should have prerequisites running', () => {
    expect(haproxyAvailable).toBe(true);
    expect(backendAvailable).toBe(true);
  });

  it('should stream consecutive checkpoints through local port', { timeout: 15000 }, async () => {
    if (!haproxyAvailable || !backendAvailable) return;

    const result = await grpcSubscribeCheckpoints({
      port: GRPC_PORT.MAINNET_LOCAL,
      durationMs: 3000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);

    // Mainnet produces ~2-4 checkpoints/second — expect at least 2 in 3s.
    expect(result.messageCount).toBeGreaterThanOrEqual(2);
    expect(result.totalBytes).toBeGreaterThan(0);

    console.log(
      `  Streaming (local): ${result.messageCount} checkpoints, ${result.totalBytes} bytes in ${result.elapsedMs}ms`
    );
  });

  it('should receive at least 2 checkpoints within 2 seconds', { timeout: 10000 }, async () => {
    if (!haproxyAvailable || !backendAvailable) return;

    const result = await grpcSubscribeCheckpoints({
      port: GRPC_PORT.MAINNET_LOCAL,
      durationMs: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result.messageCount).toBeGreaterThanOrEqual(2);

    const rate = result.messageCount / (result.elapsedMs / 1000);
    console.log(
      `  Streaming speed: ${result.messageCount} checkpoints in ${result.elapsedMs}ms (${rate.toFixed(1)} cp/s)`
    );
  });

  it('should receive non-trivial byte counts per checkpoint', { timeout: 10000 }, async () => {
    if (!haproxyAvailable || !backendAvailable) return;

    const result = await grpcSubscribeCheckpoints({
      port: GRPC_PORT.MAINNET_LOCAL,
      durationMs: 2000,
    });

    expect(result.error).toBeUndefined();
    expect(result.messageCount).toBeGreaterThan(0);

    // Each checkpoint message should be at least a few bytes (gRPC frame overhead + protobuf).
    const avgBytes = result.totalBytes / result.messageCount;
    expect(avgBytes).toBeGreaterThan(5); // minimum: 5-byte gRPC header

    console.log(
      `  Avg checkpoint size: ${avgBytes.toFixed(0)} bytes (${result.messageCount} messages, ${result.totalBytes} total)`
    );
  });
});

// ============================================================================
// Metered Streaming Tests (metered port — requires full stack: API + GM + LM)
// ============================================================================

describe('Checkpoint Streaming Metering', () => {
  let haproxyAvailable: boolean;
  let backendAvailable: boolean;
  let apiAvailable: boolean;
  let setup: SetupBillingTestResult;
  let grpcApiKey: string;

  beforeAll(async () => {
    haproxyAvailable = await isHAProxyGrpcAvailable();
    backendAvailable = await isGrpcBackendAvailable();

    // Check if API server is running (needed for customer setup).
    try {
      const res = await fetch('http://localhost:22700/health');
      apiAvailable = res.ok;
    } catch {
      apiAvailable = false;
    }

    if (!haproxyAvailable || !backendAvailable || !apiAvailable) {
      console.warn('SKIP metering tests: need HAProxy + sui-proxy + API server');
      return;
    }

    // Setup customer with balance for metered port tests.
    setup = await setupBillingTest({ balance: 100 });

    // Enable gRPC service.
    await trpcMutation('services.toggleService', { serviceType: 'grpc', enabled: true }, setup.accessToken);

    // Create API key.
    const keyResult = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
    if (keyResult.error) throw new Error(`Failed to create API key: ${JSON.stringify(keyResult.error)}`);
    grpcApiKey = keyResult.result!.data.apiKey;

    // Sync vault to HAProxy.
    await triggerGrpcVaultSync();
  }, 30000);

  it('should reject streaming without API key on metered port', { timeout: 10000 }, async () => {
    if (!haproxyAvailable) return;

    const result = await grpcSubscribeCheckpoints({
      port: GRPC_PORT.MAINNET_PUBLIC,
      clientIp: '127.0.0.1',
      durationMs: 1000,
    });

    // No API key = 401
    expect(result.status).toBe(401);
  });

  it('should stream checkpoints with valid API key on metered port', { timeout: 15000 }, async () => {
    if (!haproxyAvailable || !backendAvailable || !apiAvailable) return;

    const result = await grpcSubscribeCheckpoints({
      port: GRPC_PORT.MAINNET_PUBLIC,
      apiKey: grpcApiKey,
      clientIp: '127.0.0.1',
      durationMs: 3000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.messageCount).toBeGreaterThanOrEqual(2);
    expect(result.totalBytes).toBeGreaterThan(0);

    console.log(
      `  Metered streaming: ${result.messageCount} checkpoints, ${result.totalBytes} bytes in ${result.elapsedMs}ms`
    );
  });

  it('should log bytes_sent in haproxy_raw_logs matching client bytes', { timeout: 30000 }, async () => {
    if (!haproxyAvailable || !backendAvailable || !apiAvailable) return;

    const timestampBefore = new Date();

    // Stream for 3 seconds through metered port.
    const result = await grpcSubscribeCheckpoints({
      port: GRPC_PORT.MAINNET_PUBLIC,
      apiKey: grpcApiKey,
      clientIp: '127.0.0.1',
      durationMs: 3000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.totalBytes).toBeGreaterThan(0);

    // Wait for fluentd pipeline: HAProxy -> rsyslog -> fluentd-lm (1s aggregation) -> fluentd-gm -> PostgreSQL.
    // Give it up to 10 seconds to propagate.
    let loggedBytes = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      const logs = await db
        .select({
          bytesSent: haproxyRawLogs.bytesSent,
          statusCode: haproxyRawLogs.statusCode,
          timeTotal: haproxyRawLogs.timeTotal,
          serviceType: haproxyRawLogs.serviceType,
        })
        .from(haproxyRawLogs)
        .where(
          and(
            gte(haproxyRawLogs.timestamp, timestampBefore),
            eq(haproxyRawLogs.customerId, setup.customerId),
            eq(haproxyRawLogs.serviceType, SERVICE_TYPE_NUMBER.grpc)
          )
        )
        .orderBy(sql`${haproxyRawLogs.timestamp} DESC`)
        .limit(5);

      if (logs.length > 0) {
        // Sum bytes from all matching log entries (could be aggregated).
        loggedBytes = logs.reduce((sum, l) => sum + (l.bytesSent ?? 0), 0);
        if (loggedBytes > 0) {
          console.log(`  HAProxy logged: ${loggedBytes} bytes (client received: ${result.totalBytes})`);
          console.log(`  Log entries: ${logs.length}, time_total: ${logs[0]?.timeTotal}ms`);
          break;
        }
      }
    }

    // HAProxy bytes_sent should be close to what the client received.
    // They won't be identical because HAProxy counts at HTTP/2 frame level
    // while the client counts DATA frame payloads, but they should be
    // in the same ballpark.
    expect(loggedBytes).toBeGreaterThan(0);

    // Allow 50% tolerance for framing overhead differences.
    const ratio = loggedBytes / result.totalBytes;
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);

    console.log(
      `  Metering accuracy: HAProxy=${loggedBytes}, client=${result.totalBytes}, ratio=${ratio.toFixed(2)}`
    );
  });
});
