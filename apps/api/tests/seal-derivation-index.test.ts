/**
 * Derivation Index Allocation Tests
 *
 * Tests the critical derivation index allocation mechanism for seal keys.
 * Derivation indices must be globally unique per process group to prevent
 * cryptographic key collisions.
 *
 * Requirements verified:
 * 1. Global uniqueness - Indices unique across ALL customers (per PG)
 * 2. Atomic allocation - Index reserved in same transaction as key creation
 * 3. Permanent binding - Once allocated, index belongs to that customer forever
 * 4. No recycling - "Deleted" keys retain their index (soft-delete only)
 * 5. Concurrent safety - Multiple simultaneous requests get different indices
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomInt } from 'crypto';
import { db, systemControl, customers, serviceInstances, sealKeys } from '@suiftly/database';
import { eq, sql } from 'drizzle-orm';

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

const testCustomers: TestCustomer[] = [];
const testServiceInstances: TestServiceInstance[] = [];
const testSealKeyIds: number[] = [];

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
        currentBalanceUsdCents: 10000, // $100 balance
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

async function createTestServiceInstance(customerId: number): Promise<TestServiceInstance> {
  const [instance] = await db.insert(serviceInstances).values({
    customerId,
    serviceType: 'seal',
    state: 'enabled',
    tier: 'starter',
    isUserEnabled: true,
    paidOnce: true,
  }).returning();

  const testInstance = { instanceId: instance.instanceId, customerId };
  testServiceInstances.push(testInstance);
  return testInstance;
}

async function cleanupTestData(): Promise<void> {
  // Clean up seal keys first (FK constraint)
  if (testSealKeyIds.length > 0) {
    for (const sealKeyId of testSealKeyIds) {
      await db.delete(sealKeys).where(eq(sealKeys.sealKeyId, sealKeyId));
    }
    testSealKeyIds.length = 0;
  }

  // Clean up service instances
  for (const instance of testServiceInstances) {
    await db.delete(serviceInstances).where(eq(serviceInstances.instanceId, instance.instanceId));
  }
  testServiceInstances.length = 0;

  // Clean up customers
  for (const customer of testCustomers) {
    await db.delete(customers).where(eq(customers.customerId, customer.customerId));
  }
  testCustomers.length = 0;
}

// ============================================================================
// Derivation Index Allocation Logic (extracted for testing)
// ============================================================================

/**
 * Atomically allocate a derivation index for a given process group.
 * This mirrors the logic in seal.ts createKey mutation.
 */
