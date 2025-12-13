import { pgTable, integer, varchar, text, date, boolean, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Global configuration key-value store
 * Single source of truth for ALL system-wide settings:
 * - Frontend config (f* keys): tier pricing, bandwidth limits, feature flags
 * - Backend config (b* keys): system settings, operational parameters
 * - Tier configuration: fsubs_usd_{tier} (pricing), fbw_{tier} (bandwidth)
 *
 * Each key must be unique. Values are stored as strings.
 * Loaded into memory at server startup for O(1) lookups (see config-cache.ts).
 */
export const configGlobal = pgTable('config_global', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const processingState = pgTable('processing_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const systemControl = pgTable('system_control', {
  id: integer('id').primaryKey(),

  // Vault sequential versions (DB-authoritative, used in vault filenames)
  // 3-letter codes: {service}{network}{purpose} (e.g., sma = seal mainnet api)
  // Seal mainnet vaults
  smaVaultSeq: integer('sma_vault_seq').default(0),  // Seal mainnet API
  smmVaultSeq: integer('smm_vault_seq').default(0),  // Seal mainnet master
  smsVaultSeq: integer('sms_vault_seq').default(0),  // Seal mainnet seed
  smoVaultSeq: integer('smo_vault_seq').default(0),  // Seal mainnet open
  // Seal testnet vaults
  staVaultSeq: integer('sta_vault_seq').default(0),  // Seal testnet API
  stmVaultSeq: integer('stm_vault_seq').default(0),  // Seal testnet master
  stsVaultSeq: integer('sts_vault_seq').default(0),  // Seal testnet seed
  stoVaultSeq: integer('sto_vault_seq').default(0),  // Seal testnet open
  // Seal test/dev vault
  skkVaultSeq: integer('skk_vault_seq').default(0),  // Seal test/dev

  // Content hashes for change detection (first 16 chars of SHA-256)
  smaVaultContentHash: varchar('sma_vault_content_hash', { length: 16 }),
  smmVaultContentHash: varchar('smm_vault_content_hash', { length: 16 }),
  smsVaultContentHash: varchar('sms_vault_content_hash', { length: 16 }),
  smoVaultContentHash: varchar('smo_vault_content_hash', { length: 16 }),
  staVaultContentHash: varchar('sta_vault_content_hash', { length: 16 }),
  stmVaultContentHash: varchar('stm_vault_content_hash', { length: 16 }),
  stsVaultContentHash: varchar('sts_vault_content_hash', { length: 16 }),
  stoVaultContentHash: varchar('sto_vault_content_hash', { length: 16 }),
  skkVaultContentHash: varchar('skk_vault_content_hash', { length: 16 }),

  lastMonthlyReset: date('last_monthly_reset'),
  maintenanceMode: boolean('maintenance_mode').default(false),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  checkSingleton: check('check_singleton', sql`${table.id} = 1`),
}));

/**
 * Local Manager Status Table
 *
 * Tracks the status of each Local Manager (LM) in the fleet.
 * GM polls each LM's /api/health endpoint and stores results here.
 * Used to calculate sync status: customer is synced when
 * configChangeVaultSeq <= MIN(vaultSeq from all LMs where inSync=true)
 */
export const lmStatus = pgTable('lm_status', {
  lmId: varchar('lm_id', { length: 64 }).primaryKey(),
  displayName: varchar('display_name', { length: 128 }),
  host: varchar('host', { length: 256 }).notNull(),
  region: varchar('region', { length: 64 }),

  // Vault status (from LM health response)
  vaultType: varchar('vault_type', { length: 8 }),
  vaultSeq: integer('vault_seq').default(0),

  // Sync status (from LM health response)
  // inSync: Service operational (vault + HAProxy updated) - yellow indicator
  // fullSync: All components confirmed including key-servers - green indicator
  inSync: boolean('in_sync').default(false),
  fullSync: boolean('full_sync').default(false),

  // Customer count from vault
  customerCount: integer('customer_count').default(0),

  // Connection status - derived from response availability
  lastSeenAt: timestamp('last_seen_at'),
  lastErrorAt: timestamp('last_error_at'),
  lastError: text('last_error'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
