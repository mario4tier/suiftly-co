/**
 * E2E Test: Platform Billing
 *
 * Tests platform billing flows under platform-only mode:
 * - DRAFT invoice with credit line items
 * - Next Scheduled Payment shows platform charge
 * - Billing history after platform subscription
 * - Platform tier change affects billing
 *
 * Mirrors subscription-billing-bugs.spec.ts and billing.spec.ts for platform.
 */

import { test, expect } from '../fixtures/base-test';
import {
  resetCustomer,
  authenticateWithMockWallet,
  ensureTestBalance,
  subscribePlatformService,
  setConfigFlags,
} from '../helpers/db';
import { setMockClock, resetClock } from '../helpers/clock';
import { waitAfterMutation } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';

const API_BASE = 'http://localhost:22700';

test.describe('Platform Billing', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await setConfigFlags(request, { freq_platform_sub: '1', freq_seal_sub: '0' });
    await authenticateWithMockWallet(page);
  });

  test.afterAll(async ({ request }) => {
    // Restore production default: platform-only mode
    await setConfigFlags(request, { freq_platform_sub: '1', freq_seal_sub: '0' });
  });

  // =========================================================================
  // Next Scheduled Payment
  // =========================================================================
  test.describe('Next Scheduled Payment', () => {
    test('should show platform subscription in Next Scheduled Payment', async ({ page, request }) => {
      await setMockClock(request, '2025-01-15T12:00:00Z');
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Navigate to billing page
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Next Scheduled Payment button should be visible
      const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled/ });
      await expect(nextPaymentButton).toBeVisible({ timeout: 5000 });

      // Click to expand
      await nextPaymentButton.click();

      // Should show platform subscription line item in the expanded section
      await expect(
        page.getByText('Platform Starter plan', { exact: true })
      ).toBeVisible({ timeout: 3000 });
    });

    test('should show partial month credit in Next Scheduled Payment', async ({ page, request }) => {
      // Subscribe mid-month to trigger partial month credit
      await setMockClock(request, '2025-01-15T12:00:00Z');
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'PRO');
      await waitForToastsToDisappear(page);

      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled/ });
      await expect(nextPaymentButton).toBeVisible({ timeout: 5000 });
      await nextPaymentButton.click();

      // Should show credit line item for partial month
      // Pro = $29, subscribed Jan 15, daysUsed = 31-15+1 = 17, daysNotUsed = 14
      // credit = floor(2900*14/31) = 1309 cents = $13.09
      await expect(
        page.locator('text=/partial month credit/i')
      ).toBeVisible({ timeout: 5000 });
    });

    test('should show reduced Next Scheduled Payment when large credit exists', async ({ page, request }) => {
      // Subscribe to Pro near end of month → large partial-month credit
      await setMockClock(request, '2025-01-29T12:00:00Z');
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'PRO');
      await waitForToastsToDisappear(page);

      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Jan 29: daysUsed = 31-29+1 = 3, daysNotUsed = 28
      // credit = floor(2900*28/31) = 2619 cents = $26.19, DRAFT = $29 - $26.19 = $2.81
      const nextPaymentButton = page.locator('button').filter({ hasText: /Next Scheduled/ });
      await expect(nextPaymentButton).toBeVisible({ timeout: 5000 });

      // Verify the amount is reduced (< $29 Pro price, since credit offsets it)
      await expect(nextPaymentButton).toContainText('$2.81');
    });
  });

  // =========================================================================
  // Billing History
  // =========================================================================
  test.describe('Billing History', () => {
    test('should show platform charge in billing history', async ({ page, request }) => {
      await ensureTestBalance(request, 100);
      await subscribePlatformService(page, 'STARTER');
      await waitForToastsToDisappear(page);

      // Navigate to billing
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Expand billing history
      const billingHistoryHeader = page.locator('h2:has-text("Billing History")');
      if (await billingHistoryHeader.isVisible({ timeout: 3000 }).catch(() => false)) {
        await billingHistoryHeader.click();
      }

      // Should show at least one transaction (platform subscription)
      await expect(
        page.locator('text=/\\$1\\.00|\\$0\\.01/') // Platform Starter = $1
      ).toBeVisible({ timeout: 5000 });
    });
  });

  // =========================================================================
  // Escrow Balance After Subscription
  // =========================================================================
  test.describe('Escrow Integration', () => {
    test('should deduct platform subscription from escrow balance', async ({ page, request }) => {
      // Set exact balance
      await ensureTestBalance(request, 10);

      // Navigate to billing to add payment + subscribe
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Add crypto payment
      const addCryptoButton = page.locator('[data-testid="add-crypto-payment"]');
      const cryptoRow = page.locator('text=/Suiftly Escrow/i').first();
      await expect(addCryptoButton.or(cryptoRow)).toBeVisible({ timeout: 5000 });
      if (await addCryptoButton.isVisible()) {
        await addCryptoButton.click();
        await waitAfterMutation(page);
      }

      // Subscribe to Starter ($1)
      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();
      await waitAfterMutation(page);
      await waitForToastsToDisappear(page);

      // Verify escrow balance decreased via API (was $10, now should be $9)
      const balanceResp = await request.get(`${API_BASE}/test/wallet/balance`);
      const balanceData = await balanceResp.json();
      expect(balanceData.balanceUsd).toBe(9);
    });
  });

  // =========================================================================
  // Platform Tier Pricing Display
  // =========================================================================
  test.describe('Tier Pricing', () => {
    test('Starter ($1) should succeed with exact funds', async ({ page, request }) => {
      await ensureTestBalance(request, 1);
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Add crypto payment
      const addCryptoButton = page.locator('[data-testid="add-crypto-payment"]');
      const cryptoRow = page.locator('text=/Suiftly Escrow/i').first();
      await expect(addCryptoButton.or(cryptoRow)).toBeVisible({ timeout: 5000 });
      if (await addCryptoButton.isVisible()) {
        await addCryptoButton.click();
        await waitAfterMutation(page);
      }

      // Subscribe Starter
      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Starter Plan")').click();

      // Should succeed (exact $1 available)
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: /Subscribed to Platform/i })
      ).toBeVisible({ timeout: 10000 });
    });

    test('Pro ($29) should succeed with exact funds', async ({ page, request }) => {
      await ensureTestBalance(request, 29);
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });

      // Add crypto payment
      const addCryptoButton = page.locator('[data-testid="add-crypto-payment"]');
      const cryptoRow = page.locator('text=/Suiftly Escrow/i').first();
      await expect(addCryptoButton.or(cryptoRow)).toBeVisible({ timeout: 5000 });
      if (await addCryptoButton.isVisible()) {
        await addCryptoButton.click();
        await waitAfterMutation(page);
      }

      // Select Pro tier
      await page.locator('text=Pro').first().click();

      // Subscribe
      await page.locator('#platform-tos').click();
      await waitAfterMutation(page);
      await page.locator('button:has-text("Subscribe to Pro Plan")').click();

      // Should succeed (exact $29 available)
      await expect(
        page.locator('[data-sonner-toast]').filter({ hasText: /Subscribed to Platform/i })
      ).toBeVisible({ timeout: 10000 });
    });
  });

  // =========================================================================
  // Downgrade Recalculates FAILED Invoice
  // =========================================================================
  test.describe('Downgrade Recalculation', () => {
    const MOCK_WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const GM_BASE = 'http://localhost:22600';
    const PRO_PRICE = 29;
    const STARTER_PRICE = 1;

    test('should recalculate FAILED invoice from Pro to Starter price after downgrade', async ({ page, request }) => {
      // Step 1: Subscribe to Pro on Jan 1
      await setMockClock(request, '2025-01-01T00:00:01Z');
      await ensureTestBalance(request, PRO_PRICE + 15);
      await subscribePlatformService(page, 'PRO');
      await waitForToastsToDisappear(page);

      // Step 2: Advance to Feb 1 and zero the balance (force FAILED invoice)
      await setMockClock(request, '2025-02-01T00:00:01Z');

      const balResp = await request.get(`${API_BASE}/test/wallet/balance`, {
        params: { walletAddress: MOCK_WALLET },
      });
      const balData = await balResp.json();
      if (balData.found && balData.balanceUsd > 0) {
        await request.post(`${API_BASE}/test/wallet/withdraw`, {
          data: { walletAddress: MOCK_WALLET, amountUsd: balData.balanceUsd },
        });
      }

      // Step 3: Run periodic billing → creates FAILED invoice at Pro price ($29)
      const sync1 = await request.post(`${GM_BASE}/api/queue/sync-all?source=test`);
      expect(sync1.ok()).toBe(true);

      // Step 4: Schedule downgrade Pro → Starter
      await page.click('text=Billing');
      await page.waitForURL('/billing', { timeout: 5000 });
      await page.reload();
      await page.waitForLoadState('networkidle');

      await page.locator('text=Change Plan').click();
      const changePlanDialog = page.locator('[role="dialog"]').first();
      await expect(changePlanDialog).toBeVisible({ timeout: 5000 });
      await changePlanDialog.locator('h4:has-text("STARTER")').click();
      // Confirmation appears as a separate AlertDialog overlay
      await page.locator('button:has-text("Schedule Downgrade")').click();
      await waitAfterMutation(page);
      // Wait for dialog to close (downgrade scheduled)
      await expect(changePlanDialog).not.toBeVisible({ timeout: 10000 });

      // Step 5: Deposit enough for Starter ($1) but not Pro ($29)
      const retryDeposit = STARTER_PRICE + 5;
      await request.post(`${API_BASE}/test/wallet/deposit`, {
        data: { walletAddress: MOCK_WALLET, amountUsd: retryDeposit },
      });

      // Capture balance before retry
      const beforeResp = await request.get(`${API_BASE}/test/wallet/balance`, {
        params: { walletAddress: MOCK_WALLET },
      });
      const balanceBefore = (await beforeResp.json()).balanceUsd;

      // Step 6: Advance past 24h retry cooldown and run billing
      await setMockClock(request, '2025-02-02T01:00:00Z');
      const sync2 = await request.post(`${GM_BASE}/api/queue/sync-all?source=test`);
      expect(sync2.ok()).toBe(true);

      // Step 7: Assert — charged ~Starter price (not Pro)
      const afterResp = await request.get(`${API_BASE}/test/wallet/balance`, {
        params: { walletAddress: MOCK_WALLET },
      });
      const balanceAfter = (await afterResp.json()).balanceUsd;
      const amountCharged = balanceBefore - balanceAfter;

      expect(amountCharged).toBeGreaterThanOrEqual(STARTER_PRICE - 0.5);
      expect(amountCharged).toBeLessThanOrEqual(STARTER_PRICE + 0.5);

      await resetClock(request);
    });
  });
});
