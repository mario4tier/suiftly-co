import { pgTable, bigserial, integer, varchar, bigint, timestamp, decimal, index } from 'drizzle-orm/pg-core';
import { customers } from './customers';
import { FIELD_LIMITS } from '@suiftly/shared/constants';

export const usageRecords = pgTable('usage_records', {
  recordId: bigserial('record_id', { mode: 'number' }).primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  serviceType: varchar('service_type', { length: FIELD_LIMITS.SERVICE_TYPE }).notNull(),
  requestCount: bigint('request_count', { mode: 'number' }).notNull(),
  bytesTransferred: bigint('bytes_transferred', { mode: 'number' }),
  windowStart: timestamp('window_start').notNull(),
  windowEnd: timestamp('window_end').notNull(),
  chargedAmount: decimal('charged_amount', { precision: 20, scale: 8 }),
}, (table) => ({
  idxCustomerTime: index('idx_customer_time').on(table.customerId, table.windowStart),
  idxBilling: index('idx_billing').on(table.customerId, table.serviceType, table.windowStart),
}));
