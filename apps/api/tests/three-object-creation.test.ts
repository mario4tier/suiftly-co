/**
 * Tests for three-object creation pattern
 *
 * Verifies that when an escrow account is created, three objects are created atomically:
 * 1. Shared escrow account
 * 2. User's tracking object
 * 3. Suiftly's tracking object
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockSuiService } from '@suiftly/database/sui-mock';
import { db } from '@suiftly/database';
import { customers, mockTrackingObjects, mockSuiTransactions, refreshTokens, userActivityLogs } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

describe('Three-Object Creation Pattern', () => {
  let mockSui: MockSuiService;
  let testWalletAddress: string;

  beforeEach(async () => {
    mockSui = new MockSuiService();
    testWalletAddress = '0x' + '1'.repeat(64);

    // Clean up any existing data
    const existingCustomer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWalletAddress),
    });

    if (existingCustomer) {
      // Delete transactions first due to foreign key
      await db.delete(mockSuiTransactions)
        .where(eq(mockSuiTransactions.customerId, existingCustomer.customerId));
      await db.delete(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));
      // Delete refresh tokens to avoid foreign key constraint
      await db.delete(refreshTokens)
        .where(eq(refreshTokens.customerId, existingCustomer.customerId));
      // Delete user activity logs to avoid foreign key constraint
      await db.delete(userActivityLogs)
        .where(eq(userActivityLogs.customerId, existingCustomer.customerId));
      await db.delete(customers)
        .where(eq(customers.customerId, existingCustomer.customerId));
    }
  });

  afterEach(async () => {
    // Clean up test data
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWalletAddress),
    });

    if (customer) {
      // Delete transactions first due to foreign key
      await db.delete(mockSuiTransactions)
        .where(eq(mockSuiTransactions.customerId, customer.customerId));
      await db.delete(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));
      // Delete refresh tokens to avoid foreign key constraint
      await db.delete(refreshTokens)
        .where(eq(refreshTokens.customerId, customer.customerId));
      // Delete user activity logs to avoid foreign key constraint
      await db.delete(userActivityLogs)
        .where(eq(userActivityLogs.customerId, customer.customerId));
      await db.delete(customers)
        .where(eq(customers.customerId, customer.customerId));
    }
  });

  describe('Deposit creates three objects', () => {
    it('should create escrow and tracking objects on first deposit', async () => {
      // Perform deposit which creates account
      const result = await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000, // $100
        initialSpendingLimitUsdCents: 25000, // $250
      });

      // Verify operation succeeded
      expect(result.success).toBe(true);
      expect(result.accountCreated).toBe(true);

      // Verify three objects were returned
      expect(result.createdObjects).toBeDefined();
      expect(result.createdObjects!.escrowAddress).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.createdObjects!.userTrackingAddress).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.createdObjects!.suiftlyTrackingAddress).toMatch(/^0x[a-f0-9]{64}$/);

      // Verify all three addresses are unique
      expect(result.createdObjects!.escrowAddress)
        .not.toBe(result.createdObjects!.userTrackingAddress);
      expect(result.createdObjects!.escrowAddress)
        .not.toBe(result.createdObjects!.suiftlyTrackingAddress);
      expect(result.createdObjects!.userTrackingAddress)
        .not.toBe(result.createdObjects!.suiftlyTrackingAddress);

      // Verify escrow account was created in database
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, testWalletAddress),
      });
      expect(customer).toBeDefined();
      expect(customer!.escrowContractId).toBe(result.createdObjects!.escrowAddress);

      // Verify tracking objects were created in database
      const trackingObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

      expect(trackingObjects).toHaveLength(2);

      // Check user's tracking object
      const userTracking = trackingObjects.find(t => t.owner === 'user');
      expect(userTracking).toBeDefined();
      expect(userTracking!.trackingAddress).toBe(result.createdObjects!.userTrackingAddress);
      expect(userTracking!.escrowAddress).toBe(result.createdObjects!.escrowAddress);
      expect(userTracking!.createdByTx).toBe(result.digest);

      // Check Suiftly's tracking object
      const suiftlyTracking = trackingObjects.find(t => t.owner === 'suiftly');
      expect(suiftlyTracking).toBeDefined();
      expect(suiftlyTracking!.trackingAddress).toBe(result.createdObjects!.suiftlyTrackingAddress);
      expect(suiftlyTracking!.escrowAddress).toBe(result.createdObjects!.escrowAddress);
      expect(suiftlyTracking!.createdByTx).toBe(result.digest);
    });

    it('should not create objects on subsequent deposits', async () => {
      // First deposit creates account
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 5000,
      });

      // Second deposit should not create account
      const result = await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 3000,
      });

      expect(result.success).toBe(true);
      expect(result.accountCreated).toBe(false);
      expect(result.createdObjects).toBeUndefined();

      // Verify still only 2 tracking objects
      const trackingObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

      expect(trackingObjects).toHaveLength(2);
    });
  });

  describe('Withdraw creates three objects', () => {
    it('should create objects even when withdraw fails', async () => {
      // Withdraw on new account (will fail but create account)
      const result = await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 1000,
      });

      // Verify operation failed but account was created
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');
      expect(result.accountCreated).toBe(true);

      // Verify three objects were returned
      expect(result.createdObjects).toBeDefined();
      expect(result.createdObjects!.escrowAddress).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.createdObjects!.userTrackingAddress).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.createdObjects!.suiftlyTrackingAddress).toMatch(/^0x[a-f0-9]{64}$/);

      // Verify tracking objects were created
      const trackingObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

      expect(trackingObjects).toHaveLength(2);
    });
  });

  describe('UpdateSpendingLimit creates three objects', () => {
    it('should create objects when updating spending limit on new account', async () => {
      // Update spending limit on new account
      const result = await mockSui.updateSpendingLimit({
        userAddress: testWalletAddress,
        newLimitUsdCents: 50000, // $500
      });

      // Verify operation succeeded
      expect(result.success).toBe(true);
      expect(result.accountCreated).toBe(true);

      // Verify three objects were returned
      expect(result.createdObjects).toBeDefined();
      expect(result.createdObjects!.escrowAddress).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.createdObjects!.userTrackingAddress).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.createdObjects!.suiftlyTrackingAddress).toMatch(/^0x[a-f0-9]{64}$/);

      // Verify tracking objects were created
      const trackingObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

      expect(trackingObjects).toHaveLength(2);

      // Verify spending limit was set
      const account = await mockSui.getAccount(testWalletAddress);
      expect(account).not.toBeNull();
      expect(account!.spendingLimitUsdCents).toBe(50000);
    });
  });

  describe('Recovery scenarios', () => {
    beforeEach(async () => {
      // Clean up ALL mock tracking objects to ensure clean state
      // This is necessary because other test files might leave data behind
      await db.delete(mockTrackingObjects);

      // Also clean up customer accounts for test addresses used in this describe block
      const testAddresses = [
        '0x' + '2'.repeat(64),
        '0x' + '3'.repeat(64),
        '0x' + '4'.repeat(64),
      ];

      for (const addr of testAddresses) {
        const customer = await db.query.customers.findFirst({
          where: eq(customers.walletAddress, addr),
        });
        if (customer) {
          await db.delete(mockSuiTransactions)
            .where(eq(mockSuiTransactions.customerId, customer.customerId));
          await db.delete(customers)
            .where(eq(customers.customerId, customer.customerId));
        }
      }
    });

    it('should allow Suiftly to discover accounts via tracking objects', async () => {
      // Create multiple accounts
      const addresses = [
        '0x' + '2'.repeat(64),
        '0x' + '3'.repeat(64),
        '0x' + '4'.repeat(64),
      ];

      for (const addr of addresses) {
        await mockSui.deposit({
          userAddress: addr,
          amountUsdCents: 1000,
        });
      }

      // Simulate Suiftly backend discovering its tracking objects for these specific addresses
      const suiftlyTrackingObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.owner, 'suiftly'));

      // Filter to only the tracking objects for our test addresses
      const testTrackingObjects = suiftlyTrackingObjects.filter(t =>
        addresses.includes(t.userAddress)
      );

      expect(testTrackingObjects.length).toBe(3);

      // Each tracking object points to an escrow account
      for (const tracking of testTrackingObjects) {
        expect(tracking.escrowAddress).toMatch(/^0x[a-f0-9]{64}$/);
        expect(tracking.userAddress).toMatch(/^0x[a-f0-9]{64}$/);

        // Can find the corresponding customer
        const customer = await db.query.customers.findFirst({
          where: eq(customers.walletAddress, tracking.userAddress),
        });

        expect(customer).toBeDefined();
        expect(customer!.escrowContractId).toBe(tracking.escrowAddress);
      }

      // Clean up test data
      for (const addr of addresses) {
        const customer = await db.query.customers.findFirst({
          where: eq(customers.walletAddress, addr),
        });
        if (customer) {
          await db.delete(mockSuiTransactions)
            .where(eq(mockSuiTransactions.customerId, customer.customerId));
          await db.delete(mockTrackingObjects)
            .where(eq(mockTrackingObjects.userAddress, addr));
          await db.delete(customers)
            .where(eq(customers.customerId, customer.customerId));
        }
      }
    });

    it('should mark tracking objects as reconciled', async () => {
      // Create account
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 5000,
      });

      // Get tracking objects
      const trackingObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

      expect(trackingObjects).toHaveLength(2);

      // Initially not reconciled
      expect(trackingObjects[0].reconciled).toBe('false');
      expect(trackingObjects[1].reconciled).toBe('false');

      // Simulate reconciliation process
      for (const tracking of trackingObjects) {
        await db.update(mockTrackingObjects)
          .set({
            reconciled: 'true',
            reconciledAt: new Date(),
          })
          .where(eq(mockTrackingObjects.id, tracking.id));
      }

      // Verify reconciliation
      const reconciledObjects = await db.select()
        .from(mockTrackingObjects)
        .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

      expect(reconciledObjects[0].reconciled).toBe('true');
      expect(reconciledObjects[0].reconciledAt).not.toBeNull();
      expect(reconciledObjects[1].reconciled).toBe('true');
      expect(reconciledObjects[1].reconciledAt).not.toBeNull();
    });
  });
});
