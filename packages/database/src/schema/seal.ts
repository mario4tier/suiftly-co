import { pgTable, pgEnum, serial, integer, text, boolean, timestamp, index, check } from 'drizzle-orm/pg-core';
import { bytea } from '../types/bytea';
import { relations, sql } from 'drizzle-orm';
import { customers } from './customers';
import { serviceInstances } from './services';
import { sealOpTypeEnum, sealOpStatusEnum } from './enums';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

/**
 * Registration status for seal keys on the Sui blockchain.
 *
 * State machine:
 * - 'registering': Initial registration in progress (KeyServer object being created)
 * - 'registered': Successfully registered on-chain (object_id is set)
 * - 'updating': Re-registration in progress (packages changed while registered)
 *
 * No 'pending' state - keys auto-queue registration on creation.
 * No 'failed' state - unlimited auto-retry with exponential backoff.
 */
export const registrationStatusEnum = pgEnum('seal_registration_status', [
  'registering',   // Initial registration in progress
  'registered',    // Successfully registered on-chain
  'updating',      // Re-registration in progress (packages changed)
]);

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

  // Process group for key derivation (1=production, 2=development)
  // Keys in different PGs use different master seeds, providing
  // cryptographic isolation between environments
  processGroup: integer('process_group').notNull().default(1),

  // ============================================================================
  // Registration State Machine
  // ============================================================================

  // Current registration status (see registrationStatusEnum for state machine)
  // Auto-starts as 'registering' on key creation
  registrationStatus: registrationStatusEnum('registration_status')
    .notNull()
    .default('registering'),

  // Last error message from registration attempt (for debugging)
  // Cleared on successful registration
  registrationError: text('registration_error'),

  // Number of registration attempts (for exponential backoff calculation)
  registrationAttempts: integer('registration_attempts')
    .notNull()
    .default(0),

  // When the last registration attempt started
  lastRegistrationAttemptAt: timestamp('last_registration_attempt_at', { withTimezone: true }),

  // When to retry registration (exponential backoff)
  // NULL = immediate retry allowed, non-NULL = wait until this time
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

  // Version counter for package changes (incremented when packages added/removed)
  // Used to detect if packages changed during registration
  packagesVersion: integer('packages_version')
    .notNull()
    .default(0),

  // Package version at last successful registration
  // NULL = never registered, set on successful registration
  // If packagesVersion > registeredPackagesVersion, an update is needed
  registeredPackagesVersion: integer('registered_packages_version'),

  isUserEnabled: boolean('is_user_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // Soft delete timestamp - derivation indices are NEVER recycled
  // Even "deleted" keys retain their index to prevent index reuse
  // NULL = active, non-NULL = soft deleted
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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

  isUserEnabled: boolean('is_user_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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

/**
 * Seal Registration Operations Queue
 *
 * Tracks async Sui blockchain registration operations for seal keys.
 * GM periodically polls this table and processes queued operations.
 *
 * Operation types:
 * - 'register': Initial KeyServer object creation on Sui
 * - 'update': Re-registration when packages change
 *
 * Status flow: queued → processing → completed
 * On failure: status reverts to 'queued' with incremented attemptCount
 */
export const sealRegistrationOps = pgTable('seal_registration_ops', {
  opId: serial('op_id').primaryKey(),
  sealKeyId: integer('seal_key_id')
    .notNull()
    .references(() => sealKeys.sealKeyId, { onDelete: 'cascade' }),

  // Denormalized for GM efficiency (avoids joins during polling)
  customerId: integer('customer_id').notNull(),
  network: text('network').notNull(),  // 'mainnet' | 'testnet'

  // Operation type and status
  opType: sealOpTypeEnum('op_type').notNull(),
  status: sealOpStatusEnum('status').notNull(),

  // Package version at the time this op was created
  // Used to detect if more changes occurred during processing
  packagesVersionAtOp: integer('packages_version_at_op').notNull(),

  // Retry tracking (exponential backoff)
  attemptCount: integer('attempt_count').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),  // NULL = immediate retry OK

  // Results (set on completion)
  txDigest: bytea('tx_digest'),     // Sui transaction digest (32 bytes)
  objectId: bytea('object_id'),     // KeyServer object ID (32 bytes, for 'register' ops)
  errorMessage: text('error_message'),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),      // When processing began
  completedAt: timestamp('completed_at', { withTimezone: true }),  // When completed (success or final state)
}, (table) => ({
  // Index for efficient GM polling: find queued ops ready to process
  idxRegOpsQueued: index('idx_seal_reg_ops_queued')
    .on(table.status, table.nextRetryAt, table.createdAt),

  // Index for looking up ops by seal key
  idxRegOpsSealKey: index('idx_seal_reg_ops_seal_key')
    .on(table.sealKeyId),

  // Constraint: tx_digest must be 32 bytes if present
  checkTxDigestLength: check('check_tx_digest_length',
    sql`${table.txDigest} IS NULL OR LENGTH(${table.txDigest}) = 32`),

  // Constraint: object_id must be 32 bytes if present
  checkObjectIdLength: check('check_op_object_id_length',
    sql`${table.objectId} IS NULL OR LENGTH(${table.objectId}) = 32`),
}));

// Relations
export const sealKeysRelations = relations(sealKeys, ({ many }) => ({
  packages: many(sealPackages),
  registrationOps: many(sealRegistrationOps),
}));

export const sealPackagesRelations = relations(sealPackages, ({ one }) => ({
  sealKey: one(sealKeys, {
    fields: [sealPackages.sealKeyId],
    references: [sealKeys.sealKeyId],
  }),
}));

export const sealRegistrationOpsRelations = relations(sealRegistrationOps, ({ one }) => ({
  sealKey: one(sealKeys, {
    fields: [sealRegistrationOps.sealKeyId],
    references: [sealKeys.sealKeyId],
  }),
}));
