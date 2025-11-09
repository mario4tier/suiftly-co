import { pgTable, varchar, integer, jsonb, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

export const apiKeys = pgTable('api_keys', {
  apiKeyId: varchar('api_key_id', { length: 100 }).primaryKey(),
  apiKeyFp: varchar('api_key_fp', { length: 64 }).notNull(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: varchar('service_type', { length: 20 }).notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  idxCustomerService: index('idx_customer_service').on(table.customerId, table.serviceType, table.isActive),
  idxApiKeyFp: index('idx_api_key_fp').on(table.apiKeyFp).where(sql`${table.isActive} = true`),
}));
