/**
 * API Test: Billing Flow
 *
 * Tests the monthly billing lifecycle through HTTP calls only.
 * NO direct internal function calls (except DB reads for assertions).
 *
 * This test simulates realistic client behavior by:
 * 1. Making HTTP calls to tRPC endpoints
 * 2. Controlling time via /test/clock/* endpoints
 * 3. Triggering billing job via /test/billing/run-periodic-job
 * 4. Reading DB directly for assertions (read-only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, billingRecords, customerCredits, customers } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  trpcMutation,
  resetTestData,
  runPeriodicBillingJob,
} from './helpers/http.js';
import { TEST_WALLET } from './helpers/auth.js';
import { expectNoNotifications } from './helpers/notifications.js';
import { setupBillingTest } from './helpers/setup.js';

describe('API: Billing Flow', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    ({ accessToken, customerId } = await setupBillingTest());
  });

  afterEach(async () => {
    // Reset clock
    await resetClock();
    // Clean up via HTTP
    await resetTestData(TEST_WALLET);
  });

  describe('Periodic Billing Job', () => {
    it('should run periodic billing job for specific customer', async () => {
      // ---- Setup: Platform DRAFT invoice was already created by setupBillingTest ----
      await setClockTime('2025-01-05T00:00:00Z');

      // ---- Run periodic billing job ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);

      console.log('[DEBUG] Billing job result:', JSON.stringify(result, null, 2));
      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();

      await expectNoNotifications(customerId);
    });

    it('should apply scheduled tier downgrade on 1st of month', async () => {
      // ---- Setup: Upgrade platform to pro, then schedule downgrade ----
      await setClockTime('2025-01-05T00:00:00Z');

      // Platform is at starter from setupBillingTest — upgrade to pro
      const upgradeResult = await trpcMutation<any>(
        'services.upgradeTier',
        { serviceType: 'platform', newTier: 'pro' },
        accessToken
      );
      expect(upgradeResult.result?.data?.success).toBe(true);

      // Schedule downgrade
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'platform', newTier: 'starter' },
        accessToken
      );

      // Verify scheduled via customer record
      let customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('pro');   // platform currently at pro
      expect(customer?.scheduledPlatformTier).toBe('starter');

      // ---- Advance to 1st of next month and run billing ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Verify tier changed
      customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.platformTier).toBe('starter');
      expect(customer?.scheduledPlatformTier).toBeNull();

      await expectNoNotifications(customerId);
    });

    it('should process scheduled cancellation on 1st of month', async () => {
      // ---- Setup: Enable seal (auto-provisioned) and schedule cancellation ----
      await setClockTime('2025-01-05T00:00:00Z');

      // Seal is auto-provisioned from setupBillingTest — enable it first
      await trpcMutation<any>(
        'services.toggleService',
        { serviceType: 'seal', enabled: true },
        accessToken
      );

      // Get service for assertions
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });

      // Schedule cancellation (cancellation is platform-level for all services)
      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'seal' },
        accessToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify cancellation scheduled on customer (platform-level)
      let customerRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerRec?.platformCancellationScheduledFor).toBeTruthy();
      // Seal service should still be enabled
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.state).toBe('enabled'); // Still enabled

      // ---- Advance to 1st of next month and run billing ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Verify platform cancellation state
      customerRec = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customerRec?.platformCancellationScheduledFor).toBeNull();
      expect(customerRec?.platformCancellationEffectiveAt).toBeTruthy();

      await expectNoNotifications(customerId);
    });
  });

  describe('DRAFT Invoice Creation', () => {
    it('should create DRAFT invoice for next month on subscription', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      // Platform DRAFT invoice was created by setupBillingTest at platform subscribe

      // Check for DRAFT invoice
      const drafts = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      // Should have at least one DRAFT invoice for next billing period
      expect(drafts.length).toBeGreaterThanOrEqual(1);

      await expectNoNotifications(customerId);
    });
  });

  describe('Invoice Transitions', () => {
    it('should transition DRAFT to PENDING on 1st of month', async () => {
      // ---- Setup: Platform DRAFT from setupBillingTest ----
      await setClockTime('2025-01-05T00:00:00Z');

      // Check for DRAFT invoice before month end
      const draftsBefore = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });
      expect(draftsBefore.length).toBeGreaterThanOrEqual(1);

      // ---- Advance to 1st of next month ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Check invoices after billing run
      const allRecords = await db.query.billingRecords.findMany({
        where: eq(billingRecords.customerId, customerId),
      });

      // Should have at least one non-draft invoice (either pending or paid)
      const nonDraft = allRecords.filter(r => r.status !== 'draft');
      expect(nonDraft.length).toBeGreaterThanOrEqual(1);

      await expectNoNotifications(customerId);
    });
  });
});
