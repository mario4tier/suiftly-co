import { pgTable, integer, varchar, text, date, boolean, timestamp, check, decimal } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const processingState = pgTable('processing_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const systemControl = pgTable('system_control', {
  id: integer('id').primaryKey(),
  maVaultVersion: varchar('ma_vault_version', { length: 64 }),
  mmVaultVersion: varchar('mm_vault_version', { length: 64 }),
  lastMonthlyReset: date('last_monthly_reset'),
  maintenanceMode: boolean('maintenance_mode').default(false),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  checkSingleton: check('check_singleton', sql`${table.id} = 1`),
}));

/**
 * Service tier configuration
 * Singleton table to store configurable tier pricing and limits
 */
export const serviceTierConfig = pgTable('service_tier_config', {
  id: integer('id').primaryKey(),
  // Basic tier
  basicReqPerSecRegion: integer('basic_req_per_sec_region').notNull().default(20),
  basicReqPerSecGlobal: integer('basic_req_per_sec_global').notNull().default(60),
  basicPrice: decimal('basic_price', { precision: 10, scale: 2 }).notNull().default('20.00'),
  basicBurstAllowed: boolean('basic_burst_allowed').notNull().default(false),
  // Pro tier
  proReqPerSecRegion: integer('pro_req_per_sec_region').notNull().default(300),
  proReqPerSecGlobal: integer('pro_req_per_sec_global').notNull().default(1200),
  proPrice: decimal('pro_price', { precision: 10, scale: 2 }).notNull().default('100.00'),
  proBurstAllowed: boolean('pro_burst_allowed').notNull().default(true),
  // Business tier
  businessReqPerSecRegion: integer('business_req_per_sec_region').notNull().default(1000),
  businessReqPerSecGlobal: integer('business_req_per_sec_global').notNull().default(4000),
  businessPrice: decimal('business_price', { precision: 10, scale: 2 }).notNull().default('300.00'),
  businessBurstAllowed: boolean('business_burst_allowed').notNull().default(true),
  // Metadata
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  checkSingleton: check('check_singleton', sql`${table.id} = 1`),
}));
