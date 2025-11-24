/**
 * Sui Service Interface Types
 *
 * These types define the contract for blockchain escrow operations.
 * Moved to shared package to avoid circular dependencies.
 *
 * Both mock and real implementations conform to these interfaces.
 */

import type { Transaction } from '@mysten/sui/transactions';

/**
 * Escrow account state
 * Represents the on-chain Account object state
 */
export interface EscrowAccount {
  /** Shared object address of the escrow account */
  accountAddress: string;
  /** User's wallet address (has capability) */
  userAddress: string;
  /** Suiftly backend address (has capability) */
  suiftlyAddress: string;
  /** Balance in USDC (MVP: integer cents) */
  balanceUsdCents: number;
  /** 28-day spending limit in USD cents (0 = unlimited) */
  spendingLimitUsdCents: number;
  /** Amount charged in current 28-day period (USD cents) */
  currentPeriodChargedUsdCents: number;
  /** Timestamp when current 28-day period started (milliseconds) */
  currentPeriodStartMs: number;
  /** Optional tracking object address (owned by user) */
  trackingObjectAddress?: string;
}

/**
 * Transaction result
 * Returned after blockchain transaction submission
 */
export interface TransactionResult {
  /** Transaction digest/hash */
  digest: string;
  /** Was transaction successful? */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Block height/checkpoint */
  checkpoint?: number;
  /** Gas used */
  gasUsed?: number;
  /** Account was created as part of this transaction */
  accountCreated?: boolean;
  /**
   * When account is created, contains the three object addresses
   */
  createdObjects?: {
    escrowAddress: string;
    userTrackingAddress: string;
    suiftlyTrackingAddress: string;
  };
}

/**
 * Deposit parameters
 */
export interface DepositParams {
  userAddress: string;
  amountUsdCents: number;
  initialSpendingLimitUsdCents?: number;
  escrowAddress?: string;
}

/**
 * Withdrawal parameters
 */
export interface WithdrawParams {
  userAddress: string;
  amountUsdCents: number;
  initialSpendingLimitUsdCents?: number;
  escrowAddress?: string;
}

/**
 * Charge parameters (Suiftly-initiated)
 */
export interface ChargeParams {
  userAddress: string;
  amountUsdCents: number;
  description: string;
  escrowAddress: string;
}

/**
 * Spending limit update parameters
 */
export interface UpdateSpendingLimitParams {
  userAddress: string;
  newLimitUsdCents: number;
  escrowAddress?: string;
}

/**
 * Transaction history entry
 */
export interface TransactionHistoryEntry {
  txDigest: string;
  txType: 'deposit' | 'withdraw' | 'charge' | 'credit';
  amountUsdCents: number;
  description?: string;
  success: boolean;
  error?: string;
  checkpoint?: number;
  balanceAfterUsdCents?: number;
  timestamp: Date;
}

/**
 * Spending limit validation result
 */
export interface SpendingLimitCheck {
  allowed: boolean;
  currentPeriodCharged: number;
  limit: number;
  attemptedCharge: number;
  remaining: number;
  periodEndsAt: number;
  reason?: string;
}

/**
 * Sui Service Interface
 *
 * Contract for blockchain escrow operations.
 * Both mock and real implementations must conform to this interface.
 */
export interface ISuiService {
  getAccount(userAddress: string): Promise<EscrowAccount | null>;
  syncAccount(userAddress: string): Promise<EscrowAccount | null>;
  deposit(params: DepositParams): Promise<TransactionResult>;
  withdraw(params: WithdrawParams): Promise<TransactionResult>;
  charge(params: ChargeParams): Promise<TransactionResult>;
  credit(params: ChargeParams): Promise<TransactionResult>;
  updateSpendingLimit(params: UpdateSpendingLimitParams): Promise<TransactionResult>;
  buildTransaction(operation: 'deposit' | 'withdraw' | 'updateSpendingLimit', params: any): Promise<Transaction | null>;
  isMock(): boolean;
  getTransactionHistory(userAddress: string, limit?: number): Promise<TransactionHistoryEntry[]>;
}
