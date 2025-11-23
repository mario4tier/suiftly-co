/**
 * Database clock module exports
 *
 * Provides timestamp abstraction for database operations,
 * enabling deterministic testing of date-based business logic.
 */

// Types
export type { DBClock, MockDBClockConfig } from './types';

// Implementations
export { RealDBClock, realDBClock } from './real-clock';
export { MockDBClock } from './mock-clock';

// Provider and instances
export {
  DBClockProvider,
  dbClockProvider,
  dbClock,
  getDBClock,
} from './provider';