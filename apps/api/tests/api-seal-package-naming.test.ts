/**
 * Integration Test: Seal Package Auto-Naming
 *
 * Tests that the API correctly generates package names, including when
 * disabled packages exist (they should still be considered for naming).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, sealPackages } from '@suiftly/database';
import { eq } from 'drizzle-orm';
import {
  resetTestData,
  ensureTestBalance,
  subscribeAndEnable,
  trpcMutation,
} from './helpers/http';
import { login } from './helpers/auth';

describe('Seal Package Auto-Naming (Integration)', () => {
  let accessToken: string;

  beforeAll(async () => {
    // Reset test customer and login
    await resetTestData();
    accessToken = await login();

    // Add escrow balance for subscription
    await ensureTestBalance(1000, { spendingLimitUsd: 250 });

    // Subscribe and enable seal service
    await subscribeAndEnable('seal', 'pro', accessToken);
  });

  afterAll(async () => {
    await resetTestData();
  });

  it('should consider disabled packages when generating names', async () => {
    // Step 1: Create a seal key
    const createKeyResult = await trpcMutation<{ sealKeyId: number }>(
      'seal.createKey',
      {},
      accessToken
    );
    expect(createKeyResult.error).toBeUndefined();
    const sealKeyId = createKeyResult.result?.data?.sealKeyId;
    expect(sealKeyId).toBeDefined();

    // Step 2: Add first package (no name - should auto-generate as package-1)
    const pkg1Result = await trpcMutation<{ packageId: number; name: string }>(
      'seal.addPackage',
      {
        sealKeyId,
        packageAddress: '0x' + '1'.repeat(64),
        // No name provided - should auto-generate
      },
      accessToken
    );
    expect(pkg1Result.error).toBeUndefined();
    const pkg1 = pkg1Result.result?.data;
    expect(pkg1?.name).toBe('package-1');
    console.log('Package 1 created:', pkg1);

    // Step 3: Disable package-1
    const disableResult = await trpcMutation<{ success: boolean }>(
      'seal.togglePackage',
      {
        packageId: pkg1!.packageId,
        enabled: false,
      },
      accessToken
    );
    expect(disableResult.error).toBeUndefined();
    console.log('Package 1 disabled');

    // Verify package is disabled in DB
    const disabledPkg = await db.query.sealPackages.findFirst({
      where: eq(sealPackages.packageId, pkg1!.packageId),
    });
    expect(disabledPkg?.isUserEnabled).toBe(false);

    // Step 4: Add second package (no name - should auto-generate as package-2)
    // BUG: If disabled packages are not considered, this will be package-1
    const pkg2Result = await trpcMutation<{ packageId: number; name: string }>(
      'seal.addPackage',
      {
        sealKeyId,
        packageAddress: '0x' + '2'.repeat(64),
        // No name provided - should auto-generate
      },
      accessToken
    );
    expect(pkg2Result.error).toBeUndefined();
    const pkg2 = pkg2Result.result?.data;
    console.log('Package 2 created:', pkg2);

    // This is the key assertion - should be package-2, not package-1
    expect(pkg2?.name).toBe('package-2');
  });
});
