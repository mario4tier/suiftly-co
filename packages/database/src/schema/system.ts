import { pgTable, integer, varchar, text, date, boolean, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
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
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const processingState = pgTable('processing_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const systemControl = pgTable('system_control', {
  id: integer('id').primaryKey(),

  // Vault sequential versions (DB-authoritative, used in vault filenames)
  // 3-letter codes: {service}{network}{purpose}
  //   a = api (HAProxy config), k = keyserver, o = open mode
  // Seal mainnet vaults
  smaVaultSeq: integer('sma_vault_seq').default(0),  // Seal mainnet API (HAProxy config)
  smkVaultSeq: integer('smk_vault_seq').default(0),  // Seal mainnet keyserver
  smoVaultSeq: integer('smo_vault_seq').default(0),  // Seal mainnet open
  // Seal testnet vaults
  staVaultSeq: integer('sta_vault_seq').default(0),  // Seal testnet API (HAProxy config)
  stkVaultSeq: integer('stk_vault_seq').default(0),  // Seal testnet keyserver
  stoVaultSeq: integer('sto_vault_seq').default(0),  // Seal testnet open
  // Seal test/dev vault
  skkVaultSeq: integer('skk_vault_seq').default(0),  // Seal test/dev

  // Next vault seq (GM bumps to currentSeq+2 when processing, resets to newSeq+1 when done)
  // API reads this to get the seq for configChangeVaultSeq
  // This avoids expensive MAX queries and prevents race conditions
  // Seal mainnet vaults
  smaNextVaultSeq: integer('sma_next_vault_seq').default(1),  // Seal mainnet API
  smkNextVaultSeq: integer('smk_next_vault_seq').default(1),  // Seal mainnet keyserver
  smoNextVaultSeq: integer('smo_next_vault_seq').default(1),  // Seal mainnet open
  // Seal testnet vaults
  staNextVaultSeq: integer('sta_next_vault_seq').default(1),  // Seal testnet API
  stkNextVaultSeq: integer('stk_next_vault_seq').default(1),  // Seal testnet keyserver
  stoNextVaultSeq: integer('sto_next_vault_seq').default(1),  // Seal testnet open
  // Seal test/dev vault
  skkNextVaultSeq: integer('skk_next_vault_seq').default(1),  // Seal test/dev

  // Global max configChangeVaultSeq per vault type
  // Updated atomically by API when setting service's configChangeVaultSeq
  // GM reads this for O(1) hasPendingChanges check instead of MAX query
  smaMaxConfigChangeSeq: integer('sma_max_config_change_seq').default(0),
  staMaxConfigChangeSeq: integer('sta_max_config_change_seq').default(0),

  // Content hashes for change detection (first 16 chars of SHA-256)
  smaVaultContentHash: varchar('sma_vault_content_hash', { length: 16 }),
  smkVaultContentHash: varchar('smk_vault_content_hash', { length: 16 }),
  smoVaultContentHash: varchar('smo_vault_content_hash', { length: 16 }),
  staVaultContentHash: varchar('sta_vault_content_hash', { length: 16 }),
  stkVaultContentHash: varchar('stk_vault_content_hash', { length: 16 }),
  stoVaultContentHash: varchar('sto_vault_content_hash', { length: 16 }),
  skkVaultContentHash: varchar('skk_vault_content_hash', { length: 16 }),

  // Entry counts (number of KV pairs in vault, for sanity checks)
  smaVaultEntries: integer('sma_vault_entries').default(0),
  smkVaultEntries: integer('smk_vault_entries').default(0),
  smoVaultEntries: integer('smo_vault_entries').default(0),
  staVaultEntries: integer('sta_vault_entries').default(0),
  stkVaultEntries: integer('stk_vault_entries').default(0),
  stoVaultEntries: integer('sto_vault_entries').default(0),
  skkVaultEntries: integer('skk_vault_entries').default(0),

  // Seal key derivation index counters (per process group)
  // Each PG has its own master seed, so derivation indices are independent namespaces.
  // Atomic increment ensures globally unique indices within each PG.
  // PG 1 = Production, PG 2 = Development
  nextSealDerivationIndexPg1: integer('next_seal_derivation_index_pg1').notNull().default(1),
  nextSealDerivationIndexPg2: integer('next_seal_derivation_index_pg2').notNull().default(1),

  lastMonthlyReset: date('last_monthly_reset'),
  maintenanceMode: boolean('maintenance_mode').default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  checkSingleton: check('check_singleton', sql`${table.id} = 1`),
}));

/**
 * Local Manager Status Table
 *
 * Tracks the status of each Local Manager (LM) in the fleet.
 * GM polls each LM's /api/health endpoint and stores results here.
 *
 * LM health response format (applied/processing model):
 * - vaults[].applied: {seq, at} - last successfully applied vault
 * - vaults[].processing: {seq, startedAt, error} - currently processing vault
 *
 * Sync status calculation (sequence-based):
 * - GM extracts appliedSeq from each LM's vaults[].applied.seq
 * - API calculates MIN(appliedSeq) across all LMs for each vault type
 * - Service is synced when configChangeVaultSeq <= MIN(appliedSeq for all relevant vaults)
 * - Service shows "Updating" when configChangeVaultSeq > MIN(appliedSeq) for any relevant vault
 */
export const lmStatus = pgTable('lm_status', {
  lmId: varchar('lm_id', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 128 }),
  host: varchar('host', { length: 256 }).notNull(),
  region: varchar('region', { length: 64 }),

  // Vault status (from LM health response)
  // One row per (lmId, vaultType) — each LM reports multiple vault types (sma, smk, etc.)
  vaultType: varchar('vault_type', { length: 8 }).notNull(),
  appliedSeq: integer('applied_seq').default(0), // vaults[].applied.seq (null if no vault applied yet)
  processingSeq: integer('processing_seq'), // vaults[].processing.seq (for visibility, not used in sync logic)

  // Entry count from vault (number of KV pairs in the applied vault)
  entries: integer('entries').default(0),

  // Connection status - derived from response availability
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastError: text('last_error'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.lmId, table.vaultType] }),
}));
