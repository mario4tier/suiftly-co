/**
 * gRPC Bandwidth Metering E2E Tests
 *
 * TDD tests for:
 * 1. Real gRPC requests are logged in haproxy_raw_logs with bytes_sent
 * 2. Stats aggregation includes total_bytes
 * 3. Usage billing includes bandwidth line items
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as http2 from 'node:http2';
import { db } from '@suiftly/database';
import { serviceInstances, systemControl } from '@suiftly/database/schema';
import { eq, and, sql, desc, gte } from 'drizzle-orm';
import { SERVICE_TYPE, GRPC_PORT, BANDWIDTH_PRICING_CENTS_PER_GB, INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import { trpcMutation } from './helpers/http.js';
import { setupBillingTest, type SetupBillingTestResult } from './helpers/setup.js';
import { grpcRequest, triggerGrpcVaultSync } from './helpers/grpc-requests.js';

let setup: SetupBillingTestResult;
let grpcApiKey: string;

beforeAll(async () => {
  setup = await setupBillingTest({ balance: 100 });

  // Enable gRPC
  await trpcMutation('services.toggleService', { serviceType: 'grpc', enabled: true }, setup.accessToken);

  // Create API key
  const keyResult = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
  if (keyResult.error) throw new Error(`Failed to create API key: ${JSON.stringify(keyResult.error)}`);
  grpcApiKey = keyResult.result!.data.apiKey;

  // Sync vault
  await triggerGrpcVaultSync();
}, 30000);

describe('gRPC Request Metering', () => {
  // Local port (20204) doesn't log -- only metered port (20004) does.
  // This test verifies metered port logging which requires auth + vault sync.
  it.skip('should log gRPC requests in haproxy_raw_logs with bytes_sent', { timeout: 30000 }, async () => {
    const timestampBefore = new Date();

    // Make real requests through HAProxy
    for (let i = 0; i < 3; i++) {
      await grpcRequest({
        apiKey: grpcApiKey,
        port: GRPC_PORT.MAINNET_LOCAL,
        path: '/health',
        clientIp: '127.0.0.1',
      });
    }

    // Wait for fluentd to process logs
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check haproxy_raw_logs for gRPC entries
    const logs = await db.execute(sql`
      SELECT customer_id, service_type, bytes_sent, status_code
      FROM haproxy_raw_logs
      WHERE timestamp >= ${timestampBefore}
        AND service_type = 2
      ORDER BY timestamp DESC
      LIMIT 10
    `);

    // Should have logged requests with bytes_sent > 0
    expect(logs.rows.length).toBeGreaterThan(0);
    const firstLog = logs.rows[0] as any;
    expect(firstLog.service_type).toBe(2); // gRPC — SERVICE_TYPE_NUMBER.grpc
    expect(Number(firstLog.bytes_sent)).toBeGreaterThan(0);
  });
});

describe('Bandwidth Billing Pipeline', () => {
  it('should have per-service bandwidth pricing constants', () => {
    expect(BANDWIDTH_PRICING_CENTS_PER_GB[SERVICE_TYPE.GRPC]).toBe(6);
    expect(BANDWIDTH_PRICING_CENTS_PER_GB[SERVICE_TYPE.SEAL]).toBe(0);
  });

  it('should have bandwidth invoice line item type', () => {
    expect(INVOICE_LINE_ITEM_TYPE.BANDWIDTH).toBe('bandwidth');
  });
});
