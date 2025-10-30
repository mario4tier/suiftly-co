/**
 * E2E Dashboard Navigation Test
 * Tests Phase 9: Dashboard layout and navigation
 */

import { test, expect } from '@playwright/test';

test.describe('Dashboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate with mock wallet before each test
    await page.goto('/');
    await page.click('text=Connect Wallet');
    await page.click('text=Connect Mock Wallet');

    // Wait for authentication and redirect to dashboard
    await page.waitForURL('/dashboard', { timeout: 10000 });
  });

  test('redirects to dashboard after authentication', async ({ page }) => {
    // Should be on dashboard after auth
    expect(page.url()).toContain('/dashboard');

    // Should see dashboard heading
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible();

    // Should see wallet address in welcome section
    await expect(page.locator('text=0xaaaa')).toBeVisible();
  });

  test('sidebar navigation is visible and functional', async ({ page }) => {
    // Sidebar should be visible
    await expect(page.locator('aside')).toBeVisible();

    // Should see navigation items
    await expect(page.locator('text=Overview')).toBeVisible();
    await expect(page.locator('text=Services')).toBeVisible();
    await expect(page.locator('text=Billing')).toBeVisible();
    await expect(page.locator('text=API Keys')).toBeVisible();
    await expect(page.locator('text=Logs')).toBeVisible();
    await expect(page.locator('text=Settings')).toBeVisible();
  });

  test('can navigate between dashboard pages', async ({ page }) => {
    // Navigate to Services
    await page.click('text=Services');
    await page.waitForURL('/services');
    await expect(page.locator('h1:has-text("Services")')).toBeVisible();

    // Navigate to Billing
    await page.click('text=Billing');
    await page.waitForURL('/billing');
    await expect(page.locator('h1:has-text("Billing")')).toBeVisible();

    // Navigate to API Keys
    await page.click('text=API Keys');
    await page.waitForURL('/api-keys');
    await expect(page.locator('h1:has-text("API Keys")')).toBeVisible();

    // Navigate back to Dashboard
    await page.click('text=Overview');
    await page.waitForURL('/dashboard');
    await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible();
  });

  test('header is visible on all pages', async ({ page }) => {
    // Header should be visible
    await expect(page.locator('header')).toBeVisible();

    // Logo should be visible
    await expect(page.locator('text=Suiftly')).toBeVisible();

    // Wallet button showing address should be visible
    await expect(page.locator('button:has-text("0xaaaa")')).toBeVisible();

    // Navigate to Services - header should still be visible
    await page.click('text=Services');
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('button:has-text("0xaaaa")')).toBeVisible();
  });

  test('active navigation item is highlighted', async ({ page }) => {
    // On dashboard, Overview should be highlighted
    const overviewLink = page.locator('a:has-text("Overview")');
    await expect(overviewLink).toHaveClass(/bg-blue-100/);

    // Navigate to Services
    await page.click('text=Services');
    await page.waitForURL('/services');

    // Services should now be highlighted
    const servicesLink = page.locator('a:has-text("Services")');
    await expect(servicesLink).toHaveClass(/bg-blue-100/);
  });
});
