import { pgTable, serial, integer, boolean, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { serviceTypeEnum, serviceStateEnum } from './enums';

/**
 * Service Instances Table
 *
 * Tracks non-platform customer service instances (seal, grpc, graphql).
 * Platform subscription state lives on the customers table (platformTier, etc.).
 * These are free features with user-configurable state and per-service config.
 */
export const serviceInstances = pgTable('service_instances', {
  instanceId: serial('instance_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),
  state: serviceStateEnum('state').notNull().default('not_provisioned'),
  isUserEnabled: boolean('is_user_enabled').notNull().default(true),
  config: jsonb('config'),
  enabledAt: timestamp('enabled_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),

  // Usage billing: tracks last billed timestamp to prevent double-billing (STATS_DESIGN.md D3)
  lastBilledTimestamp: timestamp('last_billed_timestamp', { withTimezone: true }),

  // Vault sync tracking per vault type: records the vault seq that will contain this service's config
  // 0 = no pending changes (synced), >0 = waiting for LMs to reach this seq
  // Set to nextVaultSeq when config changes
  smaConfigChangeVaultSeq: integer('sma_config_change_vault_seq').default(0),  // Seal mainnet API
  rmaConfigChangeVaultSeq: integer('rma_config_change_vault_seq').default(0),  // gRPC mainnet API

  // General-purpose update timestamp for cache invalidation and delta syncs
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

  // Control-plane enabled: true once service has been provisioned to gateways
  // Transitions to true when: isUserEnabled=true AND has seal key with package
  // Once true, stays true (gateways keep config even if user disables service)
  // HAProxy blocks traffic when disabled, but key-server keeps the keys loaded
  cpEnabled: boolean('cp_enabled').notNull().default(false),
}, (table) => ({
  uniqueCustomerService: unique().on(table.customerId, table.serviceType),
  // Index for efficient service-type iteration (backend synchronization)
  idxServiceTypeState: index('idx_service_type_state').on(table.serviceType, table.state),
}));
