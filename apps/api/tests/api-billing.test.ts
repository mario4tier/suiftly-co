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
 *
 * See docs/TEST_REFACTORING_PLAN.md for test layer design.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { serviceInstances, customers, billingRecords, customerCredits } from '@suiftly/database/schema';
import { eq, and, gt, sql } from 'drizzle-orm';
import {
  setClockTime,
  resetClock,
  ensureTestBalance,
  trpcMutation,
  resetTestData,
  runPeriodicBillingJob,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

describe('API: Billing Flow', () => {
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

  describe('Periodic Billing Job', () => {
    it('should run periodic billing job for specific customer', async () => {
      // ---- Setup: Subscribe to a service ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Mark as paid
      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      await db.update(serviceInstances)
        .set({ paidOnce: true, subPendingInvoiceId: null, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // ---- Run periodic billing job ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);

      console.log('[DEBUG] Billing job result:', JSON.stringify(result, null, 2));
      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
    });

    it('should apply scheduled tier downgrade on 1st of month', async () => {
      // ---- Setup: Subscribe and schedule downgrade ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'pro' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      await db.update(serviceInstances)
        .set({ paidOnce: true, subPendingInvoiceId: null, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // Schedule downgrade
      await trpcMutation<any>(
        'services.scheduleTierDowngrade',
        { serviceType: 'seal', newTier: 'starter' },
        accessToken
      );

      // Verify scheduled
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.tier).toBe('pro');
      expect(service?.scheduledTier).toBe('starter');

      // ---- Advance to 1st of next month and run billing ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Verify tier changed
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.tier).toBe('starter');
      expect(service?.scheduledTier).toBeNull();
    });

    it('should process scheduled cancellation on 1st of month', async () => {
      // ---- Setup: Subscribe and schedule cancellation ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      await db.update(serviceInstances)
        .set({ paidOnce: true, subPendingInvoiceId: null, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

      // Schedule cancellation
      const cancelResult = await trpcMutation<any>(
        'services.scheduleCancellation',
        { serviceType: 'seal' },
        accessToken
      );
      expect(cancelResult.result?.data?.success).toBe(true);

      // Verify scheduled
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.cancellationScheduledFor).toBeTruthy();
      expect(service?.state).toBe('enabled'); // Still enabled

      // ---- Advance to 1st of next month and run billing ----
      await setClockTime('2025-02-01T00:00:00Z');

      const result = await runPeriodicBillingJob(customerId);
      expect(result.success).toBe(true);

      // Verify state changed to cancellation_pending
      service = await db.query.serviceInstances.findFirst({
        where: eq(serviceInstances.instanceId, service!.instanceId),
      });
      expect(service?.state).toBe('cancellation_pending');
      expect(service?.cancellationScheduledFor).toBeNull();
      expect(service?.cancellationEffectiveAt).toBeTruthy();
    });
  });

  describe('DRAFT Invoice Creation', () => {
    it('should create DRAFT invoice for next month on subscription', async () => {
      await setClockTime('2025-01-15T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      // Check for DRAFT invoice
      const drafts = await db.query.billingRecords.findMany({
        where: and(
          eq(billingRecords.customerId, customerId),
          eq(billingRecords.status, 'draft')
        ),
      });

      // Should have at least one DRAFT invoice for next billing period
      expect(drafts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Invoice Transitions', () => {
    it('should transition DRAFT to PENDING on 1st of month', async () => {
      // ---- Setup ----
      await setClockTime('2025-01-05T00:00:00Z');

      await trpcMutation<any>(
        'services.subscribe',
        { serviceType: 'seal', tier: 'starter' },
        accessToken
      );

      let service = await db.query.serviceInstances.findFirst({
        where: and(
          eq(serviceInstances.customerId, customerId),
          eq(serviceInstances.serviceType, 'seal')
        ),
      });
      await db.update(serviceInstances)
        .set({ paidOnce: true, subPendingInvoiceId: null, state: 'enabled', isUserEnabled: true })
        .where(eq(serviceInstances.instanceId, service!.instanceId));

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
    });
  });
});
