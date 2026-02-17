/**
 * Test Helpers for Billing Module
 *
 * These exports are ONLY for use in test files.
 * DO NOT import from this module in production code.
 *
 * The `unsafeAsLockedTransaction` function bypasses the locking safety
 * guarantees and should never be used outside of tests.
 */

import type { ISuiService } from '@suiftly/shared/sui-service';
import type { DBClock } from '@suiftly/shared/db-clock';
import type { IPaymentProvider } from '@suiftly/shared/payment-provider';
import { MockStripeService } from '../stripe-mock/mock.js';
import { EscrowPaymentProvider } from './providers/escrow-provider.js';
import type { PaymentServices } from './providers/index.js';
import type { DatabaseOrTransaction } from '../db.js';
import { sql } from 'drizzle-orm';

export { unsafeAsLockedTransaction } from './locking';

/**
 * Create PaymentServices from a test ISuiService instance.
 * Uses a fresh MockStripeService for the stripe service.
 */
export function toPaymentServices(suiService: ISuiService): PaymentServices {
  return {
    suiService,
    stripeService: new MockStripeService(),
  };
}

/**
 * Create an escrow-only provider array for tests that call processInvoicePayment directly.
 */
export function toEscrowProviders(
  suiService: ISuiService,
  db: DatabaseOrTransaction,
  clock: DBClock,
): IPaymentProvider[] {
  return [new EscrowPaymentProvider(suiService, db, clock)];
}

/**
 * Ensure an escrow payment method exists for a customer.
 * Required because handleSubscriptionBillingLocked uses the provider chain
 * (getCustomerProviders) which reads from customer_payment_methods table.
 * Idempotent — uses INSERT ... ON CONFLICT DO NOTHING for atomicity.
 */
export async function ensureEscrowPaymentMethod(
  db: DatabaseOrTransaction,
  customerId: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO customer_payment_methods (customer_id, provider_type, status, priority)
    SELECT ${customerId}, 'escrow', 'active', 1
    WHERE NOT EXISTS (
      SELECT 1 FROM customer_payment_methods
      WHERE customer_id = ${customerId} AND provider_type = 'escrow' AND status = 'active'
    )
  `);
}

/**
 * Clean up all test data for a specific customer.
 * Uses customer-specific DELETEs (row-level locks) instead of TRUNCATE
 * (table-level AccessExclusiveLock) to avoid deadlocks when test files
 * run concurrently in a single fork.
 *
 * Delete order respects foreign key constraints:
 * 1. Tables that reference billing_records (billing_idempotency, invoice_payments, invoice_line_items, service_instances)
 * 2. billing_records itself
 * 3. Other tables referencing customers
 * 4. customers last
 */
export async function cleanupCustomerData(
  db: DatabaseOrTransaction,
  customerId: number,
): Promise<void> {
  // Guard against undefined (e.g., beforeEach failed before assigning customerId)
  if (customerId == null || Number.isNaN(customerId)) return;
  // admin_notifications uses varchar customer_id (may be null)
  await db.execute(sql`DELETE FROM admin_notifications WHERE customer_id = ${String(customerId)}`);
  // user_activity_logs
  await db.execute(sql`DELETE FROM user_activity_logs WHERE customer_id = ${customerId}`);
  // billing_idempotency — delete by billing_record_id FK AND by customer-keyed entries
  // (monthly billing keys have billing_record_id=NULL, so the FK join won't catch them)
  await db.execute(sql`DELETE FROM billing_idempotency WHERE billing_record_id IN (
    SELECT id FROM billing_records WHERE customer_id = ${customerId}
  )`);
  await db.execute(sql`DELETE FROM billing_idempotency WHERE idempotency_key LIKE ${'monthly-' + customerId + '-%'}`);
  // invoice_payments references billing_records
  await db.execute(sql`DELETE FROM invoice_payments WHERE billing_record_id IN (
    SELECT id FROM billing_records WHERE customer_id = ${customerId}
  )`);
  // invoice_line_items references billing_records (has ON DELETE CASCADE, but explicit is safer)
  await db.execute(sql`DELETE FROM invoice_line_items WHERE billing_record_id IN (
    SELECT id FROM billing_records WHERE customer_id = ${customerId}
  )`);
  // seal_packages references seal_keys (ON DELETE CASCADE), seal_keys references customers
  await db.execute(sql`DELETE FROM seal_packages WHERE seal_key_id IN (
    SELECT seal_key_id FROM seal_keys WHERE customer_id = ${customerId}
  )`);
  await db.execute(sql`DELETE FROM seal_keys WHERE customer_id = ${customerId}`);
  await db.execute(sql`DELETE FROM api_keys WHERE customer_id = ${customerId}`);
  // service_cancellation_history references customers
  await db.execute(sql`DELETE FROM service_cancellation_history WHERE customer_id = ${customerId}`);
  // service_instances references both customers and billing_records (subPendingInvoiceId)
  await db.execute(sql`DELETE FROM service_instances WHERE customer_id = ${customerId}`);
  // billing_records references customers
  await db.execute(sql`DELETE FROM billing_records WHERE customer_id = ${customerId}`);
  // Other tables referencing customers
  await db.execute(sql`DELETE FROM customer_credits WHERE customer_id = ${customerId}`);
  await db.execute(sql`DELETE FROM escrow_transactions WHERE customer_id = ${customerId}`);
  await db.execute(sql`DELETE FROM mock_sui_transactions WHERE customer_id = ${customerId}`);
  await db.execute(sql`DELETE FROM customer_payment_methods WHERE customer_id = ${customerId}`);
  await db.execute(sql`DELETE FROM payment_webhook_events WHERE customer_id = ${customerId}`);
  // customers last
  await db.execute(sql`DELETE FROM customers WHERE customer_id = ${customerId}`);
}
