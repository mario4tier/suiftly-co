/**
 * Sui Service Factory
 *
 * Returns the appropriate ISuiService implementation based on environment
 * - Development/Test: Mock service
 * - Production: Real Sui blockchain service (to be implemented)
 */

import type { ISuiService } from './interface';
import { mockSuiService } from './mock';

/**
 * Get Sui service instance
 * Returns mock for now, will return real implementation in production later
 */
export function getSuiService(): ISuiService {
  // For now, always return mock
  // TODO: In production, check environment variable and return real service
  // if (process.env.NODE_ENV === 'production' && !process.env.USE_MOCK_SUI) {
  //   return realSuiService;
  // }
  return mockSuiService;
}

/**
 * Export types for use in other modules
 */
export type { ISuiService } from './interface';
export type {
  EscrowAccount,
  TransactionResult,
  DepositParams,
  WithdrawParams,
  ChargeParams,
  UpdateSpendingLimitParams,
  SpendingLimitCheck,
} from './interface';
