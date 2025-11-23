/**
 * Unit tests for Sui mock interface
 *
 * Tests error injection, transaction recording, and transaction retrieval
 * to verify the mock implementation works correctly for billing tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockSuiService } from './mock';
import { suiMockConfig } from './mock-config';
import { dbClockProvider, type DBClock } from '@suiftly/shared/db-clock';
import { db } from '@suiftly/database';
import {
  customers,
  mockSuiTransactions,
  mockTrackingObjects,
  refreshTokens,
  userActivityLogs,
  apiKeys,
  serviceInstances,
  sealKeys,
  escrowTransactions,
  ledgerEntries,
  billingRecords,
  usageRecords
} from '@suiftly/database/schema';
import { eq, and, desc } from 'drizzle-orm';

describe('Sui Mock Interface', () => {
  let mockSui: MockSuiService;
  let testCustomerId: number;
  let testWalletAddress: string;
  let mockClock: DBClock | null = null;

  beforeEach(async () => {
    // Clear any previous mock config
    suiMockConfig.clearConfig();

    // Reset to real clock
    dbClockProvider.reset();

    // Initialize mock Sui service
    mockSui = new MockSuiService();

    // Use a test wallet address
    testWalletAddress = '0x' + 'a'.repeat(64);

    // Clean up any existing test customer to start fresh
    const existingCustomer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWalletAddress)
    });

    // Clear tracking objects for this address (they exist independently)
    await db.delete(mockTrackingObjects)
      .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

    if (existingCustomer) {
      // Clear any existing mock transactions
      await db.delete(mockSuiTransactions)
        .where(eq(mockSuiTransactions.customerId, existingCustomer.customerId));

      // Clear all dependent tables to avoid foreign key constraint violations
      await db.delete(usageRecords)
        .where(eq(usageRecords.customerId, existingCustomer.customerId));
      await db.delete(escrowTransactions)
        .where(eq(escrowTransactions.customerId, existingCustomer.customerId));
      await db.delete(ledgerEntries)
        .where(eq(ledgerEntries.customerId, existingCustomer.customerId));
      await db.delete(billingRecords)
        .where(eq(billingRecords.customerId, existingCustomer.customerId));
      await db.delete(sealKeys)
        .where(eq(sealKeys.customerId, existingCustomer.customerId));
      await db.delete(serviceInstances)
        .where(eq(serviceInstances.customerId, existingCustomer.customerId));
      await db.delete(apiKeys)
        .where(eq(apiKeys.customerId, existingCustomer.customerId));
      await db.delete(refreshTokens)
        .where(eq(refreshTokens.customerId, existingCustomer.customerId));
      await db.delete(userActivityLogs)
        .where(eq(userActivityLogs.customerId, existingCustomer.customerId));

      // Delete the customer
      await db.delete(customers)
        .where(eq(customers.customerId, existingCustomer.customerId));
    }

    // Note: We'll let the mock service create the customer when needed
    testCustomerId = 0; // Will be set when needed
  });

  afterEach(async () => {
    // Reset clock to real
    dbClockProvider.reset();

    // Clear mock config
    suiMockConfig.clearConfig();

    // Clean up test data - find customer by wallet address
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, testWalletAddress)
    });

    // Clear tracking objects for this address (they exist independently)
    await db.delete(mockTrackingObjects)
      .where(eq(mockTrackingObjects.userAddress, testWalletAddress));

    if (customer) {
      await db.delete(mockSuiTransactions)
        .where(eq(mockSuiTransactions.customerId, customer.customerId));

      // Clear all dependent tables to avoid foreign key constraint violations
      await db.delete(usageRecords)
        .where(eq(usageRecords.customerId, customer.customerId));
      await db.delete(escrowTransactions)
        .where(eq(escrowTransactions.customerId, customer.customerId));
      await db.delete(ledgerEntries)
        .where(eq(ledgerEntries.customerId, customer.customerId));
      await db.delete(billingRecords)
        .where(eq(billingRecords.customerId, customer.customerId));
      await db.delete(sealKeys)
        .where(eq(sealKeys.customerId, customer.customerId));
      await db.delete(serviceInstances)
        .where(eq(serviceInstances.customerId, customer.customerId));
      await db.delete(apiKeys)
        .where(eq(apiKeys.customerId, customer.customerId));
      await db.delete(refreshTokens)
        .where(eq(refreshTokens.customerId, customer.customerId));
      await db.delete(userActivityLogs)
        .where(eq(userActivityLogs.customerId, customer.customerId));

      await db.delete(customers)
        .where(eq(customers.customerId, customer.customerId));
    }
  });

  describe('Basic Operations', () => {
    it('should identify as mock', () => {
      expect(mockSui.isMock()).toBe(true);
    });

    it('should get account state', async () => {
      // Initially no escrow account
      const account1 = await mockSui.getAccount(testWalletAddress);
      expect(account1).toBeNull();

      // Create account via deposit
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000, // $100
        initialSpendingLimitUsdCents: 25000, // $250
      });

      // Now account exists
      const account2 = await mockSui.getAccount(testWalletAddress);
      expect(account2).not.toBeNull();
      expect(account2!.balanceUsdCents).toBe(10000);
      expect(account2!.spendingLimitUsdCents).toBe(25000);
      expect(account2!.accountAddress).toBeTruthy();
      expect(account2!.accountAddress).toMatch(/^0x[a-f0-9]{64}$/);
    });

    it('should deposit funds and record transaction', async () => {
      const result = await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 5000, // $50
      });

      expect(result.success).toBe(true);
      expect(result.digest).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.accountCreated).toBe(true); // Should create account on first deposit

      // Check transaction was recorded
      // Get the customer that was created by the mock service
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, testWalletAddress)
      });
      expect(customer).toBeDefined();

      const transactions = await db.select()
        .from(mockSuiTransactions)
        .where(eq(mockSuiTransactions.customerId, customer!.customerId));

      expect(transactions).toHaveLength(1);
      expect(transactions[0].txType).toBe('deposit');
      expect(transactions[0].amountUsdCents).toBe(5000);
      expect(transactions[0].success).toBe('true');
      expect(transactions[0].balanceAfterUsdCents).toBe(5000);
    });

    it('should withdraw funds and record transaction', async () => {
      // First deposit
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000, // $100
      });

      // Then withdraw
      const result = await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 3000, // $30
      });

      expect(result.success).toBe(true);
      expect(result.digest).toMatch(/^0x[a-f0-9]{64}$/);

      // Check balance after withdrawal
      const account = await mockSui.getAccount(testWalletAddress);
      expect(account!.balanceUsdCents).toBe(7000);

      // Check transaction was recorded
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, testWalletAddress)
      });
      expect(customer).toBeDefined();

      const transactions = await db.select()
        .from(mockSuiTransactions)
        .where(and(
          eq(mockSuiTransactions.customerId, customer!.customerId),
          eq(mockSuiTransactions.txType, 'withdraw')
        ));

      expect(transactions).toHaveLength(1);
      expect(transactions[0].amountUsdCents).toBe(3000);
      expect(transactions[0].success).toBe('true');
      expect(transactions[0].balanceAfterUsdCents).toBe(7000);
    });

    it('should fail withdraw with insufficient balance', async () => {
      // Deposit small amount
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 1000, // $10
      });

      // Try to withdraw more
      const result = await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 2000, // $20
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient balance');

      // Check failed transaction was recorded
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, testWalletAddress)
      });
      expect(customer).toBeDefined();

      const transactions = await db.select()
        .from(mockSuiTransactions)
        .where(and(
          eq(mockSuiTransactions.customerId, customer!.customerId),
          eq(mockSuiTransactions.txType, 'withdraw')
        ));

      expect(transactions).toHaveLength(1);
      expect(transactions[0].success).toBe('false');
      expect(transactions[0].errorMessage).toContain('Insufficient balance');
    });

    it('should update spending limit', async () => {
      // Create account with initial spending limit
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000,
        initialSpendingLimitUsdCents: 5000, // $50
      });

      // Update spending limit
      const result = await mockSui.updateSpendingLimit({
        userAddress: testWalletAddress,
        newLimitUsdCents: 15000, // $150
      });

      expect(result.success).toBe(true);

      // Verify new limit
      const account = await mockSui.getAccount(testWalletAddress);
      expect(account!.spendingLimitUsdCents).toBe(15000);
    });
  });

  describe('Charge and Credit Operations', () => {
    let escrowAddress: string;

    beforeEach(async () => {
      // Setup account with balance and spending limit
      const depositResult = await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 20000, // $200
        initialSpendingLimitUsdCents: 10000, // $100
      });

      // Get the escrow address for use in charge/credit operations
      const account = await mockSui.getAccount(testWalletAddress);
      escrowAddress = account!.accountAddress;
    });

    it('should charge account successfully', async () => {
      const result = await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 2900, // $29
        description: 'Seal PRO subscription',
        escrowAddress,
      });

      expect(result.success).toBe(true);
      expect(result.digest).toMatch(/^0x[a-f0-9]{64}$/);

      // Check balance after charge
      const account = await mockSui.getAccount(testWalletAddress);
      expect(account!.balanceUsdCents).toBe(17100); // $200 - $29

      // Check transaction
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, testWalletAddress)
      });
      expect(customer).toBeDefined();

      const transactions = await db.select()
        .from(mockSuiTransactions)
        .where(and(
          eq(mockSuiTransactions.customerId, customer!.customerId),
          eq(mockSuiTransactions.txType, 'charge')
        ));

      expect(transactions).toHaveLength(1);
      expect(transactions[0].amountUsdCents).toBe(2900);
      expect(transactions[0].description).toBe('Seal PRO subscription');
      expect(transactions[0].periodChargedAfterUsdCents).toBe(2900);
    });

    it('should enforce spending limit on charges', async () => {
      // First charge within limit
      await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 8000, // $80
        description: 'First charge',
        escrowAddress,
      });

      // Second charge that would exceed limit
      const result = await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 3000, // $30 (total would be $110, limit is $100)
        description: 'Second charge',
        escrowAddress,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('spending limit');

      // Verify period charged didn't increase
      const account = await mockSui.getAccount(testWalletAddress);
      expect(account!.currentPeriodChargedUsdCents).toBe(8000);
    });

    it('should credit account successfully', async () => {
      // First charge
      await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 5000, // $50
        description: 'Service charge',
        escrowAddress,
      });

      // Then refund
      const result = await mockSui.credit({
        userAddress: testWalletAddress,
        amountUsdCents: 1000, // $10
        description: 'Partial refund',
        escrowAddress,
      });

      expect(result.success).toBe(true);

      // Check balance after credit
      const account = await mockSui.getAccount(testWalletAddress);
      expect(account!.balanceUsdCents).toBe(16000); // $200 - $50 + $10

      // Check transaction
      const customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, testWalletAddress)
      });
      expect(customer).toBeDefined();

      const transactions = await db.select()
        .from(mockSuiTransactions)
        .where(and(
          eq(mockSuiTransactions.customerId, customer!.customerId),
          eq(mockSuiTransactions.txType, 'credit')
        ));

      expect(transactions).toHaveLength(1);
      expect(transactions[0].amountUsdCents).toBe(1000);
      expect(transactions[0].description).toBe('Partial refund');
    });

    it('should fail charge/credit when account not found', async () => {
      const nonExistentAddress = '0x' + 'b'.repeat(64);
      const nonExistentEscrow = '0x' + 'f'.repeat(64);

      // Charge should fail with non-existent escrow
      const chargeResult = await mockSui.charge({
        userAddress: nonExistentAddress,
        amountUsdCents: 1000,
        description: 'Test charge',
        escrowAddress: nonExistentEscrow,
      });

      expect(chargeResult.success).toBe(false);
      expect(chargeResult.error).toContain('does not exist');

      // Credit should fail with non-existent escrow
      const creditResult = await mockSui.credit({
        userAddress: nonExistentAddress,
        amountUsdCents: 1000,
        description: 'Test credit',
        escrowAddress: nonExistentEscrow,
      });

      expect(creditResult.success).toBe(false);
      expect(creditResult.error).toContain('does not exist');
    });
  });

  describe('Error Injection', () => {
    it('should inject deposit failure', async () => {
      suiMockConfig.setConfig({
        forceDepositFailure: true,
        forceDepositFailureMessage: 'Network error during deposit',
      });

      const result = await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error during deposit');

      // Note: Transaction recording fails when customer doesn't exist,
      // which is expected behavior for early deposit failures.
      // The error is logged but doesn't affect the deposit failure response.
    });

    it('should inject withdraw failure', async () => {
      // First deposit
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000,
      });

      // Configure failure
      suiMockConfig.setConfig({
        forceWithdrawFailure: true,
        forceWithdrawFailureMessage: 'Smart contract execution failed',
      });

      const result = await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 5000,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Smart contract execution failed');
    });

    it('should inject charge failure', async () => {
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000,
        initialSpendingLimitUsdCents: 20000,
      });

      suiMockConfig.setConfig({
        forceChargeFailure: true,
        forceChargeFailureMessage: 'Transaction timeout',
      });

      const result = await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 1000,
        description: 'Test charge',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transaction timeout');
    });

    it('should inject scenario-based failures', async () => {
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000,
        initialSpendingLimitUsdCents: 5000,
      });

      // Test insufficient balance scenario
      suiMockConfig.setConfig({
        forceInsufficientBalance: true,
      });

      const withdrawResult = await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 1000, // Should fail even though balance is sufficient
      });

      expect(withdrawResult.success).toBe(false);
      expect(withdrawResult.error).toContain('Insufficient balance');

      // Test spending limit exceeded scenario
      suiMockConfig.setConfig({
        forceInsufficientBalance: false,
        forceSpendingLimitExceeded: true,
      });

      // Get escrow address for charge operation
      const account = await mockSui.getAccount(testWalletAddress);
      const chargeResult = await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 100, // Should fail even though under limit
        description: 'Test',
        escrowAddress: account!.accountAddress,
      });

      expect(chargeResult.success).toBe(false);
      expect(chargeResult.error).toContain('spending limit');
    });

    it('should apply configurable delays', async () => {
      suiMockConfig.setConfig({
        depositDelayMs: 100,
      });

      const startTime = Date.now();
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 5000,
      });
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Transaction History', () => {
    it('should retrieve transaction history', async () => {
      // Perform multiple operations
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 10000,
        initialSpendingLimitUsdCents: 20000,
      });

      await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 2000,
        description: 'Service charge',
      });

      await mockSui.credit({
        userAddress: testWalletAddress,
        amountUsdCents: 500,
        description: 'Refund',
      });

      await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 3000,
      });

      // Get transaction history
      const history = await mockSui.getTransactionHistory(testWalletAddress, 10);

      expect(history).toHaveLength(4);

      // Should be in reverse chronological order
      expect(history[0].txType).toBe('withdraw');
      expect(history[1].txType).toBe('credit');
      expect(history[2].txType).toBe('charge');
      expect(history[3].txType).toBe('deposit');

      // Check all fields are present
      const tx = history[0];
      expect(tx.txDigest).toMatch(/^0x[a-f0-9]{64}$/);
      expect(tx.amountUsdCents).toBe(3000);
      expect(tx.balanceAfterUsdCents).toBeDefined();
      expect(tx.success).toBe(true);
      expect(tx.timestamp).toBeInstanceOf(Date);
    });

    it('should limit transaction history results', async () => {
      // Create many transactions
      for (let i = 0; i < 10; i++) {
        await mockSui.deposit({
          userAddress: testWalletAddress,
          amountUsdCents: 1000,
        });
      }

      // Get limited history
      const history = await mockSui.getTransactionHistory(testWalletAddress, 5);

      expect(history).toHaveLength(5);
    });

    it('should include failed transactions in history', async () => {
      // Deposit
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 1000,
      });

      // Failed withdraw (insufficient balance)
      await mockSui.withdraw({
        userAddress: testWalletAddress,
        amountUsdCents: 2000,
      });

      const history = await mockSui.getTransactionHistory(testWalletAddress, 10);

      expect(history).toHaveLength(2);
      expect(history[0].success).toBe(false);
      expect(history[0].error).toContain('Insufficient balance');
    });
  });

  describe('28-Day Period Reset', () => {
    it('should reset period when 28 days have passed', async () => {
      // Use mock clock
      mockClock = dbClockProvider.useMockClock({
        currentTime: new Date('2024-01-01T00:00:00Z'),
      });

      // Initial deposit and charge
      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 50000, // $500
        initialSpendingLimitUsdCents: 10000, // $100 limit
      });

      // Get escrow address for charge
      let account = await mockSui.getAccount(testWalletAddress);
      const escrowAddress = account!.accountAddress;

      await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 8000, // $80
        description: 'First month charge',
        escrowAddress,
      });

      account = await mockSui.getAccount(testWalletAddress);
      expect(account!.currentPeriodChargedUsdCents).toBe(8000);

      // Advance time by 28 days
      mockClock.advanceDays(28);

      // The period reset happens when we do the next charge, not on sync
      // Can charge full amount again (this will trigger the reset)
      const result = await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 9000, // $90
        description: 'Second month charge',
        escrowAddress,
      });

      expect(result.success).toBe(true);

      // After charge with period reset, the new period should have only the new charge
      account = await mockSui.getAccount(testWalletAddress);
      expect(account!.currentPeriodChargedUsdCents).toBe(9000);
    });

    it('should not reset period before 28 days', async () => {
      // Use mock clock
      mockClock = dbClockProvider.useMockClock({
        currentTime: new Date('2024-01-01T00:00:00Z'),
      });

      await mockSui.deposit({
        userAddress: testWalletAddress,
        amountUsdCents: 50000,
        initialSpendingLimitUsdCents: 10000,
      });

      // Get escrow address for charge
      const account = await mockSui.getAccount(testWalletAddress);
      const escrowAddress = account!.accountAddress;

      await mockSui.charge({
        userAddress: testWalletAddress,
        amountUsdCents: 8000,
        description: 'Initial charge',
        escrowAddress,
      });

      // Advance by only 27 days
      mockClock.advanceDays(27);

      await mockSui.syncAccount(testWalletAddress);

      const accountAfter = await mockSui.getAccount(testWalletAddress);
      expect(accountAfter!.currentPeriodChargedUsdCents).toBe(8000); // Not reset
    });
  });

  describe('Auto Account Creation', () => {
    it('should auto-create account on deposit', async () => {
      const newAddress = '0x' + 'c'.repeat(64);

      // Clean up any existing data for this address
      const existingCustomer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, newAddress)
      });
      if (existingCustomer) {
        await db.delete(mockSuiTransactions)
          .where(eq(mockSuiTransactions.customerId, existingCustomer.customerId));
        await db.delete(mockTrackingObjects)
          .where(eq(mockTrackingObjects.userAddress, newAddress));
        await db.delete(customers)
          .where(eq(customers.customerId, existingCustomer.customerId));
      }

      // No account initially
      let account = await mockSui.getAccount(newAddress);
      expect(account).toBeNull();

      // Deposit creates account
      const result = await mockSui.deposit({
        userAddress: newAddress,
        amountUsdCents: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.accountCreated).toBe(true);

      account = await mockSui.getAccount(newAddress);
      expect(account).not.toBeNull();
      expect(account!.accountAddress).toBeTruthy();
      expect(account!.balanceUsdCents).toBe(5000);
    });

    it('should auto-create account on withdraw', async () => {
      const newAddress = '0x' + 'd'.repeat(64);

      // Clean up any existing data for this address
      const existingCustomer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, newAddress)
      });
      if (existingCustomer) {
        await db.delete(mockSuiTransactions)
          .where(eq(mockSuiTransactions.customerId, existingCustomer.customerId));
        await db.delete(mockTrackingObjects)
          .where(eq(mockTrackingObjects.userAddress, newAddress));
        await db.delete(customers)
          .where(eq(customers.customerId, existingCustomer.customerId));
      }

      // No account initially
      let account = await mockSui.getAccount(newAddress);
      expect(account).toBeNull();

      // Withdraw creates account (even though it will fail due to no balance)
      const result = await mockSui.withdraw({
        userAddress: newAddress,
        amountUsdCents: 1000,
      });

      expect(result.success).toBe(false); // Fails due to insufficient balance
      expect(result.accountCreated).toBe(true); // But account was created

      account = await mockSui.getAccount(newAddress);
      expect(account).not.toBeNull();
      expect(account!.balanceUsdCents).toBe(0);
    });

    it('should auto-create account on spending limit update', async () => {
      const newAddress = '0x' + 'e'.repeat(64);

      // Clean up any existing data for this address
      const existingCustomer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, newAddress)
      });
      if (existingCustomer) {
        await db.delete(mockSuiTransactions)
          .where(eq(mockSuiTransactions.customerId, existingCustomer.customerId));
        await db.delete(mockTrackingObjects)
          .where(eq(mockTrackingObjects.userAddress, newAddress));
        await db.delete(customers)
          .where(eq(customers.customerId, existingCustomer.customerId));
      }

      // No account initially
      let account = await mockSui.getAccount(newAddress);
      expect(account).toBeNull();

      // Update spending limit creates account
      const result = await mockSui.updateSpendingLimit({
        userAddress: newAddress,
        newLimitUsdCents: 15000,
      });

      expect(result.success).toBe(true);
      expect(result.accountCreated).toBe(true);

      account = await mockSui.getAccount(newAddress);
      expect(account).not.toBeNull();
      expect(account!.spendingLimitUsdCents).toBe(15000);
    });

    it('should NOT auto-create account on charge', async () => {
      const newAddress = '0x' + 'f'.repeat(64);

      const result = await mockSui.charge({
        userAddress: newAddress,
        amountUsdCents: 1000,
        description: 'Test charge',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');

      // Account should still not exist
      const account = await mockSui.getAccount(newAddress);
      expect(account).toBeNull();
    });

    it('should NOT auto-create account on credit', async () => {
      const newAddress = '0x' + '9'.repeat(64);

      const result = await mockSui.credit({
        userAddress: newAddress,
        amountUsdCents: 1000,
        description: 'Test credit',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');

      // Account should still not exist
      const account = await mockSui.getAccount(newAddress);
      expect(account).toBeNull();
    });
  });
});