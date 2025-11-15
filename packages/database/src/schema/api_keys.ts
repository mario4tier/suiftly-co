import { pgTable, varchar, integer, jsonb, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { FIELD_LIMITS } from '@suiftly/shared/constants';
import { serviceTypeEnum } from './enums';

export const apiKeys = pgTable('api_keys', {
  apiKeyFp: integer('api_key_fp').primaryKey(),  // 32-bit fingerprint (signed, stores unsigned values)
  apiKeyId: varchar('api_key_id', { length: FIELD_LIMITS.API_KEY_ID }).notNull(),  // Encrypted: IV:authTag:ciphertext (~102 chars)
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  uniqueApiKeyId: unique('api_keys_api_key_id_unique').on(table.apiKeyId),
  idxCustomerService: index('idx_customer_service').on(table.customerId, table.serviceType, table.isActive),
  // Note: No index on api_key_fp needed - PRIMARY KEY is automatically indexed
}));
