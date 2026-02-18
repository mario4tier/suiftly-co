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

// Billing record type (what kind of billing record/invoice this is)
// Narrower than transactionTypeEnum — invoices are charges or credits, never deposits/withdrawals
export const billingRecordTypeEnum = pgEnum('billing_record_type', [
  'charge',    // Customer owes money (subscription, usage, upgrades)
  'credit'     // Credit note (refund, adjustment)
]);

// Payment source type (where a payment came from)
export const paymentSourceTypeEnum = pgEnum('payment_source_type', [
  'credit',    // Applied from customer credits
  'escrow',    // Paid from on-chain escrow
  'stripe',    // Paid via Stripe
  'paypal'     // Paid via PayPal
]);

// Payment provider type (payment method provider)
export const paymentProviderTypeEnum = pgEnum('payment_provider_type', [
  'escrow',    // On-chain escrow
  'stripe',    // Stripe credit card
  'paypal'     // PayPal billing agreement
]);

// Payment method status
export const paymentMethodStatusEnum = pgEnum('payment_method_status', [
  'active',     // Available for use
  'suspended',  // Temporarily disabled
  'removed'     // Soft-deleted
]);

// Credit reason (why a credit was issued)
export const creditReasonEnum = pgEnum('credit_reason', [
  'outage',          // Service outage compensation
  'promo',           // Promotional credit
  'goodwill',        // Customer goodwill gesture
  'reconciliation'   // Billing reconciliation adjustment
]);

// Seal registration operation type
export const sealOpTypeEnum = pgEnum('seal_op_type', [
  'register',  // Initial KeyServer object creation
  'update'     // Re-registration when packages change
]);

// Seal registration operation status
export const sealOpStatusEnum = pgEnum('seal_op_status', [
  'queued',      // Waiting to be processed
  'processing',  // Currently being processed by GM
  'completed'    // Successfully completed
]);

// Invoice line item types (semantic categorization of invoice charges)
// Used for structured billing display instead of string descriptions
export const invoiceLineItemTypeEnum = pgEnum('invoice_line_item_type', [
  // Tier subscriptions (per service, per tier)
  'subscription_starter',
  'subscription_pro',
  'subscription_enterprise',
  // Tier upgrade (pro-rated charge for remaining days in month)
  'tier_upgrade',
  // Usage-based charges
  'requests',
  // Add-ons (quantity = extra count beyond included)
  'extra_api_keys',
  'extra_seal_keys',
  'extra_allowlist_ips',
  'extra_packages',
  // Credits and taxes
  'credit',
  'tax'
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
export type InvoiceLineItemType = typeof invoiceLineItemTypeEnum.enumValues[number];
export type BillingRecordType = typeof billingRecordTypeEnum.enumValues[number];
export type PaymentSourceType = typeof paymentSourceTypeEnum.enumValues[number];
export type PaymentProviderType = typeof paymentProviderTypeEnum.enumValues[number];
export type PaymentMethodStatus = typeof paymentMethodStatusEnum.enumValues[number];
export type CreditReason = typeof creditReasonEnum.enumValues[number];
export type SealOpType = typeof sealOpTypeEnum.enumValues[number];
export type SealOpStatus = typeof sealOpStatusEnum.enumValues[number];
