import { pgTable, integer, varchar, text, date, boolean, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

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
  maVaultVersion: varchar('ma_vault_version', { length: FIELD_LIMITS.VAULT_VERSION }),
  mmVaultVersion: varchar('mm_vault_version', { length: FIELD_LIMITS.VAULT_VERSION }),
  lastMonthlyReset: date('last_monthly_reset'),
  maintenanceMode: boolean('maintenance_mode').default(false),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  checkSingleton: check('check_singleton', sql`${table.id} = 1`),
}));
