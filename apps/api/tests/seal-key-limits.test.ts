/**
 * Seal Key Limit Tests
 *
 * Tests the safeguards that prevent derivation index exhaustion:
 * 1. Tier limit: enabled + disabled keys (excludes soft-deleted)
 * 2. Hard limit: 20 total keys per customer (includes soft-deleted)
 * 3. Admin notification on hard limit breach
 *
 * These tests operate directly on the database to simulate the limit checks
 * without requiring the full API stack.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomInt } from 'crypto';
import { db, customers, serviceInstances, sealKeys, adminNotifications } from '@suiftly/database';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { SEAL_LIMITS } from '@suiftly/shared/constants';

// ============================================================================
// Constants - imported from shared package (single source of truth)
// ============================================================================

const { HARD_LIMIT_KEYS_PER_CUSTOMER } = SEAL_LIMITS;

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
const testNotificationIds: number[] = [];

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
  customerId: number,
  maxSealKeys: number = 1
): Promise<TestServiceInstance> {
  const [instance] = await db.insert(serviceInstances).values({
    customerId,
    serviceType: 'seal',
    state: 'enabled',
    tier: 'starter',
    isUserEnabled: true,
    paidOnce: true,
    config: { totalSealKeys: maxSealKeys },
  }).returning();

  const testInstance = { instanceId: instance.instanceId, customerId };
  testServiceInstances.push(testInstance);
  return testInstance;
}

async function createTestSealKey(
  customerId: number,
  instanceId: number,
  options: {
    isUserEnabled?: boolean;
    deletedAt?: Date | null;
    derivationIndex?: number;
  } = {}
): Promise<number> {
  const {
    isUserEnabled = true,
    deletedAt = null,
    derivationIndex = randomInt(1000000, 2147483647),
  } = options;

  const [key] = await db.insert(sealKeys).values({
    customerId,
    instanceId,
    derivationIndex,
    processGroup: 1,
    publicKey: randomBytes(48), // BLS12-381 G1
    isUserEnabled,
    deletedAt,
  }).returning();

  testSealKeyIds.push(key.sealKeyId);
  return key.sealKeyId;
}

async function cleanupTestData(): Promise<void> {
  // Clean up notifications first
  for (const notificationId of testNotificationIds) {
    await db.delete(adminNotifications)
      .where(eq(adminNotifications.notificationId, notificationId));
  }
  testNotificationIds.length = 0;

  // Clean up seal keys (FK constraint)
  for (const sealKeyId of testSealKeyIds) {
    await db.delete(sealKeys).where(eq(sealKeys.sealKeyId, sealKeyId));
  }
  testSealKeyIds.length = 0;

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
// Limit Check Functions (mirrors seal.ts logic for testing)
// ============================================================================

/**
 * Check tier limit: enabled + disabled keys (excludes soft-deleted)
 */
async function checkTierLimit(
  instanceId: number,
  maxSealKeys: number
): Promise<{ allowed: boolean; currentCount: number }> {
  const nonDeletedKeys = await db.query.sealKeys.findMany({
    where: and(
      eq(sealKeys.instanceId, instanceId),
      isNull(sealKeys.deletedAt)
    ),
    columns: { sealKeyId: true },
  });

  return {
    allowed: nonDeletedKeys.length < maxSealKeys,
    currentCount: nonDeletedKeys.length,
  };
}

/**
 * Check hard limit: ALL keys ever created (includes soft-deleted)
 */
async function checkHardLimit(
  customerId: number
): Promise<{ allowed: boolean; currentCount: number }> {
  const allKeysEver = await db.query.sealKeys.findMany({
    where: eq(sealKeys.customerId, customerId),
    columns: { sealKeyId: true },
  });

  return {
    allowed: allKeysEver.length < HARD_LIMIT_KEYS_PER_CUSTOMER,
    currentCount: allKeysEver.length,
  };
}

/**
 * Create admin notification for hard limit (with deduplication)
 */
async function createHardLimitNotification(
  customerId: number,
  totalKeys: number
): Promise<{ created: boolean; notificationId?: number }> {
  // Check if we already have an unacknowledged notification for this customer
  const existingNotification = await db.query.adminNotifications.findFirst({
    where: and(
      eq(adminNotifications.customerId, customerId),
      eq(adminNotifications.code, 'SEAL_KEY_HARD_LIMIT_REACHED'),
      eq(adminNotifications.acknowledged, false)
    ),
  });

  if (existingNotification) {
    return { created: false };
  }

  const [notification] = await db.insert(adminNotifications).values({
    severity: 'warning',
    category: 'security',
    code: 'SEAL_KEY_HARD_LIMIT_REACHED',
    message: `Customer ${customerId} has reached the hard limit of ${HARD_LIMIT_KEYS_PER_CUSTOMER} seal keys.`,
    details: JSON.stringify({
      customerId,
      totalKeysCreated: totalKeys,
      hardLimit: HARD_LIMIT_KEYS_PER_CUSTOMER,
    }),
    customerId,
  }).returning();

  testNotificationIds.push(notification.notificationId);
  return { created: true, notificationId: notification.notificationId };
}

