/**
 * FAILED Invoice Recalculation on Tier Change - E2E Bug Detection Test
 *
 * BUG: When a paidOnce=true customer has a FAILED monthly billing invoice and
 * then changes tiers (downgrade), the FAILED invoice amount is NOT recalculated.
 * Payment retries continue using the old (frozen) tier price.
 *
 * Example: Customer on Enterprise fails monthly billing.
 * Customer downgrades to Starter. Retry still tries Enterprise price —
 * customer can't pay even though they could afford Starter price.
 *
 * Root cause:
 * - tier-changes.ts: scheduleTierDowngradeLocked() only sets scheduledTier
 *   and recalculates DRAFT; ignores existing PENDING/FAILED invoices
 * - processor.ts: retryFailedPayments() retries at frozen amountUsdCents
 *   without checking tier changes
 *
 * This test asserts the DESIRED (fixed) behavior.
 * It should FAIL now (proving the bug), and PASS after the fix.
 */

import { test, expect } from '@playwright/test';
import { resetCustomer, addCryptoPayment, subscribePlatformService } from '../helpers/db';
import { setMockClock, resetClock } from '../helpers/clock';
import { PLATFORM_TIER_PRICES_USD_CENTS } from '@suiftly/shared/pricing';

const MOCK_WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_BASE = 'http://localhost:22700';
const GM_BASE = 'http://localhost:22600';

const STARTER_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.starter; // cents
const PRO_PRICE = PLATFORM_TIER_PRICES_USD_CENTS.pro; // cents
const STARTER_PRICE_USD = STARTER_PRICE / 100;
const PRO_PRICE_USD = PRO_PRICE / 100;

test.describe('FAILED Invoice Recalculation on Tier Change', () => {
  test(`BUG: downgrade should recalculate FAILED invoice amount from Pro ($${PRO_PRICE_USD}) to Starter ($${STARTER_PRICE_USD})`, async ({ page }) => {
    // ── Step 1: Set clock to Jan 1 ──────────────────────────────────────
    // Subscribe on the 1st to avoid partial-month reconciliation credit
    // complexity (mid-month subscription creates credits that contaminate
    // balance assertions).
    await setMockClock(page.request, '2025-01-01T00:00:01Z');

    // ── Step 2: Reset customer, deposit enough to cover Pro, set up escrow
    await resetCustomer(page.request);

    // Deposit enough to cover Pro subscription + buffer
    const initialDepositUsd = PRO_PRICE_USD + 15;
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: initialDepositUsd,
        initialSpendingLimitUsd: 250,
      },
    });

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Add crypto payment method (required for escrow to work)
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });
    await addCryptoPayment(page);

    // ── Step 3: Subscribe to Platform Pro ──────────────────────────────
    await subscribePlatformService(page, 'PRO');

    // ── Step 4: Advance clock to Feb 1 ──────────────────────────────────
    await setMockClock(page.request, '2025-02-01T00:00:01Z');

    // ── Step 5: Withdraw all funds (force $0 balance) ───────────────────
    // Get current balance first
    const balanceResp = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const balanceData = await balanceResp.json();
    if (balanceData.found && balanceData.balanceUsd > 0) {
      await page.request.post(`${API_BASE}/test/wallet/withdraw`, {
        data: {
          walletAddress: MOCK_WALLET_ADDRESS,
          amountUsd: balanceData.balanceUsd,
        },
      });
    }

    // Verify balance is $0
    const zeroBalResp = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const zeroBalData = await zeroBalResp.json();
    expect(zeroBalData.balanceUsd).toBe(0);

    // ── Step 6: Run periodic billing → FAILED invoice at Enterprise price
    // Trigger GM sync-all which runs periodic billing (monthly cycle + retries)
    const syncResp1 = await page.request.post(`${GM_BASE}/api/queue/sync-all?source=test`);
    expect(syncResp1.ok()).toBe(true);

    // ── Step 7: Schedule downgrade to Starter via UI ────────────────────
    // Navigate to billing page for platform tier change
    await page.click('text=Billing');
    await page.waitForURL('/billing', { timeout: 5000 });

    // Reload to ensure fresh state after billing run
    await page.reload();
    // Don't use networkidle — billing page may poll while GM is processing sync-all.
    // Wait directly for the button we need.

    // Open Change Plan modal
    await page.locator('button:has-text("Change Plan")').click();
    await expect(page.getByLabel('Change Plan')).toBeVisible({ timeout: 5000 });

    // Select Starter tier (downgrade)
    await page.locator('h4:has-text("STARTER")').click();

    // Confirm the scheduled downgrade
    await page.locator('button:has-text("Schedule Downgrade")').click();

    // Wait for modal to close
    await expect(page.getByLabel('Change Plan')).not.toBeVisible({ timeout: 5000 });

    // ── Step 8: Deposit enough for Starter but NOT Enterprise ───────────
    // Deposit Starter price + small buffer, well below Enterprise price.
    // If the bug is fixed, the retry will charge Starter price and succeed.
    // If the bug exists, the retry will try Enterprise price and fail.
    const retryDepositUsd = STARTER_PRICE_USD + 6;
    await page.request.post(`${API_BASE}/test/wallet/deposit`, {
      data: {
        walletAddress: MOCK_WALLET_ADDRESS,
        amountUsd: retryDepositUsd,
      },
    });

    // Capture balance before retry
    const beforeRetryResp = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const beforeRetryData = await beforeRetryResp.json();
    const balanceBeforeRetry = beforeRetryData.balanceUsd;
    console.log(`Balance before retry: $${balanceBeforeRetry}`);

    // ── Step 9: Advance clock past retry cooldown (24h strict <) ─────────
    // The first failure at Feb 1 00:00:01Z sets lastRetryAt.
    // retryThreshold = now - 24h. We need lastRetryAt < retryThreshold,
    // so advance at least 1 second past the 24h boundary.
    await setMockClock(page.request, '2025-02-02T01:00:00Z');

    // ── Step 10: Run periodic billing (retries FAILED invoice) ──────────
    const syncResp2 = await page.request.post(`${GM_BASE}/api/queue/sync-all?source=test`);
    expect(syncResp2.ok()).toBe(true);

    // ── Assertions ──────────────────────────────────────────────────────
    // Check balance after retry
    const afterRetryResp = await page.request.get(`${API_BASE}/test/wallet/balance`, {
      params: { walletAddress: MOCK_WALLET_ADDRESS },
    });
    const afterRetryData = await afterRetryResp.json();
    const balanceAfterRetry = afterRetryData.balanceUsd;
    console.log(`Balance after retry: $${balanceAfterRetry}`);

    // Assertion 1: Balance should have decreased (payment went through)
    // If balance is unchanged, the retry failed → bug exists
    expect(balanceAfterRetry).toBeLessThan(balanceBeforeRetry);

    // Assertion 2: The decrease should be ~Starter price, not Enterprise price
    const amountCharged = balanceBeforeRetry - balanceAfterRetry;
    console.log(`Amount charged: $${amountCharged} (expected ~$${STARTER_PRICE_USD})`);

    // Allow small tolerance for rounding
    expect(amountCharged).toBeGreaterThanOrEqual(STARTER_PRICE_USD - 0.5);
    expect(amountCharged).toBeLessThanOrEqual(STARTER_PRICE_USD + 0.5);

    // Clean up
    await resetClock(page.request);
  });
});
