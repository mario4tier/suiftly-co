/**
 * Admin notification test helpers
 *
 * Utilities for asserting which admin notifications a test produces.
 * Tests should call `clearNotifications()` in beforeEach and
 * `expectNotifications()` or `expectNoNotifications()` at test end.
 *
 * SCOPE: These helpers assert customer-scoped notifications only (where
 * customerId matches). System-level notifications (null customerId) such as
 * WEBHOOK_SIGNATURE_FAILED are intentionally excluded — they should be
 * asserted directly in the tests that specifically exercise those paths.
 * This is by design: customer-scoped assertions answer "did this customer's
 * billing flow produce unexpected errors?" without cross-customer noise.
 */

import { expect } from 'vitest';
import { db } from '@suiftly/database';
import { adminNotifications } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

/**
 * Non-deterministic notifications from GM's async sync-customer.
 *
 * GM runs as a separate process with its own Stripe mock that doesn't share
 * state with the API server's mock. When addStripePaymentMethod fires the
 * setup_intent.succeeded webhook, it triggers GM sync-customer which calls
 * retryUnpaidInvoices → StripePaymentProvider.canPay() fails because GM's
 * mock doesn't know about the test customer's Stripe account.
 *
 * These are tolerated (not required) by the `tolerateGM` option. Use this
 * blanket tolerance for tests where GM is a side effect (e.g., payment-flow
 * tests that call addStripePaymentMethod). For tests that specifically exercise
 * the webhook→GM queueing path (e.g., setup_intent tests), prefer the narrower
 * `tolerateCodes: ['warning:STRIPE_API_UNREACHABLE']` to still catch GM
 * connectivity failures (WEBHOOK_GM_QUEUE_FAILED).
 */
const GM_TOLERATED_CODES = new Set([
  'warning:STRIPE_API_UNREACHABLE',
  'warning:WEBHOOK_GM_QUEUE_FAILED',
]);

/**
 * Delete all admin_notifications for a customer.
 * Call in beforeEach to ensure each test starts with a clean slate.
 */
export async function clearNotifications(customerId: number): Promise<void> {
  await db.delete(adminNotifications)
    .where(eq(adminNotifications.customerId, customerId));
}

/**
 * Notification entry with severity, code, and optional invoiceId.
 */
interface NotificationEntry {
  severity: string;
  code: string;
  invoiceId: number | null;
}

/**
 * Get all notifications for a customer.
 */
async function getNotifications(customerId: number): Promise<NotificationEntry[]> {
  return db.select({
    severity: adminNotifications.severity,
    code: adminNotifications.code,
    invoiceId: adminNotifications.invoiceId,
  })
    .from(adminNotifications)
    .where(eq(adminNotifications.customerId, customerId));
}

/**
 * Assert that the test produced exactly the expected notifications (by severity:code).
 * Order doesn't matter. Fails if there are unexpected notifications or missing expected ones.
 *
 * @param tolerateGM - If true, tolerate all non-deterministic GM async notifications
 *   (STRIPE_API_UNREACHABLE and WEBHOOK_GM_QUEUE_FAILED). Use for tests where GM is
 *   a side effect (e.g., payment-flow tests that call addStripePaymentMethod). For tests
 *   that exercise the webhook→GM path directly, prefer `tolerateCodes` for narrower control.
 * @param tolerateCodes - Specific severity:code strings to tolerate (removed from actual
 *   before comparison). Use instead of tolerateGM when you want narrower control — e.g.,
 *   tolerate STRIPE_API_UNREACHABLE but still fail on WEBHOOK_GM_QUEUE_FAILED.
 * @param forInvoice - If provided, only check notifications for this specific invoiceId.
 *   This gives per-invoice assertion precision when multiple invoices exist for one customer.
 *
 * @example
 *   await expectNotifications(customerId, ['warning:GRACE_PERIOD_STARTED']);
 *   await expectNotifications(customerId, ['error:DOUBLE_CHARGE_AUTO_REFUNDED'], { forInvoice: billingRecordId });
 *   await expectNotifications(customerId, [], { tolerateGM: true });
 *   await expectNotifications(customerId, [], { tolerateCodes: ['warning:STRIPE_API_UNREACHABLE'] });
 */
export async function expectNotifications(
  customerId: number,
  expectedCodes: string[],
  options?: { tolerateGM?: boolean; tolerateCodes?: string[]; forInvoice?: number },
): Promise<void> {
  const allNotifs = await getNotifications(customerId);

  // Filter to specific invoice if requested
  let filtered = options?.forInvoice != null
    ? allNotifs.filter(n => n.invoiceId === options.forInvoice)
    : allNotifs;

  let actual = filtered.map(n => `${n.severity}:${n.code}`).sort();
  const expected = [...expectedCodes].sort();

  // Filter out tolerated notifications if requested
  if (options?.tolerateGM) {
    actual = actual.filter(c => !GM_TOLERATED_CODES.has(c));
  }
  if (options?.tolerateCodes) {
    const tolerateSet = new Set(options.tolerateCodes);
    actual = actual.filter(c => !tolerateSet.has(c));
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    // Build a helpful diff message
    const unexpected = actual.filter(c => !expected.includes(c));
    const missing = expected.filter(c => !actual.includes(c));
    const parts: string[] = [];
    if (unexpected.length > 0) parts.push(`unexpected: [${unexpected.join(', ')}]`);
    if (missing.length > 0) parts.push(`missing: [${missing.join(', ')}]`);

    // Fetch full details for unexpected notifications to help debugging
    if (unexpected.length > 0) {
      const fullNotifs = await db.select({
        code: adminNotifications.code,
        severity: adminNotifications.severity,
        message: adminNotifications.message,
        invoiceId: adminNotifications.invoiceId,
      })
        .from(adminNotifications)
        .where(eq(adminNotifications.customerId, customerId));
      parts.push(`all notifications: ${JSON.stringify(fullNotifs, null, 2)}`);
    }

    const scope = options?.forInvoice != null ? ` (invoiceId=${options.forInvoice})` : '';
    expect.fail(
      `Notification mismatch${scope}: ${parts.join('; ')}\n` +
      `  expected: [${expected.join(', ')}]\n` +
      `  actual:   [${actual.join(', ')}]`
    );
  }
}

/**
 * Assert that the test produced no admin notifications for this customer
 * (or for a specific invoice if `forInvoice` is provided).
 * Convenience wrapper for `expectNotifications(customerId, [])`.
 *
 * @param tolerateGM - If true, tolerate all non-deterministic GM async notifications.
 * @param tolerateCodes - Specific severity:code strings to tolerate. Prefer over
 *   tolerateGM when narrower control is needed.
 * @param forInvoice - If provided, only check notifications for this specific invoiceId
 *   rather than all notifications for the customer.
 */
export async function expectNoNotifications(
  customerId: number,
  options?: { tolerateGM?: boolean; tolerateCodes?: string[]; forInvoice?: number },
): Promise<void> {
  await expectNotifications(customerId, [], options);
}
