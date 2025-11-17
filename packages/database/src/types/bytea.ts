/**
 * Custom BYTEA column type for Drizzle ORM
 *
 * PostgreSQL BYTEA type for storing binary data (Sui addresses, transaction digests, etc.)
 *
 * Usage:
 * ```ts
 * import { bytea } from '../types/bytea';
 *
 * export const myTable = pgTable('my_table', {
 *   suiAddress: bytea('sui_address').notNull(),
 *   txDigest: bytea('tx_digest'),
 * });
 * ```
 */

import { customType } from 'drizzle-orm/pg-core';

export const bytea = customType<{
  data: Buffer;
  driverData: Buffer | string;
}>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
  fromDriver(value: Buffer | string): Buffer {
    // PostgreSQL node driver may return bytea as escape-formatted string (e.g., "\xc6f012...")
    // instead of Buffer, depending on configuration. Handle both cases.
    if (Buffer.isBuffer(value)) {
      return value;
    }

    // Convert PostgreSQL escape format to Buffer
    // Format is: \x followed by hex digits (e.g., "\xc6f0123...")
    if (typeof value === 'string' && value.startsWith('\\x')) {
      return Buffer.from(value.slice(2), 'hex');
    }

    // Fallback: treat as hex string without \x prefix
    if (typeof value === 'string') {
      return Buffer.from(value, 'hex');
    }

    // Should not reach here, but return empty buffer as safety
    return Buffer.alloc(0);
  },
});
