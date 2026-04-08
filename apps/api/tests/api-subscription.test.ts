/**
 * API Test: Subscription Flow
 *
 * Tests service subscription lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * Platform is the only subscription ($2/$39 Starter/Pro).
 * Seal/gRPC/GraphQL are auto-provisioned (free features) when platform is subscribed.
 * Their tier is null — derived from the platform tier at runtime.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  trpcQuery,
  resetTestData,
} from './helpers/http.js';
import { TEST_WALLET } from './helpers/auth.js';
import { expectNoNotifications } from './helpers/notifications.js';
import { setupBillingTest } from './helpers/setup.js';

describe('API: Subscription Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Platform subscribed at starter tier; seal/grpc/graphql auto-provisioned (disabled)
    ({ accessToken, customerId } = await setupBillingTest());
  });

  afterEach(async () => {
    await resetClock();
    await resetTestData(TEST_WALLET);
  });

  describe('Auto-Provisioned Services', () => {
    it('should auto-provision seal, grpc, and graphql after platform subscribe', async () => {
      const services = await db.query.serviceInstances.findMany({
        where: eq(serviceInstances.customerId, customerId),
      });
      // seal, grpc, graphql are all auto-provisioned (no platform service instance)
      expect(services.length).toBe(3);
      for (const s of services) {
        expect(s.state).toBe('disabled'); // starts disabled, user enables manually
      }
    });

    it('should return auto-provisioned service on subscribe (no payment required)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Seal is already auto-provisioned; subscribe returns existing service
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.serviceType).toBe('seal');
      expect(result.result?.data.paymentPending).toBe(false);
      expect(result.result?.data.apiKey).toBeNull(); // already created at auto-provisioning

      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();

      await expectNoNotifications(customerId);
    });

    it('should start in disabled state (requires manual enable)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Auto-provisioned seal is disabled by default
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();
      expect(service?.state).toBe('disabled');
      expect(service?.isUserEnabled).toBe(false);

      // Enable via toggleService
      const enableResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );
      expect(enableResult.result?.data?.isUserEnabled).toBe(true);
      expect(enableResult.result?.data?.state).toBe('enabled');

      // Verify state in database
      const enabledService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(enabledService?.state).toBe('enabled');
      expect(enabledService?.isUserEnabled).toBe(true);

      await expectNoNotifications(customerId);
    });

    it('should be idempotent on duplicate subscribe calls', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      const first = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal' },
        accessToken
      );
      expect(first.result?.data?.paymentPending).toBe(false);

      const second = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal' },
        accessToken
      );
      expect(second.result?.data?.paymentPending).toBe(false);
      // API key not re-returned (already exists from auto-provisioning)
      expect(second.result?.data?.apiKey).toBeNull();

      await expectNoNotifications(customerId);
    });
  });

  describe('List Services', () => {
    it('should list all auto-provisioned services', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      const listResult = await trpcQuery<any>(
        'services.list',
        {},
        accessToken
      );

      expect(listResult.result?.data).toBeDefined();
      expect(Array.isArray(listResult.result?.data)).toBe(true);
      // platform + seal + grpc + graphql = 4 total
      const nonPlatform = listResult.result?.data.filter((s: any) => s.serviceType !== 'platform');
      expect(nonPlatform.length).toBe(3);
      const serviceTypes = nonPlatform.map((s: any) => s.serviceType).sort();
      expect(serviceTypes).toEqual(['graphql', 'grpc', 'seal']);

      await expectNoNotifications(customerId);
    });
  });

  describe('Get Service by Type', () => {
    it('should get auto-provisioned seal service', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      const result = await trpcQuery<any>(
        'services.getByType',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.serviceType).toBe('seal');
      // tier is no longer on service instances — derived from platform at runtime

      await expectNoNotifications(customerId);
    });
  });

  describe('Toggle Service', () => {
    it('should enable and disable service', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Enable seal (auto-provisioned, starts disabled)
      const enableResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );
      expect(enableResult.result?.data?.isUserEnabled).toBe(true);
      expect(enableResult.result?.data?.state).toBe('enabled');

      // Verify state in DB
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service?.isUserEnabled).toBe(true);
      expect(service?.state).toBe('enabled');

      // Disable service
      const disableResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: false },
        accessToken
      );
      expect(disableResult.result?.data).toBeDefined();
      expect(disableResult.result?.data.isUserEnabled).toBe(false);
      expect(disableResult.result?.data.state).toBe('disabled');

      // Re-enable service
      const reEnableResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );
      expect(reEnableResult.result?.data).toBeDefined();
      expect(reEnableResult.result?.data.isUserEnabled).toBe(true);
      expect(reEnableResult.result?.data.state).toBe('enabled');

      await expectNoNotifications(customerId);
    });
  });

  describe('Update Config', () => {
    it('should update burst setting when platform is pro tier', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Upgrade platform to pro (burst is pro-tier feature based on platform tier)
      await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );

      // Update burst setting for seal
      const updateResult = await trpcMutation<any>(
        'services.updateConfig',
        { serviceType: 'seal', burstEnabled: true },
        accessToken
      );

      expect(updateResult.result?.data).toBeDefined();
      expect(updateResult.result?.data.config.burstEnabled).toBe(true);

      await expectNoNotifications(customerId);
    });

    it('should reject burst when platform is starter tier', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Platform is at starter (from setupBillingTest) — burst not allowed
      const updateResult = await trpcMutation<any>(
        'services.updateConfig',
        { serviceType: 'seal', burstEnabled: true },
        accessToken
      );

      expect(updateResult.error).toBeDefined();
      expect(updateResult.error?.message).toContain('only available for Pro');

      await expectNoNotifications(customerId);
    });
  });

  describe('Can Provision Check', () => {
    it('should reject provisioning for already auto-provisioned services', async () => {
      // Seal/grpc/graphql are auto-provisioned after platform subscribe
      const result = await trpcQuery<any>(
        'services.canProvision',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.allowed).toBe(false);
      expect(result.result?.data.reason).toBe('already_subscribed');

      await expectNoNotifications(customerId);
    });
  });
});
