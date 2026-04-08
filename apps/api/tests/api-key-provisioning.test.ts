/**
 * API Key Provisioning — Bug Reproduction Tests
 *
 * Bug 1: Existing customers (created before provisioning code, or after data reset)
 *         don't get service instances or API keys on re-login.
 *
 * Bug 2: seal.createApiKey has no platform subscription check — anyone authenticated
 *         can create API keys without paying (security flaw).
 *
 * These tests are written FIRST to reproduce the bugs, then fixes are applied.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@suiftly/database';
import { customers, serviceInstances, apiKeys } from '@suiftly/database/schema';
import { eq, and, isNull } from 'drizzle-orm';
import {
  resetTestData,
  resetClock,
  trpcMutation,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';
import { setupBillingTest } from './helpers/setup.js';

describe('API Key Provisioning', () => {
  let accessToken: string;
  let customerId: number;

  async function getCustomerId(): Promise<number> {
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) throw new Error('Test customer not found');
    return customer.customerId;
  }

  async function getServiceInstances(cid: number) {
    return db.query.serviceInstances.findMany({
      where: eq(serviceInstances.customerId, cid),
    });
  }

  async function getActiveApiKeys(cid: number) {
    return db.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.customerId, cid),
        isNull(apiKeys.deletedAt),
      ),
    });
  }

  describe('Service instance + API key auto-provisioning', () => {
    beforeEach(async () => {
      await resetClock();
      await resetTestData(TEST_WALLET);
    });

    it('login creates service instances and API keys for new customer', async () => {
      accessToken = await login(TEST_WALLET);
      customerId = await getCustomerId();

      const services = await getServiceInstances(customerId);
      const keys = await getActiveApiKeys(customerId);

      // Should have 3 service instances (seal, grpc, graphql) — all disabled
      expect(services).toHaveLength(3);
      const serviceTypes = services.map(s => s.serviceType).sort();
      expect(serviceTypes).toEqual(['graphql', 'grpc', 'seal']);
      for (const svc of services) {
        expect(svc.state).toBe('disabled');
        expect(svc.isUserEnabled).toBe(false);
      }

      // Should have 3 API keys (one per service)
      expect(keys).toHaveLength(3);
      const keyServiceTypes = keys.map(k => k.serviceType).sort();
      expect(keyServiceTypes).toEqual(['graphql', 'grpc', 'seal']);
    });

    it('re-login provisions services for existing customer missing them', async () => {
      // First login — creates customer + provisions
      accessToken = await login(TEST_WALLET);
      customerId = await getCustomerId();

      // Simulate "customer exists but services were deleted" (e.g., data reset)
      await db.delete(apiKeys).where(eq(apiKeys.customerId, customerId));
      await db.delete(serviceInstances).where(eq(serviceInstances.customerId, customerId));

      // Verify deletion
      expect(await getServiceInstances(customerId)).toHaveLength(0);
      expect(await getActiveApiKeys(customerId)).toHaveLength(0);

      // Re-login (customer already exists, isNewCustomer = false)
      await login(TEST_WALLET);

      // Should be re-provisioned
      const services = await getServiceInstances(customerId);
      const keys = await getActiveApiKeys(customerId);
      expect(services).toHaveLength(3);
      expect(keys).toHaveLength(3);
    });

    it('provisioning is idempotent on repeated login', async () => {
      accessToken = await login(TEST_WALLET);
      customerId = await getCustomerId();

      // Login again
      await login(TEST_WALLET);

      // Should still have exactly 3 of each (not 6)
      const services = await getServiceInstances(customerId);
      const keys = await getActiveApiKeys(customerId);
      expect(services).toHaveLength(3);
      expect(keys).toHaveLength(3);
    });
  });

  describe('Security: createApiKey requires platform subscription', () => {
    it('reject createApiKey without platform subscription', async () => {
      await resetClock();
      await resetTestData(TEST_WALLET);
      accessToken = await login(TEST_WALLET);

      // Customer has no platform subscription — createApiKey should be rejected
      const result = await trpcMutation<any>(
        'seal.createApiKey',
        {},
        accessToken
      );

      // Should fail with PRECONDITION_FAILED (platform subscription required)
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('Platform subscription required');
      expect(result.error.data?.code).toBe('PRECONDITION_FAILED');
    });

    it('allow createApiKey with paid platform subscription', async () => {
      // setupBillingTest creates customer with paid platform subscription
      const setup = await setupBillingTest();
      accessToken = setup.accessToken;
      customerId = setup.customerId;

      // Should succeed — customer has active platform subscription
      const result = await trpcMutation<any>(
        'seal.createApiKey',
        {},
        accessToken
      );

      expect(result.error).toBeUndefined();
      expect(result.result?.data).toBeDefined();
      expect(result.result?.data?.apiKey).toBeDefined();
      expect(typeof result.result?.data?.apiKey).toBe('string');
    });
  });
});
