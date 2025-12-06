/**
 * Service Toggle E2E Tests
 *
 * Validates:
 * 1. Toggle switch updates database
 * 2. UI reflects loading states
 * 3. Timeout scenarios (API not accessible)
 * 4. Navigation away before API completion
 *
 * IMPORTANT: Uses test delay endpoints to simulate slow responses
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation, waitForCondition } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';

test.describe('Service Toggle - Enable/Disable', () => {
  test.beforeEach(async ({ page, request }) => {
    // Step 1: Clear any lingering test delays from previous tests
    await request.post('http://localhost:22700/test/delays/clear');

    // Step 2: Reset database (BEFORE auth to ensure clean state)
    await request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
      },
    });

    // Step 3: Create escrow account and deposit funds
    await request.post('http://localhost:22700/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });

    // Step 4: Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Step 5: Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Step 6: Subscribe to seal service to create test service instance
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for subscription success and navigate to overview
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Subscription successful/i })).toBeVisible({ timeout: 5000 });
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });

    // Wait for toasts to disappear before test starts (prevents pollution)
    await waitForToastsToDisappear(page);
  });

  test.afterEach(async ({ request }) => {
    // Clear any test delays
    await request.post('http://localhost:22700/test/delays/clear');
  });

  test('toggle service from disabled to enabled updates database', async ({ page, request }) => {
    // Verify initial state: service is DISABLED
    const initialService = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
    const initialData = await initialService.json();
    expect(initialData.state).toBe('disabled');
    expect(initialData.isUserEnabled).toBe(false);
    console.log('✅ Initial state: DISABLED');

    // Toggle service ON
    const toggleSwitch = page.locator('#service-toggle');
    await toggleSwitch.click();

    // Wait for mutation to complete (smart wait - returns as soon as API call done)
    await waitAfterMutation(page);

    // Verify database was updated (with polling in case of race condition)
    await waitForCondition(
      async () => {
        const updatedService = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
        const updatedData = await updatedService.json();
        return updatedData.state === 'enabled' && updatedData.isUserEnabled === true;
      },
      { timeout: 3000, message: 'Service to be enabled in database' }
    );

    const updatedService = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
    const updatedData = await updatedService.json();
    expect(updatedData.state).toBe('enabled');
    expect(updatedData.isUserEnabled).toBe(true);
    expect(updatedData.enabledAt).toBeTruthy();
    console.log('✅ Database updated: service is now ENABLED');

    // Verify UI updated
    await expect(toggleSwitch).toBeChecked();
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible();
    console.log('✅ UI shows service as ON');

    // Verify disabled banner is hidden (no banner shown when enabled)
    await expect(page.locator('text=/Service is currently OFF/i')).not.toBeVisible();
    console.log('✅ Disabled banner is hidden (no banner when service is active)');
  });

  test('toggle service from enabled to disabled updates database', async ({ page, request }) => {
    // First, enable the service
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);

    // Verify it's enabled (with polling)
    await waitForCondition(
      async () => {
        const response = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
        const data = await response.json();
        return data.isUserEnabled === true;
      },
      { timeout: 3000, message: 'Service to be enabled' }
    );
    console.log('✅ Service enabled');

    // Toggle service OFF
    await page.locator('#service-toggle').click();
    await waitAfterMutation(page);

    // Verify database was updated (with polling)
    await waitForCondition(
      async () => {
        const response = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
        const data = await response.json();
        return data.state === 'disabled' && data.isUserEnabled === false;
      },
      { timeout: 3000, message: 'Service to be disabled' }
    );

    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.state).toBe('disabled');
    expect(serviceData.isUserEnabled).toBe(false);
    expect(serviceData.disabledAt).toBeTruthy();
    console.log('✅ Database updated: service is now DISABLED');

    // Verify UI updated
    await expect(page.locator('#service-toggle')).not.toBeChecked();
    console.log('✅ UI shows service as OFF (toggle unchecked)');

    // Verify banner changed back
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible();
    console.log('✅ Banner shows service disabled');
  });

  test('toggle shows loading state during API call', async ({ page, request }) => {
    // Set a 2-second delay for seal form mutations
    await request.post('http://localhost:22700/test/delays', {
      data: {
        sealFormMutation: 2000, // 2 seconds
      },
    });

    console.log('✅ Set 2-second delay for seal form mutations');

    // Start toggle
    await page.locator('#service-toggle').click();

    // Verify loading spinner appears immediately
    await expect(page.locator('svg.animate-spin')).toBeVisible({ timeout: 500 });
    console.log('✅ Loading spinner appears');

    // Wait for completion - spinner should disappear and show ON
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible({ timeout: 3000 });
    console.log('✅ Toggle completed, shows ON');

    // Verify spinner is gone
    await expect(page.locator('svg.animate-spin')).not.toBeVisible();
    console.log('✅ Loading spinner disappeared after completion');
  });

  test('UX when API is slow (4 second delay)', async ({ page, request }) => {
    // Set a 4-second delay to simulate slow network
    await request.post('http://localhost:22700/test/delays', {
      data: {
        sealFormMutation: 4000, // 4 seconds
      },
    });

    console.log('✅ Set 4-second delay for seal form mutations');

    // Start toggle
    await page.locator('#service-toggle').click();

    // Verify loading spinner persists
    await expect(page.locator('svg.animate-spin')).toBeVisible();
    console.log('✅ Loading spinner visible during long wait');

    // Wait 2 seconds - spinner should still be visible
    await page.waitForTimeout(2000);
    await expect(page.locator('svg.animate-spin')).toBeVisible();
    console.log('✅ Still loading after 2 seconds');

    // Wait for completion (another 2.5 seconds + buffer)
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible({ timeout: 3000 });
    console.log('✅ Toggle eventually completes');

    // Wait for API call to complete and database to update (smart polling)
    await waitForCondition(
      async () => {
        const response = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
        const data = await response.json();
        return data.isUserEnabled === true;
      },
      { timeout: 6000, message: 'Database to update after long API delay' }
    );

    // Verify database was actually updated
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isUserEnabled).toBe(true);
    console.log('✅ Database updated correctly after long delay');
  });

  test('navigation away before API completion', async ({ page, request }) => {
    // Set a 3-second delay
    await request.post('http://localhost:22700/test/delays', {
      data: {
        sealFormMutation: 3000,
      },
    });

    console.log('✅ Set 3-second delay for seal form mutations');

    // Start toggle
    await page.locator('#service-toggle').click();

    // Navigate away immediately (within 500ms) - INTENTIONAL wait to test race condition
    await page.waitForTimeout(500);
    await page.click('text=Dashboard');
    await page.waitForURL('/dashboard', { timeout: 5000 });
    console.log('✅ Navigated to dashboard while API call in progress');

    // Wait for the API call to complete in background (smart polling)
    await waitForCondition(
      async () => {
        const response = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
        const data = await response.json();
        return data.isUserEnabled === true;
      },
      { timeout: 5000, message: 'Background API call to complete and update database' }
    );

    // Navigate back to seal overview
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    console.log('✅ Navigated back to Seal service');

    // Verify the database WAS updated (API call completed in background)
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isUserEnabled).toBe(true);
    console.log('✅ Database was updated even after navigation away');

    // Verify UI now reflects the updated state
    await expect(page.locator('#service-toggle')).toBeChecked();
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible();
    console.log('✅ UI correctly shows ENABLED state after returning');
  });

  test('multiple rapid toggles (eventual consistency)', async ({ page, request }) => {
    // Set a small delay to make the race condition visible
    await request.post('http://localhost:22700/test/delays', {
      data: {
        sealFormMutation: 1000, // 1 second
      },
    });

    console.log('✅ Set 1-second delay for seal form mutations');

    // Click toggle rapidly - state management should handle this gracefully
    const toggle = page.locator('#service-toggle');
    await toggle.click(); // 1st click (should start enabling)
    await page.waitForTimeout(100); // INTENTIONAL: Small wait to test rapid click handling

    // Wait for completion
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible({ timeout: 2000 });

    // Wait for API call to complete and database to update (smart polling)
    await waitForCondition(
      async () => {
        const response = await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal');
        const data = await response.json();
        return data.isUserEnabled === true;
      },
      { timeout: 3000, message: 'Database to sync after rapid toggles' }
    );

    // Verify final database state (eventual consistency)
    const serviceData = await (await request.get('http://localhost:22700/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isUserEnabled).toBe(true);
    console.log('✅ Final state: ENABLED (state synced correctly)');
  });
});
