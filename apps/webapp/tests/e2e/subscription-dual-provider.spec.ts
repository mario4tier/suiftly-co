/**
 * Dual-Provider Subscription E2E Tests
 *
 * Runs the same subscription scenarios with both escrow and stripe providers
 * sequentially, validating that both payment paths produce identical outcomes.
 *
 * - **escrow**: Uses test escrow account with deposited funds.
 * - **stripe**: Uses real Stripe sandbox (test keys). Skipped if Stripe keys
 *   are not configured in ~/.suiftly.env.
 *
 * Existing escrow-only tests (subscription-pricing, service-toggle) are preserved.
 * This file adds coverage for stripe-backed subscriptions using the same flows.
 */

import { test, expect } from '@playwright/test';
import { setupPaymentProvider, subscribePlatformService } from '../helpers/db';
import { getStripePublishableKey } from '../helpers/stripe';
import { waitAfterMutation, waitForCondition } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';

const API_BASE = 'http://localhost:22700';

/** Tier pricing (USD) */
const TIERS = [
  { name: 'STARTER', price: 1 },
  { name: 'PRO', price: 29 },
] as const;

for (const provider of ['escrow', 'stripe'] as const) {
  test.describe(`Subscription via ${provider}`, () => {
    // Stripe sandbox tests need longer timeouts for real Stripe API + webhooks
    if (provider === 'stripe') {
      test.setTimeout(120000);
    }

    test.beforeEach(async ({ page, request }) => {
      if (provider === 'stripe') {
        // Disable force-mock to check for real Stripe keys
        await request.post(`${API_BASE}/test/stripe/force-mock`, {
          data: { enabled: false },
        });
        const key = await getStripePublishableKey(request);
        test.skip(!key, 'Stripe sandbox keys not configured');
      }

      // Reset customer: zero balance, no escrow account, no services
      await request.post(`${API_BASE}/test/data/reset`, {
        data: {
          balanceUsdCents: 0,
          spendingLimitUsdCents: 25000,
          clearEscrowAccount: true,
        },
      });

      // Authenticate
      await page.context().clearCookies();
      await page.goto('/');
      await page.click('button:has-text("Mock Wallet 0")');
      await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
      await waitAfterMutation(page);
    });

    test.afterEach(async ({ request }) => {
      if (provider === 'stripe') {
        // Re-enable force-mock so subsequent non-sandbox suites use the mock
        await request.post(`${API_BASE}/test/stripe/force-mock`, {
          data: { enabled: true },
        });
      }
    });

    for (const tier of TIERS) {
      test(`${tier.name} subscription succeeds ($${tier.price})`, async ({ page, request }) => {
        // Set up payment provider (escrow deposits exact amount; stripe adds real card)
        await setupPaymentProvider(page, request, provider, tier.price);

        const successTimeout = provider === 'stripe' ? 30000 : 10000;
        await subscribePlatformService(page, tier.name as 'STARTER' | 'PRO', { successTimeout, expectSuccess: true });

        // Navigate to seal to verify auto-provisioned seal service
        await page.goto('/services/seal/overview');
        await page.waitForLoadState('networkidle');

        // Should show service disabled banner
        await expect(
          page.locator('text=/Service is currently OFF/i')
        ).toBeVisible({ timeout: 5000 });

        console.log(`  ${tier.name} via ${provider}: subscription succeeded`);
      });
    }

    test('toggle enable/disable works after subscription', async ({ page, request }) => {
      // Use STARTER (cheapest tier)
      await setupPaymentProvider(page, request, provider, 1);

      const successTimeout = provider === 'stripe' ? 30000 : 10000;
      await subscribePlatformService(page, 'STARTER', { successTimeout });
      await waitForToastsToDisappear(page);

      // Navigate to seal overview after platform subscription
      await page.goto('/services/seal/overview');
      await page.waitForLoadState('networkidle');

      // Verify initial state: disabled
      const initialService = await request.get(
        `${API_BASE}/test/data/service-instance?serviceType=seal`
      );
      const initialData = await initialService.json();
      expect(initialData.isUserEnabled).toBe(false);

      // Toggle ON
      const toggle = page.locator('#service-toggle');
      await toggle.click();
      await waitAfterMutation(page);

      // Poll until database reflects enabled state
      await waitForCondition(
        async () => {
          const resp = await request.get(`${API_BASE}/test/data/service-instance?serviceType=seal`);
          const data = await resp.json();
          return data.isUserEnabled === true && data.state === 'enabled';
        },
        { timeout: 5000, message: 'Service to be enabled in database' }
      );

      // Toggle OFF
      await toggle.click();
      await waitAfterMutation(page);

      // Poll until database reflects disabled state
      await waitForCondition(
        async () => {
          const resp = await request.get(`${API_BASE}/test/data/service-instance?serviceType=seal`);
          const data = await resp.json();
          return data.isUserEnabled === false && data.state === 'disabled';
        },
        { timeout: 5000, message: 'Service to be disabled in database' }
      );

      console.log(`  Toggle via ${provider}: enable/disable works`);
    });
  });
}
