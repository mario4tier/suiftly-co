/**
 * Seal Package Auto-Naming Tests
 *
 * Tests the auto-naming logic for packages when no name is provided:
 * - Finds all existing package names ending with -N suffix
 * - Uses the greatest N + 1 for the new package name
 * - Names new packages as "package-{N}"
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { randomBytes, randomInt } from 'crypto';
import {
  db,
  customers,
  serviceInstances,
  sealKeys,
  sealPackages,
} from '@suiftly/database';
import { eq } from 'drizzle-orm';

// ============================================================================
// Test Data Helpers
// ============================================================================

interface TestCustomer {
  customerId: number;
  walletAddress: string;
}

interface TestServiceInstance {
  instanceId: number;
  customerId: number;
}

interface TestSealKey {
  sealKeyId: number;
  customerId: number;
  instanceId: number;
}

const testCustomers: TestCustomer[] = [];
const testServiceInstances: TestServiceInstance[] = [];
const testSealKeys: TestSealKey[] = [];
const testPackageIds: number[] = [];

async function createTestCustomer(): Promise<TestCustomer> {
  const MAX_RETRIES = 10;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const customerId = randomInt(100000, 2147483647);
    const walletAddress = '0x' + randomBytes(32).toString('hex');

    try {
      await db.insert(customers).values({
        customerId,
        walletAddress,
        status: 'active',
        spendingLimitUsdCents: 25000,
        currentBalanceUsdCents: 10000,
        currentPeriodChargedUsdCents: 0,
        currentPeriodStart: new Date().toISOString().split('T')[0],
      });

      const customer = { customerId, walletAddress };
      testCustomers.push(customer);
      return customer;
    } catch (error: any) {
      if (error.code === '23505' && error.constraint === 'customers_pkey') {
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to create test customer after max retries');
}

async function createTestServiceInstance(
  customerId: number
): Promise<TestServiceInstance> {
  const [instance] = await db
    .insert(serviceInstances)
    .values({
      customerId,
      serviceType: 'seal',
      state: 'enabled',
      tier: 'starter',
      isUserEnabled: true,
      paidOnce: true,
      config: { totalSealKeys: 5 },
    })
    .returning();

  const testInstance = { instanceId: instance.instanceId, customerId };
  testServiceInstances.push(testInstance);
  return testInstance;
}

async function createTestSealKey(
  customerId: number,
  instanceId: number
): Promise<TestSealKey> {
  const derivationIndex = randomInt(1000000, 2147483647);

  const [key] = await db
    .insert(sealKeys)
    .values({
      customerId,
      instanceId,
      derivationIndex,
      processGroup: 1,
      publicKey: randomBytes(48),
      isUserEnabled: true,
      registrationStatus: 'registered',
      objectId: randomBytes(32),
    })
    .returning();

  const testKey = { sealKeyId: key.sealKeyId, customerId, instanceId };
  testSealKeys.push(testKey);
  return testKey;
}

/**
 * Add a package with optional name (mirrors the API logic)
 */
async function addPackage(
  sealKeyId: number,
  packageAddress: string,
  name?: string
): Promise<{ packageId: number; name: string }> {
  // Get all packages for this seal key (including disabled) for name generation
  const existingPackages = await db.query.sealPackages.findMany({
    where: eq(sealPackages.sealKeyId, sealKeyId),
    columns: { name: true },
  });

  // Auto-generate name if not provided
  let packageName = name;
  if (!packageName) {
    // Find all existing package names ending with -N suffix
    const existingNames = existingPackages
      .map((p) => p.name)
      .filter((n): n is string => !!n);

    // Extract numbers from names ending with -N and find the highest
    const numbers: number[] = [];
    for (const existingName of existingNames) {
      const match = existingName.match(/-(\d+)$/);
      if (match) {
        numbers.push(parseInt(match[1], 10));
      }
    }
    const nextNumber = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    packageName = `package-${nextNumber}`;
  }

  // Create the package
  const addressBuffer = Buffer.from(packageAddress.slice(2), 'hex');
  const [newPackage] = await db
    .insert(sealPackages)
    .values({
      sealKeyId,
      packageAddress: addressBuffer,
      name: packageName,
    })
    .returning();

  testPackageIds.push(newPackage.packageId);
  return { packageId: newPackage.packageId, name: packageName };
}

/**
 * Disable a package (soft delete)
 */
async function disablePackage(packageId: number): Promise<void> {
  await db
    .update(sealPackages)
    .set({ isUserEnabled: false })
    .where(eq(sealPackages.packageId, packageId));
}

async function cleanupTestData(): Promise<void> {
  // Clean up packages first (FK constraint)
  for (const packageId of testPackageIds) {
    await db.delete(sealPackages).where(eq(sealPackages.packageId, packageId));
  }
  testPackageIds.length = 0;

  // Clean up seal keys
  for (const key of testSealKeys) {
    await db.delete(sealKeys).where(eq(sealKeys.sealKeyId, key.sealKeyId));
  }
  testSealKeys.length = 0;

  // Clean up service instances
  for (const instance of testServiceInstances) {
    await db
      .delete(serviceInstances)
      .where(eq(serviceInstances.instanceId, instance.instanceId));
  }
  testServiceInstances.length = 0;

  // Clean up customers
  for (const customer of testCustomers) {
    await db
      .delete(customers)
      .where(eq(customers.customerId, customer.customerId));
  }
  testCustomers.length = 0;
}