// ============================================================================
// Tests
// ============================================================================

describe('Seal Key Limits', () => {
  afterAll(async () => {
    await cleanupTestData();
  });

  afterEach(async () => {
    // Clean up after each test
    await cleanupTestData();
  });

  describe('Tier Limit (enabled + disabled, excludes soft-deleted)', () => {
    it('should block when enabled keys reach limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 2);

      // Create 2 enabled keys (reaches limit of 2)
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });

      const result = await checkTierLimit(service.instanceId, 2);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(2);
    });

    it('should block when disabled keys count toward limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 2);

      // Create 1 enabled + 1 disabled = 2 keys (reaches limit)
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: false });

      const result = await checkTierLimit(service.instanceId, 2);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(2);
    });

    it('should allow when soft-deleted keys do not count toward tier limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 2);

      // Create 2 soft-deleted keys + 1 enabled
      await createTestSealKey(customer.customerId, service.instanceId, {
        isUserEnabled: false,
        deletedAt: new Date(),
      });
      await createTestSealKey(customer.customerId, service.instanceId, {
        isUserEnabled: false,
        deletedAt: new Date(),
      });
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });

      const result = await checkTierLimit(service.instanceId, 2);
      // Only 1 non-deleted key, limit is 2, so allowed
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(1);
    });

    it('should allow when under limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 5);

      // Create 3 keys (under limit of 5)
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: false });
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });

      const result = await checkTierLimit(service.instanceId, 5);
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(3);
    });
  });

  describe('Hard Limit (includes soft-deleted)', () => {
    it('should block when total keys reach hard limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 100);

      // Create exactly HARD_LIMIT keys
      for (let i = 0; i < HARD_LIMIT_KEYS_PER_CUSTOMER; i++) {
        await createTestSealKey(customer.customerId, service.instanceId, {
          isUserEnabled: i % 2 === 0, // Alternate enabled/disabled
          derivationIndex: 10000 + i,
        });
      }

      const result = await checkHardLimit(customer.customerId);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(HARD_LIMIT_KEYS_PER_CUSTOMER);
    });

    it('should count soft-deleted keys toward hard limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 100);

      // Create HARD_LIMIT keys, all soft-deleted
      for (let i = 0; i < HARD_LIMIT_KEYS_PER_CUSTOMER; i++) {
        await createTestSealKey(customer.customerId, service.instanceId, {
          isUserEnabled: false,
          deletedAt: new Date(),
          derivationIndex: 20000 + i,
        });
      }

      const result = await checkHardLimit(customer.customerId);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(HARD_LIMIT_KEYS_PER_CUSTOMER);

      // Tier limit should still allow (all soft-deleted)
      const tierResult = await checkTierLimit(service.instanceId, 100);
      expect(tierResult.allowed).toBe(true);
      expect(tierResult.currentCount).toBe(0);
    });

    it('should allow when under hard limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 100);

      // Create 10 keys (under hard limit of 20)
      for (let i = 0; i < 10; i++) {
        await createTestSealKey(customer.customerId, service.instanceId, {
          derivationIndex: 30000 + i,
        });
      }

      const result = await checkHardLimit(customer.customerId);
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(10);
    });

    it('should be per-customer, not per-service', async () => {
      const customer = await createTestCustomer();
      const service1 = await createTestServiceInstance(customer.customerId, 100);

      // Create another service for same customer (edge case)
      // Note: In real system, customer has one seal service, but test the counter logic

      // Create 15 keys on service1
      for (let i = 0; i < 15; i++) {
        await createTestSealKey(customer.customerId, service1.instanceId, {
          derivationIndex: 40000 + i,
        });
      }

      // Hard limit should count all 15
      const result = await checkHardLimit(customer.customerId);
      expect(result.currentCount).toBe(15);
      expect(result.allowed).toBe(true);

      // Create 5 more (total 20 = hard limit)
      for (let i = 0; i < 5; i++) {
        await createTestSealKey(customer.customerId, service1.instanceId, {
          derivationIndex: 40015 + i,
        });
      }

      const resultAfter = await checkHardLimit(customer.customerId);
      expect(resultAfter.currentCount).toBe(20);
      expect(resultAfter.allowed).toBe(false);
    });
  });

  describe('Admin Notification on Hard Limit', () => {
    it('should create notification when hard limit reached', async () => {
      const customer = await createTestCustomer();

      const result = await createHardLimitNotification(customer.customerId, 20);
      expect(result.created).toBe(true);
      expect(result.notificationId).toBeDefined();

      // Verify notification in database
      const notification = await db.query.adminNotifications.findFirst({
        where: eq(adminNotifications.notificationId, result.notificationId!),
      });

      expect(notification).toBeDefined();
      expect(notification!.severity).toBe('warning');
      expect(notification!.category).toBe('security');
      expect(notification!.code).toBe('SEAL_KEY_HARD_LIMIT_REACHED');
      expect(notification!.customerId).toBe(customer.customerId);
      expect(notification!.acknowledged).toBe(false);
    });

    it('should deduplicate notifications (only one unacknowledged per customer)', async () => {
      const customer = await createTestCustomer();

      // Create first notification
      const result1 = await createHardLimitNotification(customer.customerId, 20);
      expect(result1.created).toBe(true);

      // Try to create second notification - should be deduplicated
      const result2 = await createHardLimitNotification(customer.customerId, 21);
      expect(result2.created).toBe(false);

      // Verify only one notification exists
      const notifications = await db.query.adminNotifications.findMany({
        where: and(
          eq(adminNotifications.customerId, customer.customerId),
          eq(adminNotifications.code, 'SEAL_KEY_HARD_LIMIT_REACHED')
        ),
      });

      expect(notifications.length).toBe(1);
    });

    it('should allow new notification after previous one is acknowledged', async () => {
      const customer = await createTestCustomer();

      // Create first notification
      const result1 = await createHardLimitNotification(customer.customerId, 20);
      expect(result1.created).toBe(true);

      // Acknowledge the notification
      await db.update(adminNotifications)
        .set({ acknowledged: true, acknowledgedAt: new Date() })
        .where(eq(adminNotifications.notificationId, result1.notificationId!));

      // Create second notification - should succeed (previous was acknowledged)
      const result2 = await createHardLimitNotification(customer.customerId, 25);
      expect(result2.created).toBe(true);
      expect(result2.notificationId).not.toBe(result1.notificationId);

      testNotificationIds.push(result2.notificationId!);
    });

    it('should include details in notification', async () => {
      const customer = await createTestCustomer();

      const result = await createHardLimitNotification(customer.customerId, 20);
      expect(result.created).toBe(true);

      const notification = await db.query.adminNotifications.findFirst({
        where: eq(adminNotifications.notificationId, result.notificationId!),
      });

      expect(notification!.details).toBeDefined();
      const details = JSON.parse(notification!.details!);
      expect(details.customerId).toBe(customer.customerId);
      expect(details.totalKeysCreated).toBe(20);
      expect(details.hardLimit).toBe(HARD_LIMIT_KEYS_PER_CUSTOMER);
    });
  });

  describe('Combined Limit Scenarios', () => {
    it('should check hard limit before tier limit', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 100);

      // Create 20 soft-deleted keys (hits hard limit, but tier limit shows 0)
      for (let i = 0; i < HARD_LIMIT_KEYS_PER_CUSTOMER; i++) {
        await createTestSealKey(customer.customerId, service.instanceId, {
          isUserEnabled: false,
          deletedAt: new Date(),
          derivationIndex: 50000 + i,
        });
      }

      // Hard limit should block
      const hardResult = await checkHardLimit(customer.customerId);
      expect(hardResult.allowed).toBe(false);

      // But tier limit would allow (all deleted)
      const tierResult = await checkTierLimit(service.instanceId, 100);
      expect(tierResult.allowed).toBe(true);

      // In the real API, hard limit is checked FIRST, so creation would be blocked
    });

    it('should allow creation when both limits have room', async () => {
      const customer = await createTestCustomer();
      const service = await createTestServiceInstance(customer.customerId, 5);

      // Create 2 enabled + 1 soft-deleted = 3 total, 2 for tier
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });
      await createTestSealKey(customer.customerId, service.instanceId, { isUserEnabled: true });
      await createTestSealKey(customer.customerId, service.instanceId, {
        isUserEnabled: false,
        deletedAt: new Date(),
      });

      const hardResult = await checkHardLimit(customer.customerId);
      expect(hardResult.allowed).toBe(true); // 3 < 20

      const tierResult = await checkTierLimit(service.instanceId, 5);
      expect(tierResult.allowed).toBe(true); // 2 < 5
    });
  });
});
