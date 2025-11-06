/**
 * Sui Service Interface
 *
 * This interface defines the contract for interacting with the Sui blockchain
 * for escrow operations. Both mock and real implementations MUST conform to this interface.
 *
 * CRITICAL DESIGN PRINCIPLES:
 * 1. Blockchain smart contract is the ONLY source of truth
 * 2. Users can deposit/withdraw directly via other wallets or interfaces
 * 3. Our API MUST always query on-chain state and handle any account state
 * 4. We do NOT assume we control the account lifecycle
 * 5. ALL operations at this layer are ON-CHAIN (or simulated on-chain for mock)
 *    - Any off-chain batching optimizations happen in higher business logic layers
 * 6. User-initiated operations automatically create account if it doesn't exist
 *    - Reduces user friction (one signature instead of two)
 *    - Real implementation uses PTB (Programmable Transaction Block) to do create+operation atomically
 *    - Mock implementation simulates this behavior
 *
 * Based on ESCROW_DESIGN.md:
 * - Per-user shared object escrow model
 * - USDC-only for MVP (1:1 USD peg)
 * - 28-day rolling spending limit (default $250, min $10, unlimited allowed)
 * - Dual capabilities (user + Suiftly)
 * - Account can be created by anyone (user, our API, other wallet)
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
  balanceUsdcCents: number;
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
}

/**
 * Deposit parameters
 */
export interface DepositParams {
  /** User's wallet address */
  userAddress: string;
  /** Amount to deposit in USDC cents */
  amountUsdcCents: number;
  /** Initial spending limit if account doesn't exist (USD cents, 0 = unlimited) */
  initialSpendingLimitUsdCents?: number;
}

/**
 * Withdrawal parameters
 */
export interface WithdrawParams {
  /** User's wallet address */
  userAddress: string;
  /** Amount to withdraw in USDC cents */
  amountUsdcCents: number;
  /** Initial spending limit if account doesn't exist (USD cents, 0 = unlimited) */
  initialSpendingLimitUsdCents?: number;
}

/**
 * Charge parameters (Suiftly-initiated)
 */
export interface ChargeParams {
  /** User's wallet address */
  userAddress: string;
  /** Amount to charge in USD cents */
  amountUsdCents: number;
  /** Description for ledger */
  description: string;
}

/**
 * Spending limit update parameters
 */
export interface UpdateSpendingLimitParams {
  /** User's wallet address */
  userAddress: string;
  /** New spending limit in USD cents (0 = unlimited) */
  newLimitUsdCents: number;
}

/**
 * Sui Service Interface
 *
 * Implementation notes:
 * - Mock: Stores state in PostgreSQL, simulates blockchain behavior
 * - Real: Interacts with actual Sui blockchain, smart contracts
 *
 * Both implementations MUST:
 * - Query blockchain as source of truth (not trust our database)
 * - Handle 28-day period resets automatically
 * - Enforce spending limits
 * - Validate sufficient balance before operations
 * - Handle accounts created outside our system
 * - Treat all operations as ON-CHAIN blockchain transactions
 * - Auto-create account when user-initiated operation is called and account doesn't exist
 */
export interface ISuiService {
  /**
   * Get escrow account for user
   * Returns null if account doesn't exist yet
   *
   * IMPORTANT: Always queries blockchain/mock state, never trusts cached data
   *
   * @param userAddress - User's wallet address
   * @returns Account state or null if not found
   */
  getAccount(userAddress: string): Promise<EscrowAccount | null>;

  /**
   * Sync account state to our database
   * Called after detecting on-chain changes (deposits, withdrawals, etc.)
   * Updates our database cache to match blockchain reality
   *
   * @param userAddress - User's wallet address
   * @returns Updated account state
   */
  syncAccount(userAddress: string): Promise<EscrowAccount | null>;

  /**
   * Deposit funds to account
   *
   * ON-CHAIN operation (blockchain transaction or mock simulation)
   *
   * AUTOMATIC ACCOUNT CREATION:
   * If account doesn't exist, creates it automatically before depositing.
   * - Mock: Creates mock account state in database, then deposits
   * - Real: Uses PTB (Programmable Transaction Block) to execute
   *         create_account_and_deposit() in single transaction
   * - Default spending limit: $250/28 days (see CONSTANTS.md)
   * - Can override with initialSpendingLimitUsdCents parameter
   *
   * This reduces user friction (one signature instead of two).
   *
   * @param params - Deposit parameters
   * @returns Transaction result with accountCreated flag
   */
  deposit(params: DepositParams): Promise<TransactionResult>;