// ============================================================================
// Tests
// ============================================================================

describe('Seal Package Auto-Naming', () => {
  afterAll(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  describe('Basic auto-naming', () => {
    it('should name first package as package-1', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      const result = await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64));
      expect(result.name).toBe('package-1');
    });

    it('should name second package as package-2', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64));
      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '2'.repeat(64)
      );
      expect(result.name).toBe('package-2');
    });

    it('should name sequential packages correctly', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      const pkg1 = await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64));
      const pkg2 = await addPackage(sealKey.sealKeyId, '0x' + '2'.repeat(64));
      const pkg3 = await addPackage(sealKey.sealKeyId, '0x' + '3'.repeat(64));

      expect(pkg1.name).toBe('package-1');
      expect(pkg2.name).toBe('package-2');
      expect(pkg3.name).toBe('package-3');
    });

    it('should consider disabled packages when generating names', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // Create package-1 and disable it
      const pkg1 = await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64));
      expect(pkg1.name).toBe('package-1');
      await disablePackage(pkg1.packageId);

      // Next package should be package-2, not package-1 (disabled packages count)
      const pkg2 = await addPackage(sealKey.sealKeyId, '0x' + '2'.repeat(64));
      expect(pkg2.name).toBe('package-2');
    });
  });

  describe('Cross-prefix suffix detection', () => {
    it('should find highest -N suffix across different prefixes', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // Add packages with different prefixes but -N suffixes
      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64), 'mypackage-3');
      await addPackage(sealKey.sealKeyId, '0x' + '2'.repeat(64), 'foo-7');
      await addPackage(sealKey.sealKeyId, '0x' + '3'.repeat(64), 'bar-2');

      // Next auto-named package should be package-8 (7 + 1)
      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '4'.repeat(64)
      );
      expect(result.name).toBe('package-8');
    });

    it('should handle mix of suffixed and non-suffixed names', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // Add packages with and without -N suffixes
      await addPackage(
        sealKey.sealKeyId,
        '0x' + '1'.repeat(64),
        'production-main'
      ); // No -N suffix
      await addPackage(sealKey.sealKeyId, '0x' + '2'.repeat(64), 'staging'); // No -N suffix
      await addPackage(sealKey.sealKeyId, '0x' + '3'.repeat(64), 'test-5'); // Has -5

      // Next auto-named package should be package-6 (5 + 1)
      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '4'.repeat(64)
      );
      expect(result.name).toBe('package-6');
    });

    it('should handle only non-suffixed names (start at 1)', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // Add packages without -N suffixes
      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64), 'main');
      await addPackage(sealKey.sealKeyId, '0x' + '2'.repeat(64), 'staging');

      // Next auto-named package should be package-1 (no -N suffixes found)
      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '3'.repeat(64)
      );
      expect(result.name).toBe('package-1');
    });
  });

  describe('Edge cases', () => {
    it('should handle large suffix numbers', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64), 'test-999');

      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '2'.repeat(64)
      );
      expect(result.name).toBe('package-1000');
    });

    it('should handle suffix 0', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64), 'test-0');

      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '2'.repeat(64)
      );
      expect(result.name).toBe('package-1');
    });

    it('should ignore names ending with non-numeric suffix', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // These should NOT be counted as -N suffixes
      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64), 'test-abc');
      await addPackage(sealKey.sealKeyId, '0x' + '2'.repeat(64), 'foo-bar');
      await addPackage(sealKey.sealKeyId, '0x' + '3'.repeat(64), 'baz-');

      // Next auto-named package should be package-1 (no valid -N suffixes)
      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '4'.repeat(64)
      );
      expect(result.name).toBe('package-1');
    });

    it('should handle names with multiple dashes', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // Only the last -N suffix should be counted
      await addPackage(
        sealKey.sealKeyId,
        '0x' + '1'.repeat(64),
        'my-custom-package-10'
      );
      await addPackage(
        sealKey.sealKeyId,
        '0x' + '2'.repeat(64),
        'another-test-5'
      );

      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '3'.repeat(64)
      );
      expect(result.name).toBe('package-11');
    });

    it('should use custom name when provided', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64));

      // Explicitly provided name should be used
      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '2'.repeat(64),
        'my-custom-name'
      );
      expect(result.name).toBe('my-custom-name');
    });

    it('should handle leading zeros in suffix', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);
      const sealKey = await createTestSealKey(
        customer.customerId,
        service.instanceId
      );

      // parseInt handles leading zeros correctly (treats as decimal)
      await addPackage(sealKey.sealKeyId, '0x' + '1'.repeat(64), 'test-007');

      const result = await addPackage(
        sealKey.sealKeyId,
        '0x' + '2'.repeat(64)
      );
      expect(result.name).toBe('package-8'); // 7 + 1
    });
  });
});
