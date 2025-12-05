/**
 * API Test: Subscription Flow
 *
 * Tests service subscription lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * This test simulates realistic client behavior by:
 * 1. Making HTTP calls to tRPC endpoints (services.subscribe, services.list, etc.)
 * 2. Controlling time via /test/clock/* endpoints
 * 3. Reading DB directly for assertions (read-only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers, billingRecords } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcMutation,
  trpcQuery,
  resetTestData,
  subscribeAndEnable,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

describe('API: Subscription Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset clock to real time first
    await resetClock();

    // Reset test customer data via HTTP (like E2E tests do)
    await resetTestData(TEST_WALLET);

    // Login FIRST - this creates the customer with production defaults
    accessToken = await login(TEST_WALLET);

    // Get customer ID for DB assertions
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;

    // THEN ensure balance (after customer exists)
    await ensureTestBalance(100, { walletAddress: TEST_WALLET });
  });

  afterEach(async () => {
    // Reset clock
    await resetClock();
    // Clean up via HTTP
    await resetTestData(TEST_WALLET);
  });

  describe('Subscribe to Service', () => {
    it('should subscribe to a service with payment', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Should return service data
      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.serviceType).toBe('seal');
      expect(result.result?.data.tier).toBe('starter');

      // Should include API key for new subscription
      expect(result.result?.data.apiKey).toBeDefined();

      // Verify in database
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();
      expect(service?.tier).toBe('starter');
    });

    it('should start in disabled state by default (requires manual enable)', async () => {
      /**
       * Business rule: New subscriptions start DISABLED.
       * User must explicitly enable the service via toggleService.
       *
       * This ensures:
       * - User confirms they want to start using (and being billed for) the service
       * - Prevents accidental traffic through a service they just subscribed to
       * - Gives user time to configure API keys, IP allowlists, etc. before enabling
       */
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe to service (payment succeeds)
      const result = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.paymentPending).toBe(false); // Payment succeeded

      // Verify service starts in DISABLED state (not auto-enabled)
      const service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(service).toBeDefined();
      expect(service?.state).toBe('disabled'); // NOT 'enabled'
      expect(service?.isUserEnabled).toBe(false); // User has not enabled yet

      // Now manually enable the service
      const enableResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );
      expect(enableResult.result?.data?.isUserEnabled).toBe(true);
      expect(enableResult.result?.data?.state).toBe('enabled');

      // Verify state changed in database
      const enabledService = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      expect(enabledService?.state).toBe('enabled');
      expect(enabledService?.isUserEnabled).toBe(true);
    });

    it('should return existing instance on duplicate subscription (idempotent)', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // First subscription should succeed
      const first = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(first.result?.data).toBeDefined();
      expect(first.result?.data.tier).toBe('starter');

      // Second subscription should return existing instance (idempotent behavior)
      // Note: Even though 'pro' tier is requested, the existing 'starter' is returned
      const second = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );
      expect(second.result?.data).toBeDefined();
      expect(second.result?.data.tier).toBe('starter'); // Original tier preserved
      expect(second.result?.data.apiKey).toBeNull(); // API key not returned again
    });

    it('should subscribe to different services independently', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe to seal
      const sealResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );
      expect(sealResult.result?.data).toBeDefined();

      // Subscribe to grpc
      const grpcResult = await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'grpc', tier: 'pro' },
        accessToken
      );
      expect(grpcResult.result?.data).toBeDefined();

      // Verify both exist
      const services = await db.query.serviceInstances.findMany({
        where: eq(serviceInstances.customerId, customerId),
      });
      expect(services.length).toBe(2);

      const sealService = services.find(s => s.serviceType === 'seal');
      const grpcService = services.find(s => s.serviceType === 'grpc');
      expect(sealService?.tier).toBe('starter');
      expect(grpcService?.tier).toBe('pro');
    });
  });

  describe('List Services', () => {
    it('should list all services for user', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe to a service first
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // List services
      const listResult = await trpcQuery<any>(
        'services.list',
        {},
        accessToken
      );

      expect(listResult.result?.data).toBeDefined();
      expect(Array.isArray(listResult.result?.data)).toBe(true);
      expect(listResult.result?.data.length).toBe(1);
      expect(listResult.result?.data[0].serviceType).toBe('seal');
    });

    it('should return empty list when no services', async () => {
      const listResult = await trpcQuery<any>(
        'services.list',
        {},
        accessToken
      );

      expect(listResult.result?.data).toBeDefined();
      expect(Array.isArray(listResult.result?.data)).toBe(true);
      expect(listResult.result?.data.length).toBe(0);
    });
  });

  describe('Get Service by Type', () => {
    it('should get service by type', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe first
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );

      // Get by type
      const result = await trpcQuery<any>(
        'services.getByType',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.serviceType).toBe('seal');
      expect(result.result?.data.tier).toBe('pro');
    });

    it('should return null for non-existent service', async () => {
      const result = await trpcQuery<any>(
        'services.getByType',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeNull();
    });
  });

  describe('Toggle Service', () => {
    it('should enable and disable service', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe and enable (this handles payment and toggle to enabled)
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Verify enabled state
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
      const enableResult = await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );
      expect(enableResult.result?.data).toBeDefined();
      expect(enableResult.result?.data.isUserEnabled).toBe(true);
      expect(enableResult.result?.data.state).toBe('enabled');
    });
  });

  describe('Update Config', () => {
    it('should update burst setting for pro tier', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe to pro tier (which supports burst)
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );

      // Update burst setting
      const updateResult = await trpcMutation<any>(
        'services.updateConfig',
        { serviceType: 'seal', burstEnabled: true },
        accessToken
      );

      expect(updateResult.result?.data).toBeDefined();
      expect(updateResult.result?.data.config.burstEnabled).toBe(true);
    });

    it('should reject burst for starter tier', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe to starter tier
      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Try to enable burst (should fail)
      const updateResult = await trpcMutation<any>(
        'services.updateConfig',
        { serviceType: 'seal', burstEnabled: true },
        accessToken
      );

      expect(updateResult.error).toBeDefined();
      expect(updateResult.error?.message).toContain('only available for Pro');
    });
  });

  describe('Can Provision Check', () => {
    it('should allow provisioning when no subscription exists', async () => {
      const result = await trpcQuery<any>(
        'services.canProvision',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.allowed).toBe(true);
    });

    it('should reject provisioning when already subscribed', async () => {
      await setClockTime('2025-01-05T00:00:00Z');

      // Subscribe and enable
      await subscribeAndEnable('seal', 'starter', accessToken);

      // Check canProvision
      const result = await trpcQuery<any>(
        'services.canProvision',
        { serviceType: 'seal' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.allowed).toBe(false);
      expect(result.result?.data.reason).toBe('already_subscribed');
    });
  });
});
