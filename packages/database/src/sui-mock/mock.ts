/**
 * Mock Sui Service Implementation
 *
 * Simulates blockchain behavior using PostgreSQL storage
 * Matches the ISuiService interface exactly so it can be swapped with real implementation
 *
 * Mock account state stored in customers table:
 * - currentBalanceUsdCents: Balance in USDC cents (1:1 with USD for MVP)
 * - spendingLimitUsdCents: 28-day spending limit
 * - currentPeriodChargedUsdCents: Amount charged this 28-day period
 * - currentPeriodStart: Start of current 28-day period
 * - escrowContractId: Simulated shared account address
 *
 * Mock transactions stored in mock_sui_transactions table:
 * - NOT the production escrowTransactions table
 * - Cleared between test runs
 * - Provides audit trail for billing tests
 *
 * Configurable via suiMockConfig:
 * - Artificial delays for UI testing
 * - Deterministic failure injection
 */

import { db } from '../index.js';
import { customers, mockSuiTransactions, mockTrackingObjects } from '../schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { SPENDING_LIMIT } from '@suiftly/shared/constants';
import { dbClock } from '@suiftly/shared/db-clock';
import type {
  ISuiService,
  EscrowAccount,
  TransactionResult,
  DepositParams,
  WithdrawParams,
  ChargeParams,
  UpdateSpendingLimitParams,
  TransactionHistoryEntry,
} from '@suiftly/shared/sui-service';
import type { Transaction } from '@mysten/sui/transactions';
import { randomBytes, randomInt } from 'crypto';
import { suiMockConfig } from './mock-config.js';

/**
 * Suiftly backend address (simulated)
 * In production, this would be the actual Suiftly wallet address
 */
const SUIFTLY_ADDRESS = '0xSUIFTLY1234567890abcdefABCDEF1234567890abcdefABCDEF1234567890';

/**
 * 28-day period duration in milliseconds
 */
const PERIOD_DURATION_MS = 28 * 24 * 60 * 60 * 1000; // 2,419,200,000 ms

export class MockSuiService implements ISuiService {
  /**
   * Get escrow account for user
   * Queries database (mock blockchain state)
   */
  async getAccount(userAddress: string): Promise<EscrowAccount | null> {
    // Apply configured delay
    await suiMockConfig.applyDelay('getAccount');

    // Check for forced account not found
    if (suiMockConfig.isScenarioEnabled('accountNotFound')) {
      return null;
    }

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    if (!customer || !customer.escrowContractId) {
      return null;
    }

    // Check if 28-day period has elapsed and reset if needed
    const now = dbClock.now().getTime();
    const periodStart = customer.currentPeriodStart
      ? new Date(customer.currentPeriodStart).getTime()
      : now;
    const elapsed = now - periodStart;

    let currentPeriodChargedUsdCents = customer.currentPeriodChargedUsdCents ?? 0;
    let currentPeriodStartMs = periodStart;

    if (elapsed >= PERIOD_DURATION_MS) {
      // Period has elapsed - reset
      currentPeriodChargedUsdCents = 0;
      currentPeriodStartMs = now;
    }

    return {
      accountAddress: customer.escrowContractId,
      userAddress,
      suiftlyAddress: SUIFTLY_ADDRESS,
      balanceUsdCents: customer.currentBalanceUsdCents ?? 0,
      spendingLimitUsdCents: customer.spendingLimitUsdCents ?? SPENDING_LIMIT.DEFAULT_USD * 100,
      currentPeriodChargedUsdCents,
      currentPeriodStartMs,
      // Mock doesn't use tracking objects
      trackingObjectAddress: undefined,
    };
  }

  /**
   * Sync account state to database
   * For mock, this just queries and returns current state
   * For real implementation, this would query blockchain and update database
   */
  async syncAccount(userAddress: string): Promise<EscrowAccount | null> {
    return this.getAccount(userAddress);
  }

