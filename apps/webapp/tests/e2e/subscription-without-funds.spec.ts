/**
 * Subscription Without Funds E2E Test
 * Tests that subscription without sufficient funds still creates the service
 * and transitions the UI from onboarding to interactive form.
 *
 * Issue: When subscribing without funds, the service is created but the UI
 * doesn't transition because the API returns an error instead of success.
 */

import { test, expect } from '@playwright/test';
import { getBanner } from '../helpers/locators';

test.describe('Subscription Without Funds', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer test data (delete all services, zero balance, NO escrow account)
    await request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 0, // $0 balance
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true, // Ensure no escrow account exists
      },
    });

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test('UI transitions to interactive form after subscription without funds', async ({ page }) => {
    // Should start with onboarding form
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).toBeVisible();

    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeEnabled();
    await subscribeButton.click();

    // Wait for subscription response (may show error about funds)
    await page.waitForTimeout(2000);

    // EXPECTED BEHAVIOR: Even without funds, the page should transition to interactive form
    // The onboarding form should disappear
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible({ timeout: 5000 });

    // Should show payment pending banner (not the normal disabled state banner)
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });
    await expect(getBanner(page)).toContainText('Add funds via');

    // Should see the service toggle (interactive form is shown)
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });

    console.log('✅ UI transitioned to interactive form after subscription without funds');
  });

  test('Service is created in database even without funds', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Verify service was created by checking that interactive form is shown
    // (which only happens if service exists in database)
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });
    await expect(getBanner(page)).toContainText('Subscription payment pending');

    console.log('✅ Service created in database with subscriptionChargePending=true');
  });

  test('Page refresh maintains interactive form state', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Should be showing interactive form with payment pending banner
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });

    // Refresh page
    await page.reload();

    // Should still show interactive form with payment pending banner (not revert to onboarding)
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ Interactive form state persists across page refresh');
  });

  test('Cannot enable service without funds', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Should show interactive form
    await expect(page.locator('#service-toggle')).toBeVisible({ timeout: 5000 });

    // Service should be OFF
    const toggle = page.locator('#service-toggle');
    await expect(toggle).not.toBeChecked();

    // Try to enable service
    await toggle.click();

    // Should show error toast about needing to deposit funds
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Insufficient funds.*Deposit/i })).toBeVisible({ timeout: 5000 });

    // Service should remain OFF
    await expect(toggle).not.toBeChecked();

    console.log('✅ Cannot enable service without depositing funds');
  });

  test('Navigating away and back shows interactive form', async ({ page }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Navigate away to dashboard
    await page.click('text=Dashboard');
    await page.waitForURL('/dashboard', { timeout: 5000 });

    // Navigate back to seal service
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Should show interactive form with payment pending banner (not onboarding)
    await expect(getBanner(page)).toContainText('Subscription payment pending', { timeout: 5000 });
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ After navigating away and back, interactive form is shown');
  });

  test('Billing page shows pending subscription notification with amount needed', async ({ page }) => {
    // Subscribe without funds (Pro tier defaults to $29/month)
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Navigate to billing page using sidebar link
    await page.locator('nav').getByRole('link', { name: /Billing & Payments/i }).click();
    await page.waitForURL('/billing', { timeout: 5000 });

    // Should show pending subscription notification
    const notification = page.locator('.bg-orange-50').filter({ hasText: 'Subscription payment pending' });
    await expect(notification).toBeVisible({ timeout: 5000 });

    // Notification should mention Seal service and Pro tier price
    await expect(notification).toContainText('Seal');
    await expect(notification).toContainText('Pro'); // formatTierName() capitalizes tier names
    await expect(notification).toContainText('$29.00');

    // Should show how much to deposit
    await expect(notification).toContainText(/Deposit at least.*\$29\.00/i);

    console.log('✅ Billing page shows pending subscription notification with correct amount');
  });

  test('Next Scheduled Payment/Refund excludes services with pending subscription charges', async ({ page }) => {
    // First, deposit $1 to create escrow account (so "Next Scheduled Payment/Refund" section is visible)
    // Navigate to billing page
    await page.locator('nav').getByRole('link', { name: /Billing & Payments/i }).click();
    await page.waitForURL('/billing', { timeout: 5000 });

    // Deposit $1
    await page.locator('button:has-text("Deposit")').first().click();
    await page.fill('input#depositAmount', '1');
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Deposit' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Deposited.*successfully/i })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    // Now navigate to seal service and subscribe
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });

    // Subscribe without sufficient funds (Pro tier defaults to $29/month, we only have $1)
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Navigate back to billing page
    await page.locator('nav').getByRole('link', { name: /Billing & Payments/i }).click();
    await page.waitForURL('/billing', { timeout: 5000 });

    // Verify "Next Scheduled Payment/Refund" section shows $0.00
    const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled (Payment|Refund)/ });
    const nextPaymentSection = nextPaymentButton.locator('..');
    await expect(nextPaymentSection).toContainText('$0.00', { timeout: 5000 });

    // Expand "Next Scheduled Payment/Refund" section
    await nextPaymentButton.click();
    await page.waitForTimeout(500);

    // Within the expanded section, should NOT contain Seal service (because subscriptionChargePending is true)
    // The expanded content is in a div that comes after the button
    const expandedContent = nextPaymentButton.locator('../..');

    // Should show "No upcoming charges" (the fallback message when there are no line items)
    // This proves that Seal service is NOT included in the DRAFT invoice
    await expect(expandedContent).toContainText('No upcoming charges');

    console.log('  → Shows "No upcoming charges" (proves Seal is excluded from DRAFT invoice)');
    console.log('✅ Next Scheduled Payment/Refund excludes pending subscription');
  });

  test('Billing notification disappears after depositing sufficient funds', async ({ page, request }) => {
    // Subscribe without funds
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Navigate to billing page using sidebar link
    await page.locator('nav').getByRole('link', { name: /Billing & Payments/i }).click();
    await page.waitForURL('/billing', { timeout: 5000 });

    // Verify notification is shown
    const notification = page.locator('.bg-orange-50').filter({ hasText: 'Subscription payment pending' });
    await expect(notification).toBeVisible({ timeout: 5000 });

    // Deposit funds ($30 to cover the $29 subscription)
    await page.locator('button:has-text("Deposit")').first().click();
    await page.fill('input#depositAmount', '30');

    // Click the submit button within the dialog footer
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Deposit' }).click();

    // Wait for deposit to complete and reconciliation to happen
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Deposited.*successfully/i })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1000); // Give time for reconciliation

    // Notification should disappear
    await expect(notification).not.toBeVisible({ timeout: 5000 });

    console.log('✅ Notification disappears after depositing funds');
  });

  test('Next Scheduled Payment/Refund updates immediately after deposit activates subscription', async ({ page }) => {
    // First, create escrow account with small deposit so "Next Scheduled Payment/Refund" section is visible
    await page.locator('nav').getByRole('link', { name: /Billing & Payments/i }).click();
    await page.waitForURL('/billing', { timeout: 5000 });

    await page.locator('button:has-text("Deposit")').first().click();
    await page.fill('input#depositAmount', '1');
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Deposit' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Deposited.*successfully/i })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);

    // Subscribe without sufficient funds (Pro tier defaults to $29/month, we only have $1)
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await page.waitForTimeout(2000);

    // Navigate back to billing page
    await page.locator('nav').getByRole('link', { name: /Billing & Payments/i }).click();
    await page.waitForURL('/billing', { timeout: 5000 });

    // Verify Next Scheduled Payment/Refund shows $0.00 (service has pending charge)
    const nextPaymentSection = page.locator('button').filter({ hasText: /Next Scheduled (Payment|Refund)/ }).locator('..');
    await expect(nextPaymentSection).toContainText('$0.00', { timeout: 5000 });

    // Deposit funds ($30 to cover the $29 subscription)
    await page.locator('button:has-text("Deposit")').first().click();
    await page.fill('input#depositAmount', '30');
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Deposit' }).click();

    // Wait for deposit to complete
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Deposited.*successfully/i })).toBeVisible({ timeout: 5000 });

    // Give time for the sync with GM to complete and React Query to invalidate/refetch
    // The deposit now waits for GM sync, so the pending charge should already be processed
    await page.waitForTimeout(2000);

    // Next Scheduled Payment/Refund should now be updated (no longer $0.00)
    // The exact amount will be less than $29 due to proration credit for partial month
    // WITHOUT needing to navigate away and come back
    await expect(nextPaymentSection).not.toContainText('$0.00', { timeout: 5000 });

    // Should contain a positive dollar amount (service is now in DRAFT invoice)
    const amountMatch = await nextPaymentSection.textContent();
    const hasPositiveAmount = amountMatch && /\$[1-9]\d*\.\d{2}/.test(amountMatch);
    if (!hasPositiveAmount) {
      throw new Error('Expected Next Scheduled Payment/Refund to show a positive amount after subscription activation');
    }

    console.log('  → Next Scheduled Payment/Refund updated from $0.00 to positive amount (includes proration credit)');
    console.log('✅ Next Scheduled Payment/Refund updates immediately after subscription activation');
  });
});