  /**
   * Withdraw funds from account
   *
   * ON-CHAIN operation (blockchain transaction or mock simulation)
   *
   * AUTOMATIC ACCOUNT CREATION:
   * If account doesn't exist, creates it automatically with zero balance.
   * This allows withdrawal to work even if account was just created by someone else
   * but our database hasn't synced yet.
   *
   * User can withdraw full balance (no minimum enforced)
   *
   * @param params - Withdrawal parameters
   * @returns Transaction result with accountCreated flag
   * @throws If insufficient balance
   */
  withdraw(params: WithdrawParams): Promise<TransactionResult>;

  /**
   * Charge user account (Suiftly backend only)
   *
   * ON-CHAIN operation (blockchain transaction or mock simulation)
   *
   * Enforces 28-day spending limit at smart contract level
   * Automatically resets period if 28 days elapsed
   *
   * NOTE: Does NOT create account automatically. If account doesn't exist,
   * charge fails. This is intentional - we only charge existing customers.
   *
   * Real implementation: Calls smart contract charge() function
   * Mock implementation: Updates mock state in database
   *
   * Future optimization (NOT in this layer):
   * A higher business logic layer MAY batch multiple small charges
   * and periodically settle them by calling this method.
   *
   * @param params - Charge parameters
   * @returns Transaction result
   * @throws If would exceed spending limit, insufficient balance, or account doesn't exist
   */
  charge(params: ChargeParams): Promise<TransactionResult>;

  /**
   * Credit user account (Suiftly backend only)
   *
   * ON-CHAIN operation (blockchain transaction or mock simulation)
   *
   * Used for refunds
   *
   * NOTE: Does NOT create account automatically. If account doesn't exist,
   * credit fails. This is intentional - we only credit existing customers.
   *
   * @param params - Charge parameters (amount will be added)
   * @returns Transaction result
   * @throws If account doesn't exist
   */
  credit(params: ChargeParams): Promise<TransactionResult>;

  /**
   * Update spending limit (user-initiated)
   *
   * ON-CHAIN operation (blockchain transaction or mock simulation)
   *
   * AUTOMATIC ACCOUNT CREATION:
   * If account doesn't exist, creates it with the specified spending limit.
   *
   * Requires wallet signature in real implementation
   *
   * @param params - Spending limit update parameters
   * @returns Transaction result with accountCreated flag
   */
  updateSpendingLimit(params: UpdateSpendingLimitParams): Promise<TransactionResult>;

  /**
   * Build transaction for user signature (real implementation only)
   * Mock returns null since no actual signing needed
   *
   * This is used when user needs to sign a blockchain transaction:
   * 1. Frontend calls this to get transaction bytes
   * 2. User signs with wallet
   * 3. Frontend submits signed transaction
   *
   * Real implementation will use PTB (Programmable Transaction Block) to combine
   * account creation + intended operation when account doesn't exist.
   *
   * @param operation - Operation type
   * @param params - Operation parameters
   * @returns Transaction bytes to sign, or null if mock
   */
  buildTransaction(
    operation: 'deposit' | 'withdraw' | 'updateSpendingLimit',
    params: any
  ): Promise<Transaction | null>;

  /**
   * Check if this is the mock implementation
   * Useful for conditional logic in UI (e.g., showing mock badge)
   *
   * @returns True if mock, false if real
   */
  isMock(): boolean;
}

/**
 * Spending limit validation result
 */
export interface SpendingLimitCheck {
  /** Can the charge be applied? */
  allowed: boolean;
  /** Current period charged amount (USD cents) */
  currentPeriodCharged: number;
  /** Spending limit (USD cents, 0 = unlimited) */
  limit: number;
  /** Amount that would be charged (USD cents) */
  attemptedCharge: number;
  /** Amount remaining in period (USD cents) */
  remaining: number;
  /** When does current period end? (milliseconds) */
  periodEndsAt: number;
  /** Reason if not allowed */
  reason?: string;
}
