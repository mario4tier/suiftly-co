import { pgTable, varchar, integer, bigint, jsonb, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { FIELD_LIMITS } from '@suiftly/shared/constants';
import { serviceTypeEnum } from './enums';

export const apiKeys = pgTable('api_keys', {
  apiKeyFp: bigint('api_key_fp', { mode: 'number' }).primaryKey(),  // 64-bit fingerprint (matches haproxy_raw_logs.api_key_fp)
  apiKeyId: varchar('api_key_id', { length: FIELD_LIMITS.API_KEY_ID }).notNull(),  // Encrypted: IV:authTag:ciphertext (~102 chars)
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  isUserEnabled: boolean('is_user_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ({
  uniqueApiKeyId: unique('api_keys_api_key_id_unique').on(table.apiKeyId),
  idxCustomerService: index('idx_customer_service').on(table.customerId, table.serviceType, table.isUserEnabled),
  // Note: No index on api_key_fp needed - PRIMARY KEY is automatically indexed
}));
