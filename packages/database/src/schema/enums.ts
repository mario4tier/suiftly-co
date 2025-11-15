import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Database Enumerations - Single Source of Truth
 *
 * All enum types defined here and used across the schema.
 * These map to PostgreSQL ENUM types and provide TypeScript type safety.
 *
 * IMPORTANT: When adding new values to existing enums in production:
 * - Use: ALTER TYPE enum_name ADD VALUE 'new_value';
 * - Can only add values (cannot remove or reorder without recreating type)
 * - See docs/ENUM_IMPLEMENTATION.md for migration patterns
 */

// Customer status values
export const customerStatusEnum = pgEnum('customer_status', [
  'active',
  'suspended',
  'closed'
]);

// Service types
export const serviceTypeEnum = pgEnum('service_type', [
  'seal',
  'grpc',
  'graphql'
]);

// Service states (6 distinct states - see UI_DESIGN.md)
export const serviceStateEnum = pgEnum('service_state', [
  'not_provisioned',
  'provisioning',
  'disabled',
  'enabled',
  'suspended_maintenance',
  'suspended_no_payment'
]);

// Service tiers
export const serviceTierEnum = pgEnum('service_tier', [
  'starter',
  'pro',
  'enterprise'
]);

// Transaction types (for escrow and ledger)
export const transactionTypeEnum = pgEnum('transaction_type', [
  'deposit',
  'withdraw',
  'charge',
  'credit'
]);

// Billing status
export const billingStatusEnum = pgEnum('billing_status', [
  'pending',
  'paid',
  'failed'
]);

/**
 * Export TypeScript types derived from enums
 *
 * These types are automatically inferred from the enum values above.
 * Use these types throughout the application for type safety.
 *
 * Example:
 *   import type { CustomerStatus } from '@suiftly/database/schema/enums';
 *   const status: CustomerStatus = 'active';  // ✅ Type-safe
 */
export type CustomerStatus = typeof customerStatusEnum.enumValues[number];
export type ServiceType = typeof serviceTypeEnum.enumValues[number];
export type ServiceState = typeof serviceStateEnum.enumValues[number];
export type ServiceTier = typeof serviceTierEnum.enumValues[number];
export type TransactionType = typeof transactionTypeEnum.enumValues[number];
export type BillingStatus = typeof billingStatusEnum.enumValues[number];
