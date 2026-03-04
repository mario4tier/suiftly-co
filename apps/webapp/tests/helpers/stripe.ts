/**
 * Stripe sandbox test helpers
 *
 * Shared utilities for interacting with real Stripe Elements (test mode).
 * Used by stripe-sandbox.spec.ts and subscription-dual-provider.spec.ts.
 */

import type { APIRequestContext, Frame, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { PORT } from '@suiftly/shared/constants';
import { waitAfterMutation } from './wait-utils';

const API_BASE = `http://localhost:${PORT.API}`;

/**
 * Check if real Stripe is configured by querying the config endpoint.
 * Returns the publishable key if set, empty string otherwise.
 */
export async function getStripePublishableKey(request: APIRequestContext): Promise<string> {
  try {
    const resp = await request.get(`${API_BASE}/i/api/config.getFrontendConfig`);
    const data = await resp.json();
    return data?.result?.data?.stripePublishableKey || '';
  } catch {
    return '';
  }
}

/**
 * Find a Stripe frame that contains the given text.
 * Stripe renders PaymentElement in multiple iframes — this finds the right one.
 */
export async function findStripeFrame(page: Page, text: string, timeout = 15000): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const el = frame.locator(`text=${text}`).first();
        if (await el.isVisible({ timeout: 300 })) {
          return frame;
        }
      } catch { /* frame may not be ready yet */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find Stripe frame containing "${text}" within ${timeout}ms`);
}

/**
 * Find a Stripe frame that contains an input with the given name.
 */
export async function findStripeInputFrame(page: Page, inputName: string, timeout = 15000): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const el = frame.locator(`input[name="${inputName}"]`).first();
        if (await el.isVisible({ timeout: 300 })) {
          return frame;
        }
      } catch { /* frame may not be ready yet */ }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find Stripe frame with input[name="${inputName}"] within ${timeout}ms`);
}

/**
 * Fill in the Stripe PaymentElement card form.
 *
 * PaymentElement renders inside Stripe-controlled iframes. The layout shows
 * payment method tabs (Card, Bank) — we click "Card", then fill the form.
 */
export async function fillStripeCard(page: Page, {
  number = '4242424242424242',
  expiry = '1230',
  cvc = '123',
} = {}) {
  // Step 1: Find the frame with payment method tabs and click "Card"
  const tabFrame = await findStripeFrame(page, 'Card', 15000);
  await tabFrame.locator('text=Card').first().click();

  // Wait for card fields to appear (may be in same or different frame)
  await page.waitForTimeout(1500);

  // Step 2: Find the frame with card number input and fill fields
  const cardFrame = await findStripeInputFrame(page, 'number', 10000);

  await cardFrame.locator('input[name="number"]').fill(number);
  await cardFrame.locator('input[name="expiry"]').fill(expiry);
  await cardFrame.locator('input[name="cvc"]').fill(cvc);

  // Fill postal/zip if present
  const postalInput = cardFrame.locator('input[name="postalCode"]');
  if (await postalInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await postalInput.fill('10001');
  }
}

/**
 * Add a credit card via real Stripe Elements on the billing page.
 *
 * Opens the card dialog, fills the Stripe PaymentElement form with test card
 * details, confirms setup, and waits for the card to appear in the payment
 * methods list (webhook must fire to update card brand/last4).
 *
 * Assumes: page is on /billing, force-mock is disabled, Stripe keys are configured.
 */
export async function addSandboxCreditCard(page: Page): Promise<void> {
  const addButton = page.locator('[data-testid="add-credit-card"]');
  await expect(addButton).toBeVisible();
  await addButton.click();

  // Wait for dialog
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Fill Stripe Elements card form
  await fillStripeCard(page);

  // Click "Add Card"
  const addCardButton = dialog.locator('button:has-text("Add Card")');
  await expect(addCardButton).toBeEnabled({ timeout: 5000 });
  await addCardButton.click();

  // Wait for dialog to close (confirmSetup succeeded)
  await expect(dialog).not.toBeVisible({ timeout: 30000 });

  await waitAfterMutation(page);

  // Wait for card to appear in payment methods list (webhook fires async)
  const creditCardRow = page.locator('[data-testid="payment-method-row"]').filter({ hasText: 'Credit Card' });
  await expect(creditCardRow).toBeVisible({ timeout: 15000 });

  // Wait for webhook to update card details (Visa 4242)
  await expect(creditCardRow).toContainText('Visa', { timeout: 15000 });
}
