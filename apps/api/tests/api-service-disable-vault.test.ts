/**
 * Test: Service disable should trigger vault update
 *
 * When a service is disabled, the vault should be regenerated to remove
 * the customer from the active configuration.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, systemControl, serviceInstances, customers } from '@suiftly/database';
import { eq, and } from 'drizzle-orm';
import { SERVICE_TYPE } from '@suiftly/shared/constants';
import {
  resetTestData,
  ensureTestBalance,
  subscribeAndEnable,
  trpcMutation,
} from './helpers/http';
import { login, TEST_WALLET } from './helpers/auth';

describe('Service disable triggers vault update', () => {
  let accessToken: string;
  let customerId: number;

  beforeAll(async () => {
    // Reset test customer and login
    await resetTestData();
    accessToken = await login();

    // Get customer ID
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    customerId = customer!.customerId;

    // Add escrow balance for subscription
    await ensureTestBalance(1000, { spendingLimitUsd: 250 });
  });

  afterAll(async () => {
    await resetTestData();
  });

  it('should increment vault seq when service is disabled', async () => {
    // Step 1: Subscribe and enable
    await subscribeAndEnable('seal', 'pro', accessToken);

    // Step 2: Create a seal key
    const createKeyResult = await trpcMutation<{ sealKeyId: number }>(
      'seal.createKey',
      {},
      accessToken
    );
    expect(createKeyResult.error).toBeUndefined();
    const sealKeyId = createKeyResult.result?.data?.sealKeyId;
    expect(sealKeyId).toBeDefined();

    // Step 3: Add a package to the seal key (this triggers cpEnabled=true)
    const addPackageResult = await trpcMutation<any>(
      'seal.addPackage',
      {
        sealKeyId,
        packageAddress: '0x' + '1'.repeat(64),
        name: 'Test Package',
      },
      accessToken
    );
    expect(addPackageResult.error).toBeUndefined();

    // Verify cpEnabled is now true
    const service = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });
    expect(service?.cpEnabled).toBe(true);
    console.log('cpEnabled after adding package:', service?.cpEnabled);

    // Step 4: Record current vault seq
    const [control] = await db.select().from(systemControl).where(eq(systemControl.id, 1));
    const initialVaultSeq = control?.smaVaultSeq ?? 0;
    console.log('Vault seq after enabling and adding package:', initialVaultSeq);

    // Step 5: Disable the service
    const disableResult = await trpcMutation<any>(
      'services.toggleService',
      { serviceType: 'seal', enabled: false },
      accessToken
    );
    expect(disableResult.error).toBeUndefined();
    console.log('Disable result:', disableResult.result?.data);

    // Step 6: Wait for vault sync to complete (poll until seq changes or timeout)
    // The API triggers an async vault sync via GM, so we need to wait
    const maxWaitMs = 10000;
    const pollIntervalMs = 200;
    const startTime = Date.now();
    let newVaultSeq = initialVaultSeq;

    while (Date.now() - startTime < maxWaitMs) {
      const [controlAfter] = await db.select().from(systemControl).where(eq(systemControl.id, 1));
      newVaultSeq = controlAfter?.smaVaultSeq ?? 0;

      if (newVaultSeq > initialVaultSeq) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    console.log('Vault seq after disabling (waited', Date.now() - startTime, 'ms):', newVaultSeq);

    // The vault seq should have incremented because the customer's config changed
    expect(newVaultSeq).toBeGreaterThan(initialVaultSeq);

    // cpEnabled stays true once set (user said: "cpEnabled remains enabled once set")
    // The vault encodes isUserEnabled=false so HAProxy knows to drop traffic
    const serviceAfter = await db.query.serviceInstances.findFirst({
      where: and(
        eq(serviceInstances.customerId, customerId),
        eq(serviceInstances.serviceType, SERVICE_TYPE.SEAL)
      ),
    });
    expect(serviceAfter?.cpEnabled).toBe(true); // cpEnabled stays true
    expect(serviceAfter?.isUserEnabled).toBe(false); // isUserEnabled is false (disabled)
  });
});
