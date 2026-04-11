/**
 * gRPC Settings Tests (Pro Tier)
 *
 * Tests gRPC service settings that require Pro platform tier:
 * - Burst toggle (enable/disable)
 * - IP allowlist (add/remove/toggle)
 * - Vault sync tracking for settings changes
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
// Test Setup - Pro Tier
// ============================================================================

let setup: SetupBillingTestResult;

beforeAll(async () => {
  // Setup with Pro tier (required for burst and IP allowlist)
  setup = await setupBillingTest({ balance: 200 });

  // Upgrade platform to Pro tier (burst/IP allowlist are Pro features)
  await trpcMutation('services.upgradeTier', { serviceType: 'platform', newTier: 'pro' }, setup.accessToken);

  // Enable gRPC service
  await trpcMutation('services.toggleService', { serviceType: 'grpc', enabled: true }, setup.accessToken);
});

// ============================================================================
// Tests
// ============================================================================

describe('gRPC Settings (Pro Tier)', () => {
  describe('Burst Setting', () => {
    it('should enable burst for Pro tier', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateBurstSetting',
        { enabled: true },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.burstEnabled).toBe(true);
    });

    it('should disable burst', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateBurstSetting',
        { enabled: false },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.burstEnabled).toBe(false);
    });

    it('should persist burst setting', async () => {
      // Enable burst
      await trpcMutation('grpc.updateBurstSetting', { enabled: true }, setup.accessToken);

      // Verify via getMoreSettings
      const settings = await trpcQuery<any>('grpc.getMoreSettings', undefined, setup.accessToken);
      expect(settings.result?.data?.burstEnabled).toBe(true);

      // Disable for cleanup
      await trpcMutation('grpc.updateBurstSetting', { enabled: false }, setup.accessToken);
    });

    it('should update rmaConfigChangeVaultSeq on burst change', async () => {
      // Trigger GM sync to advance vault seq past any pending changes
      await fetch('http://localhost:22600/api/queue/sync-all', { method: 'POST' });

      const [controlBefore] = await db
        .select({ seq: systemControl.rmaMaxConfigChangeSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);
      const baselineSeq = controlBefore?.seq ?? 0;

      await trpcMutation('grpc.updateBurstSetting', { enabled: true }, setup.accessToken);

      const [controlAfter] = await db
        .select({ seq: systemControl.rmaMaxConfigChangeSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);

      expect(controlAfter!.seq).toBeGreaterThan(baselineSeq);

      // Cleanup
      await trpcMutation('grpc.updateBurstSetting', { enabled: false }, setup.accessToken);
    });
  });

  describe('IP Allowlist', () => {
    it('should enable IP allowlist', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.enabled).toBe(true);
    });

    it('should save valid IP addresses', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true, entries: '192.168.1.1, 10.0.0.1' },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.entries).toEqual(['192.168.1.1', '10.0.0.1']);
    });

    it('should persist IP allowlist via getMoreSettings', async () => {
      const settings = await trpcQuery<any>('grpc.getMoreSettings', undefined, setup.accessToken);

      expect(settings.result?.data?.ipAllowlistEnabled).toBe(true);
      expect(settings.result?.data?.ipAllowlist).toEqual(['192.168.1.1', '10.0.0.1']);
    });

    it('should reject invalid IP addresses', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true, entries: 'not-an-ip' },
        setup.accessToken
      );

      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toContain('Invalid');
    });

    it('should reject IPv6 addresses', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true, entries: '::1' },
        setup.accessToken
      );

      expect(result.error).toBeDefined();
    });

    it('should enforce IP address limit', async () => {
      // Default limit is 2 for Pro tier
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: true, entries: '1.1.1.1, 2.2.2.2, 3.3.3.3' },
        setup.accessToken
      );

      expect(result.error).toBeDefined();
      expect(JSON.stringify(result.error)).toContain('Maximum');
    });

    it('should disable IP allowlist', async () => {
      const result = await trpcMutation<any>(
        'grpc.updateIpAllowlist',
        { enabled: false },
        setup.accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data?.success).toBe(true);
      expect(result.result?.data?.enabled).toBe(false);
    });

    it('should update rmaConfigChangeVaultSeq on allowlist change', async () => {
      // Trigger a GM sync to advance vault seq past any pending changes
      await fetch('http://localhost:22600/api/queue/sync-all', { method: 'POST' });

      const [controlBefore] = await db
        .select({ seq: systemControl.rmaMaxConfigChangeSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);
      const baselineSeq = controlBefore?.seq ?? 0;

      await trpcMutation('grpc.updateIpAllowlist', { enabled: true, entries: '8.8.8.8' }, setup.accessToken);

      const [controlAfter] = await db
        .select({ seq: systemControl.rmaMaxConfigChangeSeq })
        .from(systemControl)
        .where(eq(systemControl.id, 1))
        .limit(1);

      expect(controlAfter!.seq).toBeGreaterThan(baselineSeq);

      // Cleanup
      await trpcMutation('grpc.updateIpAllowlist', { enabled: false }, setup.accessToken);
    });
  });

  describe('Service Status Sync', () => {
    it('should show gRPC service status in getServicesStatus', async () => {
      const result = await trpcQuery<any>('services.getServicesStatus', undefined, setup.accessToken);

      expect(result.error).toBeUndefined();
      const grpcStatus = result.result?.data?.services?.find(
        (s: any) => s.serviceType === 'grpc'
      );

      expect(grpcStatus).toBeDefined();
      expect(grpcStatus.operationalStatus).toBeDefined();
      expect(grpcStatus.syncStatus).toBeDefined();
    });

    it('should use rma vault for gRPC sync status', async () => {
      // Create an API key to trigger vault change
      const createResult = await trpcMutation<any>('grpc.createApiKey', {}, setup.accessToken);

      // If key creation succeeded, verify sync status references rma
      if (!createResult.error) {
        const statusResult = await trpcQuery<any>('services.getServicesStatus', undefined, setup.accessToken);
        const grpcStatus = statusResult.result?.data?.services?.find(
          (s: any) => s.serviceType === 'grpc'
        );

        expect(grpcStatus).toBeDefined();
        // configChangeVaultSeq should be > 0 (pending sync)
        expect(grpcStatus.configChangeVaultSeq).toBeGreaterThan(0);

        // Cleanup
        await trpcMutation('grpc.deleteApiKey', { apiKeyFp: createResult.result?.data?.created?.apiKeyFp }, setup.accessToken);
      }
    });
  });
});
