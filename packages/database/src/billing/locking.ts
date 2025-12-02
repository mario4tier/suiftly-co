/**
 * Billing Locking Re-exports
 *
 * Re-exports from top-level locking module for backwards compatibility.
 * All locking utilities now live in packages/database/src/locking.ts
 *
 * For new code, prefer importing directly from '@suiftly/database':
 * ```typescript
 * import { withCustomerLockForAPI, LockedTransaction } from '@suiftly/database';
 * ```
 */

// Re-export everything from top-level locking
export {
  type LockedTransaction,
  withCustomerLockForAPI,
  withCustomerLock,
  tryCustomerLock,
  unsafeAsLockedTransaction,
} from '../locking';
