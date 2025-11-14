import { pgTable, uuid, integer, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { customers } from './customers';
import { serviceInstances } from './services';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

export const sealKeys = pgTable('seal_keys', {
  sealKeyId: uuid('seal_key_id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  instanceId: integer('instance_id').references(() => serviceInstances.instanceId, { onDelete: 'cascade' }),
  publicKey: varchar('public_key', { length: FIELD_LIMITS.SUI_PUBLIC_KEY }).notNull(),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  purchaseTxDigest: varchar('purchase_tx_digest', { length: FIELD_LIMITS.SUI_TX_DIGEST }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxSealCustomer: index('idx_seal_customer').on(table.customerId),
  idxSealInstance: index('idx_seal_instance').on(table.instanceId),
}));

export const sealPackages = pgTable('seal_packages', {
  packageId: uuid('package_id').primaryKey().defaultRandom(),
  sealKeyId: uuid('seal_key_id').notNull().references(() => sealKeys.sealKeyId, { onDelete: 'cascade' }),
  packageAddress: varchar('package_address', { length: FIELD_LIMITS.SUI_ADDRESS }).notNull(),
  name: varchar('name', { length: FIELD_LIMITS.PACKAGE_NAME }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxPackageSealKey: index('idx_package_seal_key').on(table.sealKeyId),
}));

// Relations
export const sealKeysRelations = relations(sealKeys, ({ many }) => ({
  packages: many(sealPackages),
}));

export const sealPackagesRelations = relations(sealPackages, ({ one }) => ({
  sealKey: one(sealKeys, {
    fields: [sealPackages.sealKeyId],
    references: [sealKeys.sealKeyId],
  }),
}));
