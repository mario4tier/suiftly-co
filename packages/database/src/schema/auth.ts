import { pgTable, varchar, serial, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { customers } from './customers';

export const authNonces = pgTable('auth_nonces', {
  address: varchar('address', { length: 66 }).primaryKey(),
  nonce: varchar('nonce', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxCreatedAt: index('idx_created_at').on(table.createdAt),
}));

export const refreshTokens = pgTable('refresh_tokens', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxRefreshCustomer: index('idx_refresh_customer').on(table.customerId),
  idxExpiresAt: index('idx_expires_at').on(table.expiresAt),
}));
