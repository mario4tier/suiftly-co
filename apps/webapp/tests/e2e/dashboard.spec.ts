/**
 * E2E Dashboard Navigation Test
 * Tests Phase 9: Dashboard layout and navigation
 */

import { test, expect } from '@playwright/test';
import { resetCustomer } from '../helpers/db';

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer to production defaults (prevents test pollution from previous tests)
    await resetCustomer(request);

    // Authenticate with mock wallet before each test
    await page.goto('/');
    // Click the Mock Wallet button (button element with "Mock Wallet" text)
    await page.click('button:has-text("Mock Wallet 0")');

    // Wait for authentication and redirect to /dashboard
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
  });

  test('redirects to dashboard after authentication', async ({ page }) => {
    // Should be on /dashboard after auth
    expect(page.url()).toContain('/dashboard');

    // Should see wallet address in header
    await expect(page.locator('text=0xaaaa')).toBeVisible();
  });

  test('sidebar navigation is visible and functional', async ({ page }) => {
    // Sidebar should be visible
    await expect(page.locator('aside')).toBeVisible();

    // Should see service navigation items
    // Note: Seal and gRPC are collapsible sections, so they're not links themselves
    await expect(page.locator('aside:has-text("Seal")')).toBeVisible();
    await expect(page.locator('aside:has-text("gRPC")')).toBeVisible();
    await expect(page.locator('aside a:has-text("GraphQL")')).toBeVisible();

    // Should see account navigation items
    await expect(page.locator('aside a:has-text("Billing")')).toBeVisible();
    await expect(page.locator('aside a:has-text("Support")')).toBeVisible();
  });

  test('can navigate between dashboard pages', async ({ page }) => {
    // Navigate to gRPC (collapsible menu — click to expand, then click Overview by href)
    await page.click('text=gRPC');
    await page.locator('aside a[href="/services/grpc/overview"]').click();
    await page.waitForURL('/services/grpc/overview');
    await expect(page.locator('h1:has-text("gRPC")')).toBeVisible();

    // Navigate to Billing
    await page.click('text=Billing');
    await page.waitForURL('/billing');
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();

    // Navigate back to Seal (clicking Seal expands, then clicking Overview navigates)
    await page.click('text=Seal');
    await page.waitForURL('/services/seal/overview');
    // Page shows "Configure Seal Service" for new users or "Seal" for existing services
    await expect(page.locator('h1')).toBeVisible();
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
    // Navigate to Seal first
    await page.click('text=Seal');
    await page.waitForURL('/services/seal/overview');

    // On /services/seal/overview, the Seal Overview link should be highlighted
    const sealOverviewLink = page.locator('aside a[href="/services/seal/overview"]');
    await expect(sealOverviewLink).toHaveClass(/bg-\[#dbeafe\]/);

    // Navigate to gRPC (collapsible — expand then click Overview)
    // Use href to avoid ambiguity with Seal's Overview link
    await page.click('text=gRPC');
    await page.locator('aside a[href="/services/grpc/overview"]').click();
    await page.waitForURL('/services/grpc/overview');

    // gRPC Overview link should be highlighted
    const grpcOverviewLink = page.locator('aside a[href="/services/grpc/overview"]');
    await expect(grpcOverviewLink).toHaveClass(/bg-\[#dbeafe\]/);
  });
});
