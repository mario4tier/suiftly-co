/**
 * E2E regression test: escrow as implicit payment provider.
 *
 * Reproduces the "Subscription payment pending" stuck state that occurs when a
 * customer's escrow has sufficient balance but no `customer_payment_methods`
 * row exists at the moment of the charge attempt. Historically the system
 * required an explicit "Add Crypto Payment" ceremony / auto-register hook to
 * land that row before a subscribe call. This test asserts that escrow works
 * *without* the registry row: any customer with a balance must be able to pay.
 *
 * Bug symptom before fix: subscribe → billing_records.status = 'failed',
 * customers.pending_invoice_id populated, banner says
 * "Subscription payment pending".
 */

import { test, expect } from '../fixtures/base-test';
import {
  resetCustomer,
  authenticateWithMockWallet,
  ensureTestBalance,
  clearPaymentMethods,
} from '../helpers/db';
import { waitAfterMutation } from '../helpers/wait-utils';

const MOCK_WALLET_0 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test.describe('Escrow implicit provider', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await authenticateWithMockWallet(page);
  });

  test('subscribes successfully with only escrow balance and no registry row', async ({ page, request }) => {
    // Arrange: fund escrow. `ensureTestBalance` auto-registers escrow as a
    // test convenience — we strip that row immediately to reproduce the
    // wild "funded-but-unregistered" state.
    await ensureTestBalance(request, 50);
    await clearPaymentMethods(request, MOCK_WALLET_0);

    // Act: subscribe through the normal UI flow WITHOUT clicking
    // "Add Crypto Payment". The user has a balance; escrow should be an
    // implicit provider and the charge should succeed.
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    await page.locator('#platform-tos').click();
    await waitAfterMutation(page);

    await page.locator('button:has-text("Subscribe to Starter Plan")').click();

    // Assert: the subscription activates — no "payment pending" banner, the
    // active plan card renders. Fails today with a stuck pending invoice.
    await expect(
      page.getByText('Platform Starter Plan', { exact: true })
    ).toBeVisible({ timeout: 10000 });

    await expect(
      page.locator('text=Subscription payment pending')
    ).toHaveCount(0);
  });
});
