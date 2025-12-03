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

// Service states (7 distinct states - see UI_DESIGN.md and BILLING_DESIGN.md R13)
export const serviceStateEnum = pgEnum('service_state', [
  'not_provisioned',
  'provisioning',
  'disabled',
  'enabled',
  'suspended_maintenance',
  'suspended_no_payment',
  'cancellation_pending'  // Added in Phase 1C for 7-day grace period after billing period ends
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

// Billing status (invoice lifecycle states)
export const billingStatusEnum = pgEnum('billing_status', [
  'draft',    // Pre-computed projection for next billing cycle
  'pending',  // Ready for payment processing
  'paid',     // Fully paid
  'failed',   // Charge attempt failed
  'voided'    // Cancelled (billing error, etc.)
]);

// Billing type (distinguishes invoice creation context)
// Used for reconciliation: immediate invoices need on-chain verification if stuck pending
export const billingTypeEnum = pgEnum('billing_type', [
  'immediate', // Mid-cycle charges (upgrades, first subscription) - void on failure
  'scheduled'  // Monthly billing (from DRAFT) - retry until paid
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
export type BillingType = typeof billingTypeEnum.enumValues[number];
