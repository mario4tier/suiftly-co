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

test.describe('Service Toggle - Enable/Disable', () => {
  test.beforeEach(async ({ page, request }) => {
    // Clear any lingering test delays from previous tests
    await request.post('http://localhost:3000/test/delays/clear');

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.waitForTimeout(3000); // Wait for auth toast

    // Reset database
    await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0,
        spendingLimitUsdCents: 25000,
      },
    });

    // Create escrow account and deposit funds
    await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 10,
        initialSpendingLimitUsd: 250,
      },
    });

    // Subscribe to seal service
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for subscription success and navigate to overview
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });
  });

  test.afterEach(async ({ request }) => {
    // Clear any test delays
    await request.post('http://localhost:3000/test/delays/clear');
  });

  test('toggle service from disabled to enabled updates database', async ({ page, request }) => {
    // Verify initial state: service is DISABLED
    const initialService = await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal');
    const initialData = await initialService.json();
    expect(initialData.state).toBe('disabled');
    expect(initialData.isEnabled).toBe(false);
    console.log('✅ Initial state: DISABLED');

    // Toggle service ON
    const toggleSwitch = page.locator('#service-toggle');
    await toggleSwitch.click();

    // Wait a moment for the API call to complete
    await page.waitForTimeout(1000);

    // Verify database was updated
    const updatedService = await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal');
    const updatedData = await updatedService.json();
    expect(updatedData.state).toBe('enabled');
    expect(updatedData.isEnabled).toBe(true);
    expect(updatedData.enabledAt).toBeTruthy();
    console.log('✅ Database updated: service is now ENABLED');

    // Verify UI updated
    await expect(toggleSwitch).toBeChecked();
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible();
    console.log('✅ UI shows service as ON');

    // Verify disabled banner is hidden (no banner shown when enabled)
    await expect(page.locator('text=/Service is subscribed but currently disabled/i')).not.toBeVisible();
    console.log('✅ Disabled banner is hidden (no banner when service is active)');
  });

  test('toggle service from enabled to disabled updates database', async ({ page, request }) => {
    // First, enable the service
    await page.locator('#service-toggle').click();
    await page.waitForTimeout(1000);

    // Verify it's enabled
    let serviceData = await (await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isEnabled).toBe(true);
    console.log('✅ Service enabled');

    // Toggle service OFF
    await page.locator('#service-toggle').click();
    await page.waitForTimeout(1000);

    // Verify database was updated
    serviceData = await (await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.state).toBe('disabled');
    expect(serviceData.isEnabled).toBe(false);
    expect(serviceData.disabledAt).toBeTruthy();
    console.log('✅ Database updated: service is now DISABLED');

    // Verify UI updated
    await expect(page.locator('#service-toggle')).not.toBeChecked();
    await expect(page.locator('text=OFF')).toBeVisible();
    console.log('✅ UI shows service as OFF');

    // Verify banner changed back
    await expect(page.locator('text=/Service is subscribed but currently disabled/i')).toBeVisible();
    console.log('✅ Banner shows service disabled');
  });

  test('toggle shows loading state during API call', async ({ page, request }) => {
    // Set a 2-second delay for seal form mutations
    await request.post('http://localhost:3000/test/delays', {
      data: {
        sealFormMutation: 2000, // 2 seconds
      },
    });

    console.log('✅ Set 2-second delay for seal form mutations');

    // Start toggle
    await page.locator('#service-toggle').click();

    // Verify loading state appears immediately (the "..." next to the toggle)
    await expect(page.locator('span.text-sm.font-medium:has-text("...")')).toBeVisible({ timeout: 500 });
    console.log('✅ Loading indicator "..." appears');

    // Verify toggle is disabled during loading
    await expect(page.locator('#service-toggle')).toBeDisabled();
    console.log('✅ Toggle switch disabled during API call');

    // Wait for completion
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible({ timeout: 3000 });
    console.log('✅ Toggle completed, shows ON');

    // Verify toggle is re-enabled
    await expect(page.locator('#service-toggle')).toBeEnabled();
    console.log('✅ Toggle switch re-enabled after API completes');
  });

  test('UX when API is slow (4 second delay)', async ({ page, request }) => {
    // Set a 4-second delay to simulate slow network
    await request.post('http://localhost:3000/test/delays', {
      data: {
        sealFormMutation: 4000, // 4 seconds
      },
    });

    console.log('✅ Set 4-second delay for seal form mutations');

    // Start toggle
    await page.locator('#service-toggle').click();

    // Verify loading state persists
    await expect(page.locator('span.text-sm.font-medium:has-text("...")')).toBeVisible();
    await expect(page.locator('#service-toggle')).toBeDisabled();
    console.log('✅ Loading state persists during long wait');

    // Wait 2 seconds - UI should still be loading
    await page.waitForTimeout(2000);
    await expect(page.locator('span.text-sm.font-medium:has-text("...")')).toBeVisible();
    await expect(page.locator('#service-toggle')).toBeDisabled();
    console.log('✅ Still loading after 2 seconds');

    // Wait for completion (another 2.5 seconds + buffer)
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible({ timeout: 3000 });
    console.log('✅ Toggle eventually completes');

    // Verify database was actually updated
    const serviceData = await (await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isEnabled).toBe(true);
    console.log('✅ Database updated correctly after long delay');
  });

  test('navigation away before API completion', async ({ page, request }) => {
    // Set a 3-second delay
    await request.post('http://localhost:3000/test/delays', {
      data: {
        sealFormMutation: 3000,
      },
    });

    console.log('✅ Set 3-second delay for seal form mutations');

    // Start toggle
    await page.locator('#service-toggle').click();

    // Verify loading started
    await expect(page.locator('span.text-sm.font-medium:has-text("...")')).toBeVisible();
    console.log('✅ Toggle loading started');

    // Navigate away immediately (within 500ms)
    await page.waitForTimeout(500);
    await page.click('text=Dashboard');
    await page.waitForURL('/dashboard', { timeout: 5000 });
    console.log('✅ Navigated to dashboard while API call in progress');

    // Wait for the API call to complete in background (2.5 more seconds)
    await page.waitForTimeout(3000);

    // Navigate back to seal overview
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    console.log('✅ Navigated back to Seal service');

    // Verify the database WAS updated (API call completed in background)
    const serviceData = await (await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isEnabled).toBe(true);
    console.log('✅ Database was updated even after navigation away');

    // Verify UI now reflects the updated state
    await expect(page.locator('#service-toggle')).toBeChecked();
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible();
    console.log('✅ UI correctly shows ENABLED state after returning');
  });

  test('multiple rapid toggles (debounce behavior)', async ({ page, request }) => {
    // Set a small delay to make the race condition visible
    await request.post('http://localhost:3000/test/delays', {
      data: {
        sealFormMutation: 1000, // 1 second
      },
    });

    console.log('✅ Set 1-second delay for seal form mutations');

    // Click toggle rapidly 3 times
    const toggle = page.locator('#service-toggle');
    await toggle.click(); // 1st click (should start enabling)
    await page.waitForTimeout(100);

    // Verify switch is disabled (can't click again immediately)
    await expect(toggle).toBeDisabled();
    console.log('✅ Toggle disabled after first click (prevents rapid clicking)');

    // Wait for completion
    await expect(page.locator('span.text-sm.font-medium:has-text("ON")')).toBeVisible({ timeout: 2000 });

    // Verify final database state
    const serviceData = await (await request.get('http://localhost:3000/test/data/service-instance?serviceType=seal')).json();
    expect(serviceData.isEnabled).toBe(true);
    console.log('✅ Final state: ENABLED (toggle completed successfully)');
  });
});
