/**
 * Billing Processor Types
 *
 * Core types for Phase 1B single-thread billing processor.
 */

import type { DBClock } from '@suiftly/shared/db-clock';

/**
 * Result of processing billing for a single customer
 */
export interface CustomerBillingResult {
  customerId: number;
  success: boolean;
  operations: BillingOperation[];
  errors: BillingError[];
}

/**
 * Individual billing operation performed
 */
export interface BillingOperation {
  type: 'monthly_billing' | 'credit_application' | 'escrow_charge' | 'grace_period_start' | 'grace_period_end' | 'payment_retry' | 'reconciliation';
  timestamp: Date;
  amountUsdCents?: number;
  invoiceId?: number;
  description: string;
  success: boolean;
}

/**
 * Billing error details
 */
export interface BillingError {
  type: 'insufficient_balance' | 'spending_limit_exceeded' | 'payment_failed' | 'database_error' | 'validation_error';
  message: string;
  customerId: number;
  invoiceId?: number;
  retryable: boolean;
}

/**
 * Configuration for billing processor
 */
export interface BillingProcessorConfig {
  clock: DBClock;

  // Thresholds
  usageChargeThresholdCents: number; // Default: $5.00 = 500 cents

  // Grace period settings
  gracePeriodDays: number; // Default: 14 days

  // Retry settings
  maxRetryAttempts: number; // Default: 3
  retryIntervalHours: number; // Default: 24 hours
}

/**
 * Result of applying credits to an invoice
 */
export interface CreditApplicationResult {
  creditsApplied: Array<{
    creditId: number;
    amountUsedCents: number;
    remainingCents: number;
  }>;
  totalAppliedCents: number;
  remainingInvoiceAmountCents: number;
}

/**
 * Result of processing a single invoice payment
 */
export interface InvoicePaymentResult {
  invoiceId: number;
  initialAmountCents: number;
  amountPaidCents: number;
  fullyPaid: boolean;
  paymentSources: Array<{
    type: 'credit' | 'escrow';
    amountCents: number;
    referenceId: string; // credit_id or escrow_transaction_id
  }>;
  error?: BillingError;
}

/**
 * Idempotency key result
 */
export interface IdempotencyResult<T = unknown> {
  cached: boolean;
  result: T;
}