  /**
   * Deposit funds to account
   * Auto-creates account if it doesn't exist
   */
  async deposit(params: DepositParams): Promise<TransactionResult> {
    const { userAddress, amountUsdCents, initialSpendingLimitUsdCents, escrowAddress } = params;

    // Apply configured delay
    await suiMockConfig.applyDelay('deposit');

    // Check for forced failure
    const forcedError = suiMockConfig.shouldFail('deposit');
    if (forcedError) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: forcedError,
      };
      // Record failed transaction
      await this.recordTransaction(userAddress, 'deposit', amountUsdCents, result, undefined);
      return result;
    }

    // Check if account exists
    let customer;
    if (escrowAddress) {
      // If escrowAddress provided, use it to find the account
      customer = await db.query.customers.findFirst({
        where: eq(customers.escrowContractId, escrowAddress),
      });

      // Validate it belongs to the correct user
      if (customer && customer.walletAddress !== userAddress) {
        const result = {
          digest: this.generateMockTxDigest(),
          success: false,
          error: 'Escrow address does not belong to specified user',
        };
        await this.recordTransaction(userAddress, 'deposit', amountUsdCents, result, undefined);
        return result;
      }
    } else {
      // No escrowAddress provided - look up by userAddress (for creation or existing)
      customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, userAddress),
      });
    }

    let accountCreated = false;

    if (!customer || !customer.escrowContractId) {
      // Account doesn't exist - create it
      accountCreated = true;
      const now = dbClock.now();
      const accountAddress = this.generateMockAccountAddress();

      if (!customer) {
        // Customer record doesn't exist at all - create it
        const customerId = this.generateCustomerId();
        [customer] = await db.insert(customers).values({
          customerId,
          walletAddress: userAddress,
          escrowContractId: accountAddress,
          status: 'active',
          currentBalanceUsdCents: 0,
          spendingLimitUsdCents:
            initialSpendingLimitUsdCents !== undefined
              ? initialSpendingLimitUsdCents
              : SPENDING_LIMIT.DEFAULT_USD * 100,
          currentPeriodChargedUsdCents: 0,
          currentPeriodStart: now.toISOString().split('T')[0],
          createdAt: now,
          updatedAt: now,
        }).returning();
      } else {
        // Customer exists but no escrow account - add it
        [customer] = await db
          .update(customers)
          .set({
            escrowContractId: accountAddress,
            spendingLimitUsdCents:
              initialSpendingLimitUsdCents !== undefined
                ? initialSpendingLimitUsdCents
                : SPENDING_LIMIT.DEFAULT_USD * 100,
            currentPeriodStart: now.toISOString().split('T')[0],
            updatedAt: now,
          })
          .where(eq(customers.walletAddress, userAddress))
          .returning();
      }
    }

    // Deposit funds (add to balance)
    // Ensure we have a valid balance (handle null/undefined from database)
    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    const newBalance = currentBalance + amountUsdCents;

    // Validate the new balance is a valid number
    if (isNaN(newBalance) || !isFinite(newBalance)) {
      console.error('[SUI MOCK] Invalid balance calculation:', {
        currentBalance,
        amountUsdCents,
        newBalance,
        customer: customer.walletAddress
      });
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Invalid balance calculation',
      };
    }

    await db
      .update(customers)
      .set({
        currentBalanceUsdCents: newBalance,
        updatedAt: dbClock.now(),
      })
      .where(eq(customers.walletAddress, userAddress));

    const txDigest = this.generateMockTxDigest();
    const result: TransactionResult = {
      digest: txDigest,
      success: true,
      accountCreated,
      checkpoint: dbClock.now().getTime(),
      gasUsed: 0, // Mock has no gas
    };

    // If account was created, also create tracking objects
    if (accountCreated && customer.escrowContractId) {
      const trackingAddresses = await this.createTrackingObjects(
        userAddress,
        customer.escrowContractId,
        txDigest
      );

      result.createdObjects = {
        escrowAddress: customer.escrowContractId,
        userTrackingAddress: trackingAddresses.userTrackingAddress,
        suiftlyTrackingAddress: trackingAddresses.suiftlyTrackingAddress,
      };
    }

    // Record successful transaction
    await this.recordTransaction(userAddress, 'deposit', amountUsdCents, result, undefined, newBalance);

    return result;
  }

  /**
   * Withdraw funds from account
   * Auto-creates account if it doesn't exist (with zero balance)
   */
  async withdraw(params: WithdrawParams): Promise<TransactionResult> {
    const { userAddress, amountUsdCents, initialSpendingLimitUsdCents, escrowAddress } = params;

    // Apply configured delay
    await suiMockConfig.applyDelay('withdraw');

    // Check for forced failure
    const forcedError = suiMockConfig.shouldFail('withdraw');
    if (forcedError) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: forcedError,
      };
      await this.recordTransaction(userAddress, 'withdraw', amountUsdCents, result, undefined);
      return result;
    }

    // Check if account exists
    let customer;
    if (escrowAddress) {
      // If escrowAddress provided, use it to find the account
      customer = await db.query.customers.findFirst({
        where: eq(customers.escrowContractId, escrowAddress),
      });

      // Validate it belongs to the correct user
      if (customer && customer.walletAddress !== userAddress) {
        const result = {
          digest: this.generateMockTxDigest(),
          success: false,
          error: 'Escrow address does not belong to specified user',
        };
        await this.recordTransaction(userAddress, 'withdraw', amountUsdCents, result, undefined);
        return result;
      }
    } else {
      // No escrowAddress provided - look up by userAddress (for creation or existing)
      customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, userAddress),
      });
    }

    let accountCreated = false;

    if (!customer || !customer.escrowContractId) {
      // Account doesn't exist - create it with zero balance
      accountCreated = true;
      const now = dbClock.now();
      const accountAddress = this.generateMockAccountAddress();

      if (!customer) {
        const customerId = this.generateCustomerId();
        [customer] = await db.insert(customers).values({
          customerId,
          walletAddress: userAddress,
          escrowContractId: accountAddress,
          status: 'active',
          currentBalanceUsdCents: 0,
          spendingLimitUsdCents:
            initialSpendingLimitUsdCents !== undefined
              ? initialSpendingLimitUsdCents
              : SPENDING_LIMIT.DEFAULT_USD * 100,
          currentPeriodChargedUsdCents: 0,
          currentPeriodStart: now.toISOString().split('T')[0],
          createdAt: now,
          updatedAt: now,
        }).returning();
      } else {
        [customer] = await db
          .update(customers)
          .set({
            escrowContractId: accountAddress,
            spendingLimitUsdCents:
              initialSpendingLimitUsdCents !== undefined
                ? initialSpendingLimitUsdCents
                : SPENDING_LIMIT.DEFAULT_USD * 100,
            currentPeriodStart: now.toISOString().split('T')[0],
            updatedAt: now,
          })
          .where(eq(customers.walletAddress, userAddress))
          .returning();
      }
    }

    // Check sufficient balance (unless forced insufficient)
    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (suiMockConfig.isScenarioEnabled('insufficientBalance') || currentBalance < amountUsdCents) {
      const txDigest = this.generateMockTxDigest();
      const result: TransactionResult = {
        digest: txDigest,
        success: false,
        error: `Insufficient balance. Need $${amountUsdCents / 100}, have $${currentBalance / 100}`,
        accountCreated,
      };

      // If account was created, also create tracking objects (even on failure)
      if (accountCreated && customer.escrowContractId) {
        const trackingAddresses = await this.createTrackingObjects(
          userAddress,
          customer.escrowContractId,
          txDigest
        );

        result.createdObjects = {
          escrowAddress: customer.escrowContractId,
          userTrackingAddress: trackingAddresses.userTrackingAddress,
          suiftlyTrackingAddress: trackingAddresses.suiftlyTrackingAddress,
        };
      }

      await this.recordTransaction(userAddress, 'withdraw', amountUsdCents, result, undefined, currentBalance);
      return result;
    }

    // Withdraw funds (subtract from balance)
    const newBalance = currentBalance - amountUsdCents;
    await db
      .update(customers)
      .set({
        currentBalanceUsdCents: newBalance,
        updatedAt: dbClock.now(),
      })
      .where(eq(customers.walletAddress, userAddress));

    const txDigest = this.generateMockTxDigest();
    const result: TransactionResult = {
      digest: txDigest,
      success: true,
      accountCreated,
      checkpoint: dbClock.now().getTime(),
      gasUsed: 0,
    };

    // If account was created, also create tracking objects
    if (accountCreated && customer.escrowContractId) {
      const trackingAddresses = await this.createTrackingObjects(
        userAddress,
        customer.escrowContractId,
        txDigest
      );

      result.createdObjects = {
        escrowAddress: customer.escrowContractId,
        userTrackingAddress: trackingAddresses.userTrackingAddress,
        suiftlyTrackingAddress: trackingAddresses.suiftlyTrackingAddress,
      };
    }

    await this.recordTransaction(userAddress, 'withdraw', amountUsdCents, result, undefined, newBalance);

    return result;
  }

  /**
   * Charge user account (Suiftly backend only)
   * Enforces 28-day spending limit
   * Does NOT auto-create account
   */
  async charge(params: ChargeParams): Promise<TransactionResult> {
    const { userAddress, amountUsdCents, description, escrowAddress } = params;

    // Apply configured delay
    await suiMockConfig.applyDelay('charge');

    // Check for forced failure
    const forcedError = suiMockConfig.shouldFail('charge');
    if (forcedError) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: forcedError,
      };
      await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description);
      return result;
    }

    // Check for forced account not found
    if (suiMockConfig.isScenarioEnabled('accountNotFound')) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Account does not exist',
      };
      await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description);
      return result;
    }

    // IMPORTANT: Unlike real blockchain, we validate that the provided escrowAddress
    // belongs to the specified user. This simulates the smart contract's capability check.
    let customer;

    if (escrowAddress) {
      // If escrowAddress is provided, look up by that
      customer = await db.query.customers.findFirst({
        where: eq(customers.escrowContractId, escrowAddress),
      });
    } else {
      // If no escrowAddress provided, look up by wallet address
      customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, userAddress),
      });
    }

    if (!customer || !customer.escrowContractId) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Account does not exist',
      };
      await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description);
      return result;
    }

    // Verify the escrow account belongs to the specified user
    if (customer.walletAddress !== userAddress) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Escrow address does not belong to specified user',
      };
      await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description);
      return result;
    }

    // Check if 28-day period has elapsed
    const now = dbClock.now().getTime();
    const periodStart = customer.currentPeriodStart
      ? new Date(customer.currentPeriodStart).getTime()
      : now;
    const elapsed = now - periodStart;

    let currentPeriodCharged = customer.currentPeriodChargedUsdCents ?? 0;
    let needsPeriodReset = false;

    if (elapsed >= PERIOD_DURATION_MS) {
      // Period has elapsed - reset
      currentPeriodCharged = 0;
      needsPeriodReset = true;
    }

    // Check spending limit (unless forced exceeded)
    const spendingLimit = customer.spendingLimitUsdCents ?? SPENDING_LIMIT.DEFAULT_USD * 100;
    if (suiMockConfig.isScenarioEnabled('spendingLimitExceeded') ||
        (spendingLimit > 0 && currentPeriodCharged + amountUsdCents > spendingLimit)) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Would exceed 28-day spending limit: ${spendingLimit / 100} USD (current: ${currentPeriodCharged / 100} USD, charge: ${amountUsdCents / 100} USD)`,
      };
      await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description, customer.currentBalanceUsdCents ?? 0);
      return result;
    }

    // Check sufficient balance (unless forced insufficient)
    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (suiMockConfig.isScenarioEnabled('insufficientBalance') || currentBalance < amountUsdCents) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Insufficient balance. Need $${amountUsdCents / 100}, have $${currentBalance / 100}`,
      };
      await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description, currentBalance);
      return result;
    }

    // Apply charge
    const newBalance = currentBalance - amountUsdCents;
    const newPeriodCharged = currentPeriodCharged + amountUsdCents;
    const updateData: Record<string, unknown> = {
      currentBalanceUsdCents: newBalance,
      currentPeriodChargedUsdCents: newPeriodCharged,
      updatedAt: dbClock.now(),
    };

    if (needsPeriodReset) {
      updateData.currentPeriodStart = dbClock.now().toISOString().split('T')[0];
    }

    await db
      .update(customers)
      .set(updateData)
      .where(eq(customers.escrowContractId, escrowAddress));

    const result: TransactionResult = {
      digest: this.generateMockTxDigest(),
      success: true,
      checkpoint: dbClock.now().getTime(),
      gasUsed: 0,
    };

    await this.recordTransaction(userAddress, 'charge', amountUsdCents, result, description, newBalance, spendingLimit, newPeriodCharged);

    return result;
  }

  /**
   * Credit user account (refund)
   * Does NOT auto-create account
   */
  async credit(params: ChargeParams): Promise<TransactionResult> {
    const { userAddress, amountUsdCents, description, escrowAddress } = params;

    // Apply configured delay
    await suiMockConfig.applyDelay('credit');

    // Check for forced failure
    const forcedError = suiMockConfig.shouldFail('credit');
    if (forcedError) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: forcedError,
      };
      await this.recordTransaction(userAddress, 'credit', amountUsdCents, result, description);
      return result;
    }

    // Check for forced account not found
    if (suiMockConfig.isScenarioEnabled('accountNotFound')) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Account does not exist',
      };
      await this.recordTransaction(userAddress, 'credit', amountUsdCents, result, description);
      return result;
    }

    // IMPORTANT: Unlike real blockchain, we validate that the provided escrowAddress
    // belongs to the specified user. This simulates the smart contract's capability check.
    const customer = await db.query.customers.findFirst({
      where: eq(customers.escrowContractId, escrowAddress),
    });

    if (!customer) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Invalid escrow address - account does not exist',
      };
      await this.recordTransaction(userAddress, 'credit', amountUsdCents, result, description);
      return result;
    }

    // Verify the escrow account belongs to the specified user
    if (customer.walletAddress !== userAddress) {
      const result = {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Escrow address does not belong to specified user',
      };
      await this.recordTransaction(userAddress, 'credit', amountUsdCents, result, description);
      return result;
    }

    // Add to balance
    const newBalance = (customer.currentBalanceUsdCents ?? 0) + amountUsdCents;
    await db
      .update(customers)
      .set({
        currentBalanceUsdCents: newBalance,
        updatedAt: dbClock.now(),
      })
      .where(eq(customers.escrowContractId, escrowAddress));

    const result: TransactionResult = {
      digest: this.generateMockTxDigest(),
      success: true,
      checkpoint: dbClock.now().getTime(),
      gasUsed: 0,
    };

    await this.recordTransaction(userAddress, 'credit', amountUsdCents, result, description, newBalance);

    return result;
  }

  /**
   * Update spending limit
   * Auto-creates account if it doesn't exist
   */
  async updateSpendingLimit(params: UpdateSpendingLimitParams): Promise<TransactionResult> {
    const { userAddress, newLimitUsdCents, escrowAddress } = params;

    // Validate limit
    if (newLimitUsdCents > 0 && newLimitUsdCents < SPENDING_LIMIT.MINIMUM_USD * 100) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Spending limit must be at least ${SPENDING_LIMIT.MINIMUM_USD} USD or 0 (unlimited)`,
      };
    }

    let customer;
    if (escrowAddress) {
      // If escrowAddress provided, use it to find the account
      customer = await db.query.customers.findFirst({
        where: eq(customers.escrowContractId, escrowAddress),
      });

      // Validate it belongs to the correct user
      if (customer && customer.walletAddress !== userAddress) {
        return {
          digest: this.generateMockTxDigest(),
          success: false,
          error: 'Escrow address does not belong to specified user',
        };
      }
    } else {
      // No escrowAddress provided - look up by userAddress (for creation or existing)
      customer = await db.query.customers.findFirst({
        where: eq(customers.walletAddress, userAddress),
      });
    }

    let accountCreated = false;

    if (!customer || !customer.escrowContractId) {
      // Account doesn't exist - create it
      accountCreated = true;
      const now = dbClock.now();
      const accountAddress = this.generateMockAccountAddress();

      if (!customer) {
        const customerId = this.generateCustomerId();
        [customer] = await db.insert(customers).values({
          customerId,
          walletAddress: userAddress,
          escrowContractId: accountAddress,
          status: 'active',
          currentBalanceUsdCents: 0,
          spendingLimitUsdCents: newLimitUsdCents,
          currentPeriodChargedUsdCents: 0,
          currentPeriodStart: now.toISOString().split('T')[0],
          createdAt: now,
          updatedAt: now,
        }).returning();
      } else {
        [customer] = await db
          .update(customers)
          .set({
            escrowContractId: accountAddress,
            spendingLimitUsdCents: newLimitUsdCents,
            currentPeriodStart: now.toISOString().split('T')[0],
            updatedAt: now,
          })
          .where(eq(customers.walletAddress, userAddress))
          .returning();
      }
    } else {
      // Update existing account
      await db
        .update(customers)
        .set({
          spendingLimitUsdCents: newLimitUsdCents,
          updatedAt: dbClock.now(),
        })
        .where(eq(customers.walletAddress, userAddress));
    }

    const txDigest = this.generateMockTxDigest();
    const result: TransactionResult = {
      digest: txDigest,
      success: true,
      accountCreated,
      checkpoint: dbClock.now().getTime(),
      gasUsed: 0,
    };

    // If account was created, also create tracking objects
    if (accountCreated && customer?.escrowContractId) {
      const trackingAddresses = await this.createTrackingObjects(
        userAddress,
        customer.escrowContractId,
        txDigest
      );

      result.createdObjects = {
        escrowAddress: customer.escrowContractId,
        userTrackingAddress: trackingAddresses.userTrackingAddress,
        suiftlyTrackingAddress: trackingAddresses.suiftlyTrackingAddress,
      };
    }

    return result;
  }

  /**
   * Build transaction for user signature
   * Mock returns null (no signing needed)
   */
  async buildTransaction(
    operation: 'deposit' | 'withdraw' | 'updateSpendingLimit',
    params: unknown
  ): Promise<Transaction | null> {
    return null; // Mock doesn't need signatures
  }

  /**
   * Check if this is the mock implementation
   */
  isMock(): boolean {
    return true;
  }

  /**
   * Get transaction history for user
   * Returns simulated blockchain transactions from mock_sui_transactions table
   */
  async getTransactionHistory(
    userAddress: string,
    limit: number = 100
  ): Promise<TransactionHistoryEntry[]> {
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    if (!customer) {
      return [];
    }

    const transactions = await db.query.mockSuiTransactions.findMany({
      where: eq(mockSuiTransactions.customerId, customer.customerId),
      orderBy: [desc(mockSuiTransactions.createdAt)],
      limit,
    });

    return transactions.map(tx => ({
      txDigest: tx.txDigest,
      txType: tx.txType as 'deposit' | 'withdraw' | 'charge' | 'credit',
      amountUsdCents: tx.amountUsdCents,
      description: tx.description ?? undefined,
      success: tx.success,
      error: tx.errorMessage ?? undefined,
      checkpoint: tx.checkpoint ?? undefined,
      balanceAfterUsdCents: tx.balanceAfterUsdCents ?? undefined,
      timestamp: tx.createdAt,
    }));
  }

  /**
   * Record a transaction to mock_sui_transactions table
   * Called internally after each operation
   */
  private async recordTransaction(
    userAddress: string,
    txType: 'deposit' | 'withdraw' | 'charge' | 'credit',
    amountUsdCents: number,
    result: TransactionResult,
    description?: string,
    balanceAfter?: number,
    spendingLimit?: number,
    periodChargedAfter?: number
  ): Promise<void> {
    // Get customer ID
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    if (!customer) {
      // Can't record without customer - this shouldn't happen in normal flow
      console.warn(`[SUI MOCK] Cannot record transaction - customer not found: ${userAddress}`);
      return;
    }

    await db.insert(mockSuiTransactions).values({
      customerId: customer.customerId,
      txDigest: result.digest,
      txType,
      amountUsdCents: amountUsdCents,
      description,
      success: result.success,
      errorMessage: result.error,
      checkpoint: result.checkpoint,
      balanceAfterUsdCents: balanceAfter,
      spendingLimitUsdCents: spendingLimit,
      periodChargedAfterUsdCents: periodChargedAfter,
    });
  }

  /**
   * Generate mock account address (simulated shared object address)
   * Format: 0x + 64 hex chars (32 bytes) = 66 chars total (matches Sui address format)
   */
  private generateMockAccountAddress(): string {
    return '0x' + randomBytes(32).toString('hex');
  }

  /**
   * Generate mock transaction digest
   * Format: 0x + 64 hex chars (32 bytes) = 66 chars total (matches Sui tx digest format)
   */
  private generateMockTxDigest(): string {
    return '0x' + randomBytes(32).toString('hex');
  }

  /**
   * Generate customer ID (cryptographically secure random positive 32-bit integer)
   * Range: 1 to 2147483647 (positive signed 32-bit)
   * Uses crypto.randomInt for security (same as auth endpoints)
   *
   * Note: Collision handling is at the caller level (insert will fail on duplicate)
   * For mock/test scenarios, collisions are extremely rare and acceptable
   */
  private generateCustomerId(): number {
    // Cryptographically secure random [1, 2^31-1]
    return randomInt(1, 2147483647);
  }

  /**
   * Create tracking objects for account discovery
   * Simulates the three objects created atomically on-chain
   */
  private async createTrackingObjects(
    userAddress: string,
    escrowAddress: string,
    txDigest: string
  ): Promise<{
    userTrackingAddress: string;
    suiftlyTrackingAddress: string;
  }> {
    // Generate addresses for the two tracking objects
    const userTrackingAddress = this.generateMockAccountAddress();
    const suiftlyTrackingAddress = this.generateMockAccountAddress();

    // Create both tracking objects in the database
    await db.insert(mockTrackingObjects).values([
      {
        trackingAddress: userTrackingAddress,
        owner: 'user',
        userAddress,
        escrowAddress,
        createdByTx: txDigest,
      },
      {
        trackingAddress: suiftlyTrackingAddress,
        owner: 'suiftly',
        userAddress,
        escrowAddress,
        createdByTx: txDigest,
      },
    ]);

    return {
      userTrackingAddress,
      suiftlyTrackingAddress,
    };
  }
}

/**
 * Singleton instance
 */
export const mockSuiService = new MockSuiService();
