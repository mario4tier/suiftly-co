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
  driverData: Buffer;
}>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Buffer): Buffer {
    return value;
  },
  fromDriver(value: Buffer): Buffer {
    return value;
  },
});