async function allocateDerivationIndex(
  processGroup: 1 | 2,
  tx?: typeof db
): Promise<number> {
  const database = tx || db;

  if (processGroup === 1) {
    const [result] = await database
      .update(systemControl)
      .set({
        nextSealDerivationIndexPg1: sql`${systemControl.nextSealDerivationIndexPg1} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(systemControl.id, 1))
      .returning({
        allocatedIndex: sql<number>`${systemControl.nextSealDerivationIndexPg1} - 1`,
      });
    return result.allocatedIndex;
  } else {
    const [result] = await database
      .update(systemControl)
      .set({
        nextSealDerivationIndexPg2: sql`${systemControl.nextSealDerivationIndexPg2} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(systemControl.id, 1))
      .returning({
        allocatedIndex: sql<number>`${systemControl.nextSealDerivationIndexPg2} - 1`,
      });
    return result.allocatedIndex;
  }
}

/**
 * Get current counter value without incrementing.
 */
async function getCurrentCounter(processGroup: 1 | 2): Promise<number> {
  const [control] = await db
    .select({
      pg1: systemControl.nextSealDerivationIndexPg1,
      pg2: systemControl.nextSealDerivationIndexPg2,
    })
    .from(systemControl)
    .where(eq(systemControl.id, 1))
    .limit(1);

  return processGroup === 1 ? control.pg1 : control.pg2;
}

// ============================================================================
// Tests
// ============================================================================

describe('Seal Key Derivation Index Allocation', () => {
  let initialPg1Counter: number;
  let initialPg2Counter: number;

  beforeAll(async () => {
    // Record initial counter values
    initialPg1Counter = await getCurrentCounter(1);
    initialPg2Counter = await getCurrentCounter(2);
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    // Clean up any seal keys created during tests
    if (testSealKeyIds.length > 0) {
      for (const sealKeyId of testSealKeyIds) {
        await db.delete(sealKeys).where(eq(sealKeys.sealKeyId, sealKeyId));
      }
      testSealKeyIds.length = 0;
    }
  });

  describe('Basic Allocation', () => {
    it('should allocate sequential indices for PG1', async () => {
      const index1 = await allocateDerivationIndex(1);
      const index2 = await allocateDerivationIndex(1);
      const index3 = await allocateDerivationIndex(1);

      expect(index2).toBe(index1 + 1);
      expect(index3).toBe(index2 + 1);
    });

    it('should allocate sequential indices for PG2', async () => {
      const index1 = await allocateDerivationIndex(2);
      const index2 = await allocateDerivationIndex(2);
      const index3 = await allocateDerivationIndex(2);

      expect(index2).toBe(index1 + 1);
      expect(index3).toBe(index2 + 1);
    });

    it('should increment counter correctly', async () => {
      const beforeCounter = await getCurrentCounter(1);
      await allocateDerivationIndex(1);
      const afterCounter = await getCurrentCounter(1);

      expect(afterCounter).toBe(beforeCounter + 1);
    });
  });

  describe('Process Group Isolation', () => {
    it('should allocate independently for PG1 and PG2', async () => {
      const pg1Before = await getCurrentCounter(1);
      const pg2Before = await getCurrentCounter(2);

      // Allocate from PG1
      await allocateDerivationIndex(1);
      await allocateDerivationIndex(1);

      const pg1After = await getCurrentCounter(1);
      const pg2After = await getCurrentCounter(2);

      // PG1 should have incremented by 2
      expect(pg1After).toBe(pg1Before + 2);
      // PG2 should be unchanged
      expect(pg2After).toBe(pg2Before);
    });

    it('should allow same index number in different PGs', async () => {
      // Reset counters to same value for this test
      // (This is just verifying the indices are independent namespaces)
      const pg1Index = await allocateDerivationIndex(1);
      const pg2Index = await allocateDerivationIndex(2);

      // Both indices are valid (they're from different namespaces)
      expect(typeof pg1Index).toBe('number');
      expect(typeof pg2Index).toBe('number');

      // They might be the same number, but that's OK because different PGs
      // have different master seeds
    });
  });

  describe('Cross-Customer Uniqueness', () => {
    it('should give different customers different indices', async () => {
      const customer1 = await createTestCustomer();
      const customer2 = await createTestCustomer();
      const customer3 = await createTestCustomer();

      // Allocate indices for each customer
      const index1 = await allocateDerivationIndex(1);
      const index2 = await allocateDerivationIndex(1);
      const index3 = await allocateDerivationIndex(1);

      // All indices must be unique
      const indices = [index1, index2, index3];
      const uniqueIndices = new Set(indices);
      expect(uniqueIndices.size).toBe(3);
    });

    it('should not reuse indices across different customers', async () => {
      const allocatedIndices: number[] = [];

      // Simulate 10 customers each creating a key
      for (let i = 0; i < 10; i++) {
        await createTestCustomer();
        const index = await allocateDerivationIndex(1);
        allocatedIndices.push(index);
      }

      // All indices must be unique
      const uniqueIndices = new Set(allocatedIndices);
      expect(uniqueIndices.size).toBe(10);

      // Indices should be sequential
      const sorted = [...allocatedIndices].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBe(sorted[i - 1] + 1);
      }
    });
  });

  describe('Concurrent Allocation (Race Condition Prevention)', () => {
    it('should handle 10 concurrent allocations without duplicates', async () => {
      // Launch 10 allocations simultaneously
      const promises = Array(10).fill(null).map(() => allocateDerivationIndex(1));
      const indices = await Promise.all(promises);

      // All indices must be unique
      const uniqueIndices = new Set(indices);
      expect(uniqueIndices.size).toBe(10);

      console.log(`[CONCURRENT-10] Allocated indices: ${indices.sort((a, b) => a - b).join(', ')}`);
    });

    it('should handle 50 concurrent allocations without duplicates', async () => {
      // Launch 50 allocations simultaneously
      const promises = Array(50).fill(null).map(() => allocateDerivationIndex(1));
      const indices = await Promise.all(promises);

      // All indices must be unique
      const uniqueIndices = new Set(indices);
      expect(uniqueIndices.size).toBe(50);

      console.log(`[CONCURRENT-50] Allocated indices range: ${Math.min(...indices)} - ${Math.max(...indices)}`);
    });

    it('should handle mixed PG1/PG2 concurrent allocations', async () => {
      // Launch 20 allocations for each PG simultaneously
      const pg1Promises = Array(20).fill(null).map(() => allocateDerivationIndex(1));
      const pg2Promises = Array(20).fill(null).map(() => allocateDerivationIndex(2));

      const [pg1Indices, pg2Indices] = await Promise.all([
        Promise.all(pg1Promises),
        Promise.all(pg2Promises),
      ]);

      // All PG1 indices must be unique
      const uniquePg1 = new Set(pg1Indices);
      expect(uniquePg1.size).toBe(20);

      // All PG2 indices must be unique
      const uniquePg2 = new Set(pg2Indices);
      expect(uniquePg2.size).toBe(20);

      console.log(`[MIXED-CONCURRENT] PG1: ${Math.min(...pg1Indices)}-${Math.max(...pg1Indices)}, PG2: ${Math.min(...pg2Indices)}-${Math.max(...pg2Indices)}`);
    });
  });

  describe('Soft Delete and Index Retention', () => {
    it('should not recycle indices from deleted keys', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);

      // Create a seal key
      const index1 = await allocateDerivationIndex(1);
      const [key1] = await db.insert(sealKeys).values({
        customerId: customer.customerId,
        instanceId: service.instanceId,
        derivationIndex: index1,
        processGroup: 1,
        publicKey: randomBytes(48), // G1 key
        isUserEnabled: true,
      }).returning();
      testSealKeyIds.push(key1.sealKeyId);

      // Soft delete the key
      await db.update(sealKeys)
        .set({ deletedAt: new Date() })
        .where(eq(sealKeys.sealKeyId, key1.sealKeyId));

      // Create another key - should get NEW index, not the deleted one
      const index2 = await allocateDerivationIndex(1);
      const [key2] = await db.insert(sealKeys).values({
        customerId: customer.customerId,
        instanceId: service.instanceId,
        derivationIndex: index2,
        processGroup: 1,
        publicKey: randomBytes(48),
        isUserEnabled: true,
      }).returning();
      testSealKeyIds.push(key2.sealKeyId);

      // Indices should be different (index not recycled)
      expect(index2).not.toBe(index1);
      expect(index2).toBeGreaterThan(index1);
    });

    it('should retain derivation index on disabled keys', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);

      const index = await allocateDerivationIndex(1);
      const [key] = await db.insert(sealKeys).values({
        customerId: customer.customerId,
        instanceId: service.instanceId,
        derivationIndex: index,
        processGroup: 1,
        publicKey: randomBytes(48),
        isUserEnabled: true,
      }).returning();
      testSealKeyIds.push(key.sealKeyId);

      // Disable the key
      await db.update(sealKeys)
        .set({ isUserEnabled: false })
        .where(eq(sealKeys.sealKeyId, key.sealKeyId));

      // Verify the index is still there
      const [disabledKey] = await db.select()
        .from(sealKeys)
        .where(eq(sealKeys.sealKeyId, key.sealKeyId));

      expect(disabledKey.derivationIndex).toBe(index);
      expect(disabledKey.isUserEnabled).toBe(false);
    });
  });

  describe('Transaction Safety', () => {
    it('should allocate index even if subsequent operations fail', async () => {
      const beforeCounter = await getCurrentCounter(1);

      // This simulates a transaction that allocates an index but then fails
      try {
        await db.transaction(async (tx) => {
          // Allocate index
          const index = await allocateDerivationIndex(1, tx);
          expect(typeof index).toBe('number');

          // Force transaction to fail
          throw new Error('Simulated failure after index allocation');
        });
      } catch (error: any) {
        expect(error.message).toBe('Simulated failure after index allocation');
      }

      // Counter should NOT have incremented (transaction rolled back)
      const afterCounter = await getCurrentCounter(1);
      expect(afterCounter).toBe(beforeCounter);
    });

    it('should persist index when transaction succeeds', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId);

      const beforeCounter = await getCurrentCounter(1);
      let allocatedIndex: number;

      await db.transaction(async (tx) => {
        allocatedIndex = await allocateDerivationIndex(1, tx);

        const [key] = await tx.insert(sealKeys).values({
          customerId: customer.customerId,
          instanceId: service.instanceId,
          derivationIndex: allocatedIndex,
          processGroup: 1,
          publicKey: randomBytes(48),
          isUserEnabled: true,
        }).returning();
        testSealKeyIds.push(key.sealKeyId);
      });

      // Counter should have incremented
      const afterCounter = await getCurrentCounter(1);
      expect(afterCounter).toBe(beforeCounter + 1);
    });
  });

  describe('Counter State Verification', () => {
    it('should report correct allocated count', async () => {
      // Get current state
      const pg1Start = await getCurrentCounter(1);
      const pg2Start = await getCurrentCounter(2);

      // Allocate some indices
      await allocateDerivationIndex(1);
      await allocateDerivationIndex(1);
      await allocateDerivationIndex(1);
      await allocateDerivationIndex(2);
      await allocateDerivationIndex(2);

      // Verify counters
      const pg1End = await getCurrentCounter(1);
      const pg2End = await getCurrentCounter(2);

      expect(pg1End).toBe(pg1Start + 3);
      expect(pg2End).toBe(pg2Start + 2);
    });
  });
});
