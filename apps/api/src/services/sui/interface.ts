/**
 * Sui Service Interface
 *
 * Re-exports from @suiftly/shared for backwards compatibility.
 * The actual types are defined in packages/shared/src/sui-service/types.ts
 * to avoid circular dependencies between packages.
 *
 * See ESCROW_DESIGN.md for complete documentation.
 */

// Re-export all types from shared package
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
