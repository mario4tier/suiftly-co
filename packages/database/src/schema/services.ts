import { pgTable, serial, integer, varchar, boolean, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

export const serviceInstances = pgTable('service_instances', {
  instanceId: serial('instance_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: varchar('service_type', { length: FIELD_LIMITS.SERVICE_TYPE }).notNull(),
  state: varchar('state', { length: FIELD_LIMITS.SERVICE_STATE }).notNull().default('not_provisioned'),
  tier: varchar('tier', { length: FIELD_LIMITS.SERVICE_TIER }).notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  subscriptionChargePending: boolean('subscription_charge_pending').notNull().default(true),
  config: jsonb('config'),
  enabledAt: timestamp('enabled_at'),
  disabledAt: timestamp('disabled_at'),
}, (table) => ({
  uniqueCustomerService: unique().on(table.customerId, table.serviceType),
}));
