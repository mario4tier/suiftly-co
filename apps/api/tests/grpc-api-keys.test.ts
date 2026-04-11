/**
 * gRPC API Key Management Tests
 *
 * Tests the gRPC service API key lifecycle:
 * - Create API keys
 * - List API keys
 * - Revoke/re-enable API keys
 * - Delete API keys
 * - Vault sync tracking (rmaConfigChangeVaultSeq)
 *
 * Uses real database and API server (integration test).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, systemControl } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';
import {
  trpcQuery,
  trpcMutation,
  subscribeAndEnable,
} from './helpers/http.js';
import { setupBillingTest, type SetupBillingTestResult } from './helpers/setup.js';

// ============================================================================
// Test Setup
// ============================================================================

let setup: SetupBillingTestResult;

beforeAll(async () => {
  // Setup: reset → login → fund → subscribe platform (auto-provisions grpc)
  setup = await setupBillingTest({ balance: 100 });
});

// ============================================================================
// Tests
// ============================================================================

describe('gRPC API Key Management', () => {
  describe('Service Provisioning', () => {
    it('should have gRPC service auto-provisioned after platform subscribe', async () => {
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, setup.customerId),
          eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
        ),
      });

      expect(service).toBeDefined();
      expect(service!.serviceType).toBe('grpc');
      // Auto-provisioned services start disabled
      expect(service!.state).toBe('disabled');
      expect(service!.isUserEnabled).toBe(false);
    });

    it('should enable gRPC service via toggle', async () => {
      const result = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'grpc', enabled: true },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.isUserEnabled).toBe(true);
      expect(result.result?.data?.state).toBe('enabled');

      // gRPC sets cpEnabled=true on enable (no seal key requirement)
      expect(result.result?.data?.cpEnabled).toBe(true);
    });

    it('should set rmaConfigChangeVaultSeq when toggling', async () => {
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, setup.customerId),
          eq(serviceInstances.serviceType, SERVICE_TYPE.GRPC)
        ),
      });

      expect(service).toBeDefined();
      // rmaConfigChangeVaultSeq should be > 0 (set during toggle)
      expect(service!.rmaConfigChangeVaultSeq).toBeGreaterThan(0);
      // smaConfigChangeVaultSeq should remain 0 (gRPC doesn't use sma)
      expect(service!.smaConfigChangeVaultSeq).toBe(0);
    });
  });

  describe('API Key CRUD', () => {
    let createdApiKeyFp: number;

    it('should list API keys (initially empty)', async () => {
      const result = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);

      expect(result.error).toBeUndefined();
      // May have auto-provisioned key from subscription, or empty
      expect(Array.isArray(result.result?.data)).toBe(true);
    });

    it('should create a new API key', async () => {
      const result = await trpcMutation<any>(
        'grpc.createApiKey',
        {},
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.apiKey).toBeDefined();
      expect(typeof result.result?.data?.apiKey).toBe('string');
      expect(result.result?.data?.apiKey.length).toBeGreaterThan(0);

      createdApiKeyFp = result.result?.data?.created?.apiKeyFp;
      expect(createdApiKeyFp).toBeDefined();
      expect(typeof createdApiKeyFp).toBe('number');
    });

    it('should list the created API key', async () => {
      const result = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);

      expect(result.error).toBeUndefined();
      const keys = result.result?.data ?? [];
      const found = keys.find((k: any) => k.apiKeyFp === createdApiKeyFp);
      expect(found).toBeDefined();
      expect(found.isUserEnabled).toBe(true);
      expect(found.keyPreview).toMatch(/^.{8}\.\.\..{4}$/);
      expect(found.fullKey).toBeDefined();
    });

    it('should revoke the API key', async () => {
      const result = await trpcMutation<any>(
        'grpc.revokeApiKey',
        { apiKeyFp: createdApiKeyFp },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);

      // Verify key is now revoked
      const listResult = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);
      const key = listResult.result?.data?.find((k: any) => k.apiKeyFp === createdApiKeyFp);
      expect(key?.isUserEnabled).toBe(false);
      expect(key?.revokedAt).toBeDefined();
    });

    it('should re-enable the revoked API key', async () => {
      const result = await trpcMutation<any>(
        'grpc.reEnableApiKey',
        { apiKeyFp: createdApiKeyFp },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);

      // Verify key is active again
      const listResult = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);
      const key = listResult.result?.data?.find((k: any) => k.apiKeyFp === createdApiKeyFp);
      expect(key?.isUserEnabled).toBe(true);
      expect(key?.revokedAt).toBeNull();
    });

    it('should delete the API key', async () => {
      const result = await trpcMutation<any>(
        'grpc.deleteApiKey',
        { apiKeyFp: createdApiKeyFp },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);

      // Deleted key should not appear in list
      const listResult = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);
      const key = listResult.result?.data?.find((k: any) => k.apiKeyFp === createdApiKeyFp);
      expect(key).toBeUndefined();
    });
  });

  describe('API Key Limits', () => {
    it('should enforce API key limit', async () => {
      // Default limit is 2 keys. Account may already have auto-provisioned key(s).
      // List current keys to determine how many more we can create.
      const listResult = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);
      const existingKeys = listResult.result?.data ?? [];
      const createdFps: number[] = [];

      // Fill up to the limit
      for (let i = existingKeys.length; i < 2; i++) {
        const key = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
        expect(key.error).toBeUndefined();
        createdFps.push(key.result?.data?.created?.apiKeyFp);
      }

      // One more should fail
      const overLimit = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
      expect(overLimit.error).toBeDefined();
      expect(JSON.stringify(overLimit.error)).toContain('Maximum API key limit reached');

      // Cleanup: delete keys we created so other tests aren't affected
      for (const fp of createdFps) {
        await trpcMutation('grpc.deleteApiKey', { apiKeyFp: fp }, setup.accessToken);
      }
    });
  });

  describe('Vault Sync Tracking', () => {
    it('should update rmaMaxConfigChangeSeq on API key creation', async () => {
      // Make room: delete any existing keys to stay within limit
      const listResult = await trpcQuery<any[]>('grpc.listApiKeys', undefined, setup.accessToken);
      const existing = listResult.result?.data ?? [];
      for (const key of existing) {
        await trpcMutation('grpc.deleteApiKey', { apiKeyFp: key.apiKeyFp }, setup.accessToken);
      }

      // Trigger GM sync to advance vault seq past any pending changes
      await fetch('http://localhost:22600/api/queue/sync-all', { method: 'POST' });

      // Get baseline
      const [controlBefore] = await db
        .select({ rmaMaxConfigChangeSeq: systemControl.rmaMaxConfigChangeSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);
      const baselineSeq = controlBefore?.rmaMaxConfigChangeSeq ?? 0;

      // Create key (triggers markConfigChanged for grpc)
      const result = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);
      expect(result.error).toBeUndefined();

      // Verify rmaMaxConfigChangeSeq increased
      const [controlAfter] = await db
        .select({ rmaMaxConfigChangeSeq: systemControl.rmaMaxConfigChangeSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);

      expect(controlAfter!.rmaMaxConfigChangeSeq).toBeGreaterThan(baselineSeq);

      // Cleanup
      await trpcMutation('grpc.deleteApiKey', { apiKeyFp: result.result?.data?.created?.apiKeyFp }, setup.accessToken);
    });
  });
});

describe('gRPC Settings', () => {
  describe('More Settings', () => {
    it('should get default settings', async () => {
      const result = await trpcQuery<any>('grpc.getMoreSettings', undefined, setup.accessToken);

      expect(result.error).toBeUndefined();
      const settings = result.result?.data;
      expect(settings).toBeDefined();
      expect(typeof settings.burstEnabled).toBe('boolean');
      expect(typeof settings.ipAllowlistEnabled).toBe('boolean');
      expect(Array.isArray(settings.ipAllowlist)).toBe(true);
    });
  });

  describe('Burst Setting', () => {
    it('should reject burst for starter tier', async () => {
      // Default platform tier is 'starter' which doesn't support burst
      const result = await trpcMutation<any>(
        'grpc.updateBurstSetting',
        { enabled: true },
        setup.accessToken
      );

      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toContain('Pro tier');
    });
  });

  describe('IP Allowlist', () => {
    it('should reject IP allowlist for starter tier', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true },
        setup.accessToken
      );

      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toContain('Pro tier');
    });
  });

  describe('Usage Stats', () => {
    it('should return usage stats', async () => {
      const result = await trpcQuery<any>('grpc.getUsageStats', undefined, setup.accessToken);

      expect(result.error).toBeUndefined();
      const stats = result.result?.data;
      expect(stats).toBeDefined();
      expect(stats.apiKeys).toBeDefined();
      expect(typeof stats.apiKeys.used).toBe('number');
      expect(typeof stats.apiKeys.total).toBe('number');
      expect(stats.allowlist).toBeDefined();
    });
  });
});
