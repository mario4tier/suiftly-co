import { pgTable, uuid, integer, varchar, boolean, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import { customers } from './customers';

export const serviceInstances = pgTable('service_instances', {
  instanceId: uuid('instance_id').primaryKey().defaultRandom(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: varchar('service_type', { length: 20 }).notNull(),
  tier: varchar('tier', { length: 20 }).notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  config: jsonb('config'),
  enabledAt: timestamp('enabled_at'),
  disabledAt: timestamp('disabled_at'),
}, (table) => ({
  uniqueCustomerService: unique().on(table.customerId, table.serviceType),
}));
