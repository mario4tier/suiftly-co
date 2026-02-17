/**
 * API Test: Payment Method CRUD
 *
 * Tests getPaymentMethods, addPaymentMethod, removePaymentMethod,
 * reorderPaymentMethods, and createStripeSetupIntent via HTTP.
 *
 * Follows the same pattern as api-billing.test.ts:
 * - HTTP calls to tRPC endpoints
 * - DB reads for assertions (read-only)
 * - Reset test data in beforeEach/afterEach
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '@suiftly/database';
import { customers, customerPaymentMethods } from '@suiftly/database/schema';
import { eq, and } from 'drizzle-orm';
import {
  trpcMutation,
  trpcQuery,
  restCall,
  resetTestData,
  ensureTestBalance,
} from './helpers/http.js';
import { login, TEST_WALLET } from './helpers/auth.js';

describe('API: Payment Method CRUD', () => {
  let accessToken: string;
  let customerId: number;

  beforeEach(async () => {
    // Reset test customer data via HTTP
    await resetTestData(TEST_WALLET);

    // Login - this creates the customer with production defaults
    accessToken = await login(TEST_WALLET);

    // Get customer ID for DB assertions
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, TEST_WALLET),
    });
    if (!customer) {
      throw new Error('Test customer not found after login');
    }
    customerId = customer.customerId;
  });

  afterEach(async () => {
    await resetTestData(TEST_WALLET);
  });

  // =========================================================================
  // getPaymentMethods
  // =========================================================================
  describe('getPaymentMethods', () => {
    it('should return empty list for new customer', async () => {
      const result = await trpcQuery<any>(
        'billing.getPaymentMethods',
        {},
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.methods).toEqual([]);
    });

    it('should return escrow method with balance info', async () => {
      // ensureTestBalance auto-creates escrow payment method via /test/wallet/deposit
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      // Query methods
      const result = await trpcQuery<any>(
        'billing.getPaymentMethods',
        {},
        accessToken
      );

      const methods = result.result?.data?.methods;
      expect(methods).toHaveLength(1);
      expect(methods[0].providerType).toBe('escrow');
      expect(methods[0].priority).toBe(1);
      expect(methods[0].info.balanceUsdCents).toBeGreaterThanOrEqual(10000); // $100+
      expect(methods[0].info.hasEscrowAccount).toBe(true);
    });

    it('should return multiple methods ordered by priority', async () => {
      // Setup: escrow + stripe
      await ensureTestBalance(50, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      const result = await trpcQuery<any>(
        'billing.getPaymentMethods',
        {},
        accessToken
      );

      const methods = result.result?.data?.methods;
      expect(methods).toHaveLength(2);
      expect(methods[0].providerType).toBe('escrow');
      expect(methods[0].priority).toBe(1);
      expect(methods[1].providerType).toBe('stripe');
      expect(methods[1].priority).toBe(2);
    });
  });

  // =========================================================================
  // addPaymentMethod - escrow
  // =========================================================================
  describe('addPaymentMethod - escrow', () => {
    it('should succeed when escrow account exists', async () => {
      // Create escrow account via deposit (this auto-creates an escrow payment method)
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      // Remove the auto-created escrow payment method so we can test addPaymentMethod explicitly
      const autoCreated = await db.query.customerPaymentMethods.findFirst({
        where: and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.providerType, 'escrow'),
          eq(customerPaymentMethods.status, 'active')
        ),
      });
      if (autoCreated) {
        await db.update(customerPaymentMethods)
          .set({ status: 'removed' })
          .where(eq(customerPaymentMethods.id, autoCreated.id));
      }

      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.success).toBe(true);
      expect(result.result?.data.providerType).toBe('escrow');

      // Verify in DB
      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methods).toHaveLength(1);
      expect(methods[0].providerType).toBe('escrow');
      expect(methods[0].priority).toBe(1);
    });

    it('should succeed even without escrow account', async () => {
      // Reset with clearEscrowAccount to ensure no escrow contract ID
      await restCall('POST', '/test/data/reset', {
        walletAddress: TEST_WALLET,
        clearEscrowAccount: true,
      });
      // Re-login after reset
      accessToken = await login(TEST_WALLET);

      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.success).toBe(true);
      expect(result.result?.data.providerType).toBe('escrow');

      // Verify in DB — providerRef should be null (no escrow account yet)
      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methods).toHaveLength(1);
      expect(methods[0].providerType).toBe('escrow');
      expect(methods[0].providerRef).toBeNull();
    });

    it('should reject duplicate escrow method', async () => {
      await ensureTestBalance(100, { walletAddress: TEST_WALLET });

      // Add first time → success
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      // Add second time → conflict
      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      expect(result.error).toBeDefined();
      expect(result.error.data?.code).toBe('CONFLICT');
    });
  });

  // =========================================================================
  // addPaymentMethod - stripe
  // =========================================================================
  describe('addPaymentMethod - stripe', () => {
    it('should return clientSecret for card setup', async () => {
      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.success).toBe(true);
      expect(result.result?.data.providerType).toBe('stripe');
      expect(result.result?.data.clientSecret).toBeDefined();
      expect(result.result?.data.setupIntentId).toBeDefined();
      expect(result.result?.data.clientSecret).toContain('seti_mock_');

      // Verify stripeCustomerId was set on customer
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.stripeCustomerId).toBeDefined();
      expect(customer?.stripeCustomerId).toContain('cus_mock_');

      // Verify payment method row was created
      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.providerType, 'stripe'),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methods).toHaveLength(1);
    });

    it('should reject duplicate stripe method', async () => {
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      expect(result.error).toBeDefined();
      expect(result.error.data?.code).toBe('CONFLICT');
    });
  });

  // =========================================================================
  // addPaymentMethod - paypal
  // =========================================================================
  describe('addPaymentMethod - paypal', () => {
    it('should return NOT_IMPLEMENTED', async () => {
      const result = await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'paypal' },
        accessToken
      );

      expect(result.error).toBeDefined();
      // tRPC doesn't have NOT_IMPLEMENTED code, check for INTERNAL_SERVER_ERROR or custom message
      expect(result.error.message).toContain('not yet supported');
    });
  });

  // =========================================================================
  // removePaymentMethod
  // =========================================================================
  describe('removePaymentMethod', () => {
    it('should remove method and reorder remaining', async () => {
      // Add escrow + stripe
      await ensureTestBalance(50, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Get method IDs
      const methodsBefore = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methodsBefore).toHaveLength(2);

      const escrowMethod = methodsBefore.find(m => m.providerType === 'escrow')!;

      // Remove escrow (priority 1)
      const result = await trpcMutation<any>(
        'billing.removePaymentMethod',
        { paymentMethodId: escrowMethod.id },
        accessToken
      );
      expect(result.result?.data?.success).toBe(true);

      // Verify: stripe should now be priority 1
      const methodsAfter = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));
      expect(methodsAfter).toHaveLength(1);
      expect(methodsAfter[0].providerType).toBe('stripe');
      expect(methodsAfter[0].priority).toBe(1);
    });

    it('should return NOT_FOUND for invalid ID', async () => {
      const result = await trpcMutation<any>(
        'billing.removePaymentMethod',
        { paymentMethodId: 99999 },
        accessToken
      );

      expect(result.error).toBeDefined();
      expect(result.error.data?.code).toBe('NOT_FOUND');
    });

    it('should return NOT_FOUND for already-removed method', async () => {
      await ensureTestBalance(50, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );

      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));
      const methodId = methods[0].id;

      // Remove first time → success
      await trpcMutation<any>(
        'billing.removePaymentMethod',
        { paymentMethodId: methodId },
        accessToken
      );

      // Remove second time → NOT_FOUND
      const result = await trpcMutation<any>(
        'billing.removePaymentMethod',
        { paymentMethodId: methodId },
        accessToken
      );

      expect(result.error).toBeDefined();
      expect(result.error.data?.code).toBe('NOT_FOUND');
    });
  });

  // =========================================================================
  // reorderPaymentMethods
  // =========================================================================
  describe('reorderPaymentMethods', () => {
    it('should swap priorities', async () => {
      // Add escrow (priority 1) + stripe (priority 2)
      await ensureTestBalance(50, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      // Get method IDs
      const methodsBefore = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));

      const escrow = methodsBefore.find(m => m.providerType === 'escrow')!;
      const stripe = methodsBefore.find(m => m.providerType === 'stripe')!;

      // Swap: stripe → 1, escrow → 2
      const result = await trpcMutation<any>(
        'billing.reorderPaymentMethods',
        {
          order: [
            { id: stripe.id, priority: 1 },
            { id: escrow.id, priority: 2 },
          ],
        },
        accessToken
      );
      expect(result.result?.data?.success).toBe(true);

      // Verify via getPaymentMethods
      const listResult = await trpcQuery<any>(
        'billing.getPaymentMethods',
        {},
        accessToken
      );

      const methods = listResult.result?.data?.methods;
      expect(methods).toHaveLength(2);
      expect(methods[0].providerType).toBe('stripe');
      expect(methods[0].priority).toBe(1);
      expect(methods[1].providerType).toBe('escrow');
      expect(methods[1].priority).toBe(2);
    });

    it('should reject duplicate priorities', async () => {
      await ensureTestBalance(50, { walletAddress: TEST_WALLET });

      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'escrow' },
        accessToken
      );
      await trpcMutation<any>(
        'billing.addPaymentMethod',
        { providerType: 'stripe' },
        accessToken
      );

      const methods = await db.select()
        .from(customerPaymentMethods)
        .where(and(
          eq(customerPaymentMethods.customerId, customerId),
          eq(customerPaymentMethods.status, 'active')
        ));

      const result = await trpcMutation<any>(
        'billing.reorderPaymentMethods',
        {
          order: [
            { id: methods[0].id, priority: 1 },
            { id: methods[1].id, priority: 1 }, // Duplicate!
          ],
        },
        accessToken
      );

      expect(result.error).toBeDefined();
      expect(result.error.data?.code).toBe('BAD_REQUEST');
    });

    it('should reject invalid method IDs', async () => {
      const result = await trpcMutation<any>(
        'billing.reorderPaymentMethods',
        {
          order: [
            { id: 99999, priority: 1 },
          ],
        },
        accessToken
      );

      expect(result.error).toBeDefined();
      expect(result.error.data?.code).toBe('BAD_REQUEST');
    });
  });

  // =========================================================================
  // createStripeSetupIntent
  // =========================================================================
  describe('createStripeSetupIntent', () => {
    it('should create customer and return setup intent', async () => {
      const result = await trpcMutation<any>(
        'billing.createStripeSetupIntent',
        {},
        accessToken
      );

      expect(result.result?.data).toBeDefined();
      expect(result.result?.data.clientSecret).toBeDefined();
      expect(result.result?.data.setupIntentId).toBeDefined();
      expect(result.result?.data.stripeCustomerId).toContain('cus_mock_');

      // Verify stripeCustomerId was stored
      const customer = await db.query.customers.findFirst({
        where: eq(customers.customerId, customerId),
      });
      expect(customer?.stripeCustomerId).toBe(result.result?.data.stripeCustomerId);
    });

    it('should reuse existing Stripe customer', async () => {
      // First call creates customer
      const result1 = await trpcMutation<any>(
        'billing.createStripeSetupIntent',
        {},
        accessToken
      );

      const firstCustomerId = result1.result?.data.stripeCustomerId;

      // Second call should reuse
      const result2 = await trpcMutation<any>(
        'billing.createStripeSetupIntent',
        {},
        accessToken
      );

      expect(result2.result?.data.stripeCustomerId).toBe(firstCustomerId);
    });
  });
});
