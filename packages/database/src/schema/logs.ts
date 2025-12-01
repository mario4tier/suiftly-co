import { pgTable, timestamp, integer, text, bigint, smallint, index, serial, inet } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

// User activity logs - tracks user-level actions (login, config changes, subscriptions)
// Auto-purges to keep ~100 entries per customer
export const userActivityLogs = pgTable('user_activity_logs', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.customerId),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
  clientIp: inet('client_ip').notNull(),
  message: text('message').notNull(),
}, (table) => ({
  idxCustomerTime: index('idx_activity_customer_time').on(table.customerId, table.timestamp.desc()),
}));

export const haproxyRawLogs = pgTable('haproxy_raw_logs', {
  // Timestamp (TimescaleDB partition key)
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

  // Customer context (NULL if unauthenticated)
  customerId: integer('customer_id').references(() => customers.customerId),
  pathPrefix: text('path_prefix'),
  configHex: bigint('config_hex', { mode: 'number' }),

  // Infrastructure context (decoded from merge_fields_1, all NOT NULL)
  network: smallint('network').notNull(),
  serverId: smallint('server_id').notNull(),
  serviceType: smallint('service_type').notNull(),
  apiKeyFp: integer('api_key_fp').notNull(),
  feType: smallint('fe_type').notNull(),
  trafficType: smallint('traffic_type').notNull(),
  eventType: smallint('event_type').notNull(),
  clientIp: text('client_ip').notNull(), // INET type in PostgreSQL

  // API key context (decoded from merge_fields_2)
  keyMetadata: smallint('key_metadata'),

  // Response
  statusCode: smallint('status_code').notNull(),
  bytesSent: bigint('bytes_sent', { mode: 'number' }).notNull().default(0),

  // Timing
  timeTotal: integer('time_total').notNull(),
  timeRequest: integer('time_request'),
  timeQueue: integer('time_queue'),
  timeConnect: integer('time_connect'),
  timeResponse: integer('time_response'),

  // Backend routing
  backendId: smallint('backend_id').default(0),
  terminationState: text('termination_state'),

  // Pre-aggregated log support (future)
  // When HAProxy sends aggregated entries, this indicates how many identical requests this row represents
  // Default 1 = single request (current behavior). >1 = pre-aggregated count.
  repeat: integer('repeat').notNull().default(1),
}, (table) => ({
  idxLogsCustomerTime: index('idx_logs_customer_time').on(table.customerId, table.timestamp.desc()).where(sql`${table.customerId} IS NOT NULL`),
  idxLogsServerTime: index('idx_logs_server_time').on(table.serverId, table.timestamp.desc()),
  idxLogsServiceNetwork: index('idx_logs_service_network').on(table.serviceType, table.network, table.timestamp.desc()),
  idxLogsTrafficType: index('idx_logs_traffic_type').on(table.trafficType, table.timestamp.desc()),
  idxLogsEventType: index('idx_logs_event_type').on(table.eventType, table.timestamp.desc()).where(sql`${table.eventType} != 0`),
  idxLogsStatusCode: index('idx_logs_status_code').on(table.statusCode, table.timestamp.desc()),
  idxLogsApiKeyFp: index('idx_logs_api_key_fp').on(table.apiKeyFp, table.timestamp.desc()).where(sql`${table.apiKeyFp} != 0`),
}));
