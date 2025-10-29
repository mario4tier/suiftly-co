import { pgTable, timestamp, integer, text, bigint, smallint, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

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
}, (table) => ({
  idxCustomerTime: index('idx_customer_time').on(table.customerId, table.timestamp.desc()).where(sql`${table.customerId} IS NOT NULL`),
  idxServerTime: index('idx_server_time').on(table.serverId, table.timestamp.desc()),
  idxServiceNetwork: index('idx_service_network').on(table.serviceType, table.network, table.timestamp.desc()),
  idxTrafficType: index('idx_traffic_type').on(table.trafficType, table.timestamp.desc()),
  idxEventType: index('idx_event_type').on(table.eventType, table.timestamp.desc()).where(sql`${table.eventType} != 0`),
  idxStatusCode: index('idx_status_code').on(table.statusCode, table.timestamp.desc()),
  idxApiKeyFp: index('idx_api_key_fp').on(table.apiKeyFp, table.timestamp.desc()).where(sql`${table.apiKeyFp} != 0`),
}));
