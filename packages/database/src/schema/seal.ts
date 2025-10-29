import { pgTable, uuid, integer, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { customers } from './customers';

export const sealKeys = pgTable('seal_keys', {
  sealKeyId: uuid('seal_key_id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  publicKey: varchar('public_key', { length: 66 }).notNull(),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  purchaseTxDigest: varchar('purchase_tx_digest', { length: 64 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxSealCustomer: index('idx_seal_customer').on(table.customerId),
}));
