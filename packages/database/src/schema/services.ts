import { pgTable, serial, integer, boolean, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { serviceTypeEnum, serviceStateEnum, serviceTierEnum } from './enums';

export const serviceInstances = pgTable('service_instances', {
  instanceId: serial('instance_id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: serviceTypeEnum('service_type').notNull(),
  state: serviceStateEnum('state').notNull().default('not_provisioned'),
  tier: serviceTierEnum('tier').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  subscriptionChargePending: boolean('subscription_charge_pending').notNull().default(true),
  config: jsonb('config'),
  enabledAt: timestamp('enabled_at'),
  disabledAt: timestamp('disabled_at'),
}, (table) => ({
  uniqueCustomerService: unique().on(table.customerId, table.serviceType),
  // Index for efficient service-type iteration (backend synchronization)
  idxServiceTypeState: index('idx_service_type_state').on(table.serviceType, table.state),
}));
