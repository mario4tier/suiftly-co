/**
 * Mock Sui Service Implementation
 *
 * Simulates blockchain behavior using PostgreSQL storage
 * Matches the ISuiService interface exactly so it can be swapped with real implementation
 *
 * Mock account state stored in customers table:
 * - currentBalanceUsdCents: Balance in USDC cents (1:1 with USD for MVP)
 * - maxMonthlyUsdCents: 28-day spending limit
 * - currentMonthChargedUsdCents: Amount charged this 28-day period
 * - currentMonthStart: Start of current 28-day period
 * - escrowContractId: Simulated shared account address
 *
 * All operations are simulated as instant transactions (no blockchain delay)
 */

import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import { SPENDING_LIMIT } from '@suiftly/shared/constants';
import type {
  ISuiService,
  EscrowAccount,
  TransactionResult,
  DepositParams,
  WithdrawParams,
  ChargeParams,
  UpdateSpendingLimitParams,
} from './interface';
import type { Transaction } from '@mysten/sui/transactions';
import { randomBytes } from 'crypto';

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
    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    if (!customer || !customer.escrowContractId) {
      return null;
    }

    // Check if 28-day period has elapsed and reset if needed
    const now = Date.now();
    const periodStart = customer.currentMonthStart
      ? new Date(customer.currentMonthStart).getTime()
      : now;
    const elapsed = now - periodStart;

    let currentPeriodChargedUsdCents = customer.currentMonthChargedUsdCents ?? 0;
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
      balanceUsdcCents: customer.currentBalanceUsdCents ?? 0,
      spendingLimitUsdCents: customer.maxMonthlyUsdCents ?? SPENDING_LIMIT.DEFAULT_USD * 100,
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
    const { userAddress, amountUsdcCents, initialSpendingLimitUsdCents } = params;

    // Check if account exists
    let customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    let accountCreated = false;

    if (!customer || !customer.escrowContractId) {
      // Account doesn't exist - create it
      accountCreated = true;
      const now = new Date();
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
          maxMonthlyUsdCents:
            initialSpendingLimitUsdCents !== undefined
              ? initialSpendingLimitUsdCents
              : SPENDING_LIMIT.DEFAULT_USD * 100,
          currentMonthChargedUsdCents: 0,
          lastMonthChargedUsdCents: 0,
          currentMonthStart: now.toISOString().split('T')[0],
          createdAt: now,
          updatedAt: now,
        }).returning();
      } else {
        // Customer exists but no escrow account - add it
        [customer] = await db
          .update(customers)
          .set({
            escrowContractId: accountAddress,
            maxMonthlyUsdCents:
              initialSpendingLimitUsdCents !== undefined
                ? initialSpendingLimitUsdCents
                : SPENDING_LIMIT.DEFAULT_USD * 100,
            currentMonthStart: now.toISOString().split('T')[0],
            updatedAt: now,
          })
          .where(eq(customers.walletAddress, userAddress))
          .returning();
      }
    }

    // Deposit funds (add to balance)
    await db
      .update(customers)
      .set({
        currentBalanceUsdCents: (customer.currentBalanceUsdCents ?? 0) + amountUsdcCents,
        updatedAt: new Date(),
      })
      .where(eq(customers.walletAddress, userAddress));

    return {
      digest: this.generateMockTxDigest(),
      success: true,
      accountCreated,
      checkpoint: Date.now(),
      gasUsed: 0, // Mock has no gas
    };
  }

  /**
   * Withdraw funds from account
   * Auto-creates account if it doesn't exist (with zero balance)
   */
  async withdraw(params: WithdrawParams): Promise<TransactionResult> {
    const { userAddress, amountUsdcCents, initialSpendingLimitUsdCents } = params;

    // Check if account exists
    let customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    let accountCreated = false;

    if (!customer || !customer.escrowContractId) {
      // Account doesn't exist - create it with zero balance
      accountCreated = true;
      const now = new Date();
      const accountAddress = this.generateMockAccountAddress();

      if (!customer) {
        const customerId = this.generateCustomerId();
        [customer] = await db.insert(customers).values({
          customerId,
          walletAddress: userAddress,
          escrowContractId: accountAddress,
          status: 'active',
          currentBalanceUsdCents: 0,
          maxMonthlyUsdCents:
            initialSpendingLimitUsdCents !== undefined
              ? initialSpendingLimitUsdCents
              : SPENDING_LIMIT.DEFAULT_USD * 100,
          currentMonthChargedUsdCents: 0,
          lastMonthChargedUsdCents: 0,
          currentMonthStart: now.toISOString().split('T')[0],
          createdAt: now,
          updatedAt: now,
        }).returning();
      } else {
        [customer] = await db
          .update(customers)
          .set({
            escrowContractId: accountAddress,
            maxMonthlyUsdCents:
              initialSpendingLimitUsdCents !== undefined
                ? initialSpendingLimitUsdCents
                : SPENDING_LIMIT.DEFAULT_USD * 100,
            currentMonthStart: now.toISOString().split('T')[0],
            updatedAt: now,
          })
          .where(eq(customers.walletAddress, userAddress))
          .returning();
      }
    }

    // Check sufficient balance
    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (currentBalance < amountUsdcCents) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Insufficient balance: have ${currentBalance / 100} USD, need ${amountUsdcCents / 100} USD`,
        accountCreated,
      };
    }

    // Withdraw funds (subtract from balance)
    await db
      .update(customers)
      .set({
        currentBalanceUsdCents: currentBalance - amountUsdcCents,
        updatedAt: new Date(),
      })
      .where(eq(customers.walletAddress, userAddress));

    return {
      digest: this.generateMockTxDigest(),
      success: true,
      accountCreated,
      checkpoint: Date.now(),
      gasUsed: 0,
    };
  }

  /**
   * Charge user account (Suiftly backend only)
   * Enforces 28-day spending limit
   * Does NOT auto-create account
   */
  async charge(params: ChargeParams): Promise<TransactionResult> {
    const { userAddress, amountUsdCents, description } = params;

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    if (!customer || !customer.escrowContractId) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Account does not exist',
      };
    }

    // Check if 28-day period has elapsed
    const now = Date.now();
    const periodStart = customer.currentMonthStart
      ? new Date(customer.currentMonthStart).getTime()
      : now;
    const elapsed = now - periodStart;

    let currentPeriodCharged = customer.currentMonthChargedUsdCents ?? 0;
    let needsPeriodReset = false;

    if (elapsed >= PERIOD_DURATION_MS) {
      // Period has elapsed - reset
      currentPeriodCharged = 0;
      needsPeriodReset = true;
    }

    // Check spending limit (0 = unlimited)
    const spendingLimit = customer.maxMonthlyUsdCents ?? SPENDING_LIMIT.DEFAULT_USD * 100;
    if (spendingLimit > 0 && currentPeriodCharged + amountUsdCents > spendingLimit) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Would exceed 28-day spending limit: ${spendingLimit / 100} USD (current: ${currentPeriodCharged / 100} USD, charge: ${amountUsdCents / 100} USD)`,
      };
    }

    // Check sufficient balance
    const currentBalance = customer.currentBalanceUsdCents ?? 0;
    if (currentBalance < amountUsdCents) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Insufficient balance: have ${currentBalance / 100} USD, need ${amountUsdCents / 100} USD`,
      };
    }

    // Apply charge
    const updateData: any = {
      currentBalanceUsdCents: currentBalance - amountUsdCents,
      currentMonthChargedUsdCents: currentPeriodCharged + amountUsdCents,
      updatedAt: new Date(),
    };

    if (needsPeriodReset) {
      updateData.currentMonthStart = new Date().toISOString().split('T')[0];
      updateData.lastMonthChargedUsdCents = customer.currentMonthChargedUsdCents ?? 0;
    }

    await db
      .update(customers)
      .set(updateData)
      .where(eq(customers.walletAddress, userAddress));

    return {
      digest: this.generateMockTxDigest(),
      success: true,
      checkpoint: Date.now(),
      gasUsed: 0,
    };
  }

  /**
   * Credit user account (refund)
   * Does NOT auto-create account
   */
  async credit(params: ChargeParams): Promise<TransactionResult> {
    const { userAddress, amountUsdCents, description } = params;

    const customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    if (!customer || !customer.escrowContractId) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: 'Account does not exist',
      };
    }

    // Add to balance
    await db
      .update(customers)
      .set({
        currentBalanceUsdCents: (customer.currentBalanceUsdCents ?? 0) + amountUsdCents,
        updatedAt: new Date(),
      })
      .where(eq(customers.walletAddress, userAddress));

    return {
      digest: this.generateMockTxDigest(),
      success: true,
      checkpoint: Date.now(),
      gasUsed: 0,
    };
  }

  /**
   * Update spending limit
   * Auto-creates account if it doesn't exist
   */
  async updateSpendingLimit(params: UpdateSpendingLimitParams): Promise<TransactionResult> {
    const { userAddress, newLimitUsdCents } = params;

    // Validate limit
    if (newLimitUsdCents > 0 && newLimitUsdCents < SPENDING_LIMIT.MINIMUM_USD * 100) {
      return {
        digest: this.generateMockTxDigest(),
        success: false,
        error: `Spending limit must be at least ${SPENDING_LIMIT.MINIMUM_USD} USD or 0 (unlimited)`,
      };
    }

    let customer = await db.query.customers.findFirst({
      where: eq(customers.walletAddress, userAddress),
    });

    let accountCreated = false;

    if (!customer || !customer.escrowContractId) {
      // Account doesn't exist - create it
      accountCreated = true;
      const now = new Date();
      const accountAddress = this.generateMockAccountAddress();

      if (!customer) {
        const customerId = this.generateCustomerId();
        await db.insert(customers).values({
          customerId,
          walletAddress: userAddress,
          escrowContractId: accountAddress,
          status: 'active',
          currentBalanceUsdCents: 0,
          maxMonthlyUsdCents: newLimitUsdCents,
          currentMonthChargedUsdCents: 0,
          lastMonthChargedUsdCents: 0,
          currentMonthStart: now.toISOString().split('T')[0],
          createdAt: now,
          updatedAt: now,
        });
      } else {
        await db
          .update(customers)
          .set({
            escrowContractId: accountAddress,
            maxMonthlyUsdCents: newLimitUsdCents,
            currentMonthStart: now.toISOString().split('T')[0],
            updatedAt: now,
          })
          .where(eq(customers.walletAddress, userAddress));
      }
    } else {
      // Update existing account
      await db
        .update(customers)
        .set({
          maxMonthlyUsdCents: newLimitUsdCents,
          updatedAt: new Date(),
        })
        .where(eq(customers.walletAddress, userAddress));
    }

    return {
      digest: this.generateMockTxDigest(),
      success: true,
      accountCreated,
      checkpoint: Date.now(),
      gasUsed: 0,
    };
  }

  /**
   * Build transaction for user signature
   * Mock returns null (no signing needed)
   */
  async buildTransaction(
    operation: 'deposit' | 'withdraw' | 'updateSpendingLimit',
    params: any
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
   * Generate customer ID (random 32-bit integer)
   */
  private generateCustomerId(): number {
    return Math.floor(Math.random() * 4294967295) + 1;
  }
}

/**
 * Singleton instance
 */
export const mockSuiService = new MockSuiService();
