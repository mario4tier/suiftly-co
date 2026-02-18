/**
 * Admin Notifications Schema
 *
 * Stores internal errors and warnings that require admin attention.
 * Used for billing validation failures, system errors, etc.
 */

import { pgTable, serial, integer, bigint, varchar, text, timestamp, index, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

export const adminNotifications = pgTable('admin_notifications', {
  notificationId: serial('notification_id').primaryKey(),

  // Severity and type
  severity: varchar('severity', { length: 20 }).notNull(), // 'error' | 'warning' | 'info'
  category: varchar('category', { length: 50 }).notNull(), // 'billing' | 'system' | 'security' etc.

  // Error details
  code: varchar('code', { length: 100 }).notNull(), // Error code for categorization
  message: text('message').notNull(), // Human-readable message
  details: text('details'), // JSON-encoded details

  // Context
  customerId: integer('customer_id').references(() => customers.customerId), // May be null for system errors
  invoiceId: bigint('invoice_id', { mode: 'number' }), // References billing_records.id (may be null)

  // Status tracking
  acknowledged: boolean('acknowledged').notNull().default(false),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: varchar('acknowledged_by', { length: 100 }), // Admin username

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  idxSeverity: index('idx_admin_notif_severity').on(table.severity),
  idxCategory: index('idx_admin_notif_category').on(table.category),
  idxAcknowledged: index('idx_admin_notif_acknowledged').on(table.acknowledged).where(sql`${table.acknowledged} = false`),
  idxCreated: index('idx_admin_notif_created').on(table.createdAt),
  idxCustomer: index('idx_admin_notif_customer').on(table.customerId).where(sql`${table.customerId} IS NOT NULL`),
}));
