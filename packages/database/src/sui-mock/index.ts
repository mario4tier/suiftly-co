/**
 * Sui Mock Service
 *
 * Mock implementation of ISuiService for development and testing.
 * Uses PostgreSQL to simulate blockchain state.
 *
 * Usage:
 *   import { getSuiService } from '@suiftly/database/sui-mock';
 *   const suiService = getSuiService();
 */

import type { ISuiService } from '@suiftly/shared/sui-service';
import { mockSuiService } from './mock.js';

export { suiMockConfig } from './mock-config.js';
export type { SuiMockConfig } from './mock-config.js';
export { MockSuiService, mockSuiService } from './mock.js';

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
 * Re-export types for convenience
 */
export type {
  ISuiService,
  EscrowAccount,
  TransactionResult,
  DepositParams,
  WithdrawParams,
  ChargeParams,
  UpdateSpendingLimitParams,
  TransactionHistoryEntry,
  SpendingLimitCheck,
} from '@suiftly/shared/sui-service';
