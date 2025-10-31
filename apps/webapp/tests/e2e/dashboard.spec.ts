/**
 * E2E Dashboard Navigation Test
 * Tests Phase 9: Dashboard layout and navigation
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate with mock wallet before each test
    await page.goto('/');
    await page.click('text=Connect Mock Wallet');

    // Wait for authentication and redirect to /services/seal (default home)
    await page.waitForURL('/services/seal', { timeout: 10000 });
  });

  test('redirects to seal service after authentication', async ({ page }) => {
    // Should be on /services/seal after auth (default home)
    expect(page.url()).toContain('/services/seal');

    // Should see Seal heading
    await expect(page.locator('h1:has-text("Seal")')).toBeVisible();

    // Should see wallet address in header
    await expect(page.locator('text=0xaaaa')).toBeVisible();
  });

  test('sidebar navigation is visible and functional', async ({ page }) => {
    // Sidebar should be visible
    await expect(page.locator('aside')).toBeVisible();

    // Should see service navigation items (use link selector to be specific)
    await expect(page.locator('aside a:has-text("Seal")')).toBeVisible();
    await expect(page.locator('aside a:has-text("gRPC")')).toBeVisible();
    await expect(page.locator('aside a:has-text("GraphQL")')).toBeVisible();

    // Should see account navigation items
    await expect(page.locator('aside a:has-text("Billing")')).toBeVisible();
    await expect(page.locator('aside a:has-text("Support")')).toBeVisible();
  });

  test('can navigate between dashboard pages', async ({ page }) => {
    // Navigate to gRPC
    await page.click('text=gRPC');
    await page.waitForURL('/services/grpc');
    await expect(page.locator('h2:has-text("gRPC")')).toBeVisible();

    // Navigate to Billing
    await page.click('text=Billing');
    await page.waitForURL('/billing');
    await expect(page.locator('h2:has-text("Billing & Usage")')).toBeVisible();

    // Navigate back to Seal
    await page.click('text=Seal');
    await page.waitForURL('/services/seal');
    await expect(page.locator('h1:has-text("Seal")')).toBeVisible();
  });

  test('header is visible on all pages', async ({ page }) => {
    // Header should be visible
    await expect(page.locator('header')).toBeVisible();

    // Logo should be visible
    await expect(page.locator('text=Suiftly')).toBeVisible();

    // Wallet button showing address should be visible
    await expect(page.locator('button:has-text("0xaaaa")')).toBeVisible();

    // Navigate to Billing - header should still be visible
    await page.click('text=Billing');
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('button:has-text("0xaaaa")')).toBeVisible();
  });

  test('active navigation item is highlighted', async ({ page }) => {
    // On /services/seal, Seal should be highlighted
    const sealLink = page.locator('a:has-text("Seal")');
    await expect(sealLink).toHaveClass(/bg-blue-50/);

    // Navigate to gRPC
    await page.click('text=gRPC');
    await page.waitForURL('/services/grpc');

    // gRPC should now be highlighted
    const grpcLink = page.locator('a:has-text("gRPC")');
    await expect(grpcLink).toHaveClass(/bg-blue-50/);
  });
});
