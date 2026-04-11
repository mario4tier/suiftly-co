/**
 * gRPC API Keys on Global /api-keys Page
 *
 * Tests that the global API Keys page (/api-keys) shows gRPC API keys,
 * not just Seal keys. This is a regression test for the bug where
 * the gRPC section always showed "No API keys used yet" even when
 * gRPC API keys existed.
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { resetCustomer, ensureTestBalance, subscribePlatformService } from '../helpers/db';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('Global API Keys Page - gRPC', () => {
  test.beforeEach(async ({ page, request }) => {
    await resetCustomer(request);
    await ensureTestBalance(request, 50);

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet 0")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    await subscribePlatformService(page);
    await waitForToastsToDisappear(page);
  });

  test('gRPC section shows API keys when they exist', async ({ page }) => {
    // Navigate to /api-keys
    await page.goto('/api-keys');
    await page.waitForLoadState('networkidle');

    // gRPC section should exist with a table of keys (not "No API keys used yet")
    // The gRPC card contains: header with "gRPC" title + "Manage" link, then table of keys
    const grpcManageLink = page.locator('a[href*="/services/grpc/overview"]');
    await expect(grpcManageLink).toBeVisible({ timeout: 5000 });

    // Find the gRPC card's table (the card that contains the gRPC Manage link)
    const grpcCard = grpcManageLink.locator('xpath=ancestor::div[contains(@class, "rounded")]').first();
    const grpcTable = grpcCard.locator('table');
    await expect(grpcTable).toBeVisible({ timeout: 5000 });

    // Should have at least one key row
    const grpcKeyRows = grpcTable.locator('tbody tr');
    await expect(grpcKeyRows.first()).toBeVisible({ timeout: 5000 });

    console.log('✅ gRPC API keys visible on /api-keys page');
  });

  test('gRPC section has Manage link to gRPC service', async ({ page }) => {
    await page.goto('/api-keys');
    await page.waitForLoadState('networkidle');

    // gRPC section should have a "Manage" link pointing to gRPC overview
    const manageLink = page.locator('a[href*="/services/grpc/overview"]');
    await expect(manageLink).toBeVisible({ timeout: 5000 });

    console.log('✅ gRPC Manage link visible on /api-keys page');
  });
});
