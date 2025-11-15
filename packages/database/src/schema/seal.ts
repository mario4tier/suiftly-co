import { pgTable, serial, integer, text, boolean, timestamp, index, check } from 'drizzle-orm/pg-core';
import { bytea } from '../types/bytea';
import { relations, sql } from 'drizzle-orm';
import { customers } from './customers';
import { serviceInstances } from './services';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

export const sealKeys = pgTable('seal_keys', {
  sealKeyId: serial('seal_key_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  instanceId: integer('instance_id').references(() => serviceInstances.instanceId, { onDelete: 'cascade' }),

  // Optional user-defined name (64 chars max for DNS/Kubernetes compatibility)
  name: text('name'),

  // Derived keys: store derivation_index (can regenerate from MASTER_SEED)
  // Imported keys: derivation_index is NULL, must store encrypted_private_key
  derivationIndex: integer('derivation_index'),

  // Encrypted private key (32 bytes BLS12-381 scalar)
  // NULL for derived keys (can regenerate), required for imported keys
  encryptedPrivateKey: text('encrypted_private_key'),

  // BLS12-381 master public key for IBE (mpk)
  // Typically 48 bytes (G1 point, compressed) for Boneh-Franklin IBE
  // Registered on-chain for client encryption operations
  publicKey: bytea('public_key').notNull(),

  // Sui blockchain object ID for key server registration (32 bytes)
  // NULL until on-chain registration succeeds
  objectId: bytea('object_id'),

  // On-chain registration transaction digest (32 bytes)
  registerTxnDigest: bytea('register_txn_digest'),

  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxSealCustomer: index('idx_seal_customer').on(table.customerId),
  idxSealInstance: index('idx_seal_instance').on(table.instanceId),
  idxSealPublicKey: index('idx_seal_public_key').on(table.publicKey),
  idxSealObjectId: index('idx_seal_object_id').on(table.objectId),

  // Constraint: name must be 64 chars or less (DNS/K8s compatible)
  checkNameLength: check('check_name_length',
    sql`${table.name} IS NULL OR LENGTH(${table.name}) <= 64`),

  // Constraint: public_key must be 48 or 96 bytes (G1 or G2)
  checkPublicKeyLength: check('check_public_key_length',
    sql`LENGTH(${table.publicKey}) IN (48, 96)`),

  // Constraint: object_id must be 32 bytes if present
  checkObjectIdLength: check('check_object_id_length',
    sql`${table.objectId} IS NULL OR LENGTH(${table.objectId}) = 32`),

  // Constraint: register_txn_digest must be 32 bytes if present
  checkRegisterTxnDigestLength: check('check_register_txn_digest_length',
    sql`${table.registerTxnDigest} IS NULL OR LENGTH(${table.registerTxnDigest}) = 32`),

  // Constraint: exactly one of derivation_index or encrypted_private_key must be present
  checkKeySource: check('check_key_source',
    sql`(${table.derivationIndex} IS NOT NULL AND ${table.encryptedPrivateKey} IS NULL) OR
        (${table.derivationIndex} IS NULL AND ${table.encryptedPrivateKey} IS NOT NULL)`),
}));

export const sealPackages = pgTable('seal_packages', {
  packageId: serial('package_id').primaryKey(),
  sealKeyId: integer('seal_key_id').notNull().references(() => sealKeys.sealKeyId, { onDelete: 'cascade' }),
  packageAddress: bytea('package_address').notNull(),

  // Optional user-defined name (64 chars max for DNS/Kubernetes compatibility)
  name: text('name'),

  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  idxPackageSealKey: index('idx_package_seal_key').on(table.sealKeyId),
  idxPackageAddress: index('idx_package_address').on(table.packageAddress),

  // Constraint: package_address must be 32 bytes
  checkPackageAddressLength: check('check_package_address_length',
    sql`LENGTH(${table.packageAddress}) = 32`),

  // Constraint: name must be 64 chars or less (DNS/K8s compatible)
  checkNameLength: check('check_name_length',
    sql`${table.name} IS NULL OR LENGTH(${table.name}) <= 64`),
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
