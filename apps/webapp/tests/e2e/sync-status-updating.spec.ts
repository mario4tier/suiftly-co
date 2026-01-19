/**
 * Sync Status "Updating..." E2E Tests
 *
 * Validates:
 * 1. "Updating..." indicator appears when LM hasn't synced yet
 * 2. "Updating..." disappears once LM syncs the vault
 *
 * Uses LM test delays to simulate slow vault sync.
 *
 * IMPORTANT: This test uses the LM (Local Manager) delay endpoint
 * to slow down vault sync, NOT the API delay endpoint.
 *
 * Test setup via UI:
 * 1. Subscribe to seal service
 * 2. Enable the service
 * 3. Create a seal key
 * 4. Add a package (triggers cpEnabled=true)
 */

import { test, expect } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';
import { resetCustomer, ensureTestBalance } from '../helpers/db';

// LM and API URLs for test endpoints
const LM_URL = 'http://localhost:22610';
const API_URL = 'http://localhost:22700';

test.describe('Sync Status - Updating Indicator', () => {
  test.beforeEach(async ({ page, request }) => {
    // Step 1: Clear any lingering test delays from BOTH API and LM
    await request.post(`${API_URL}/test/delays/clear`);
    await request.post(`${LM_URL}/test/delays/clear`);

    // Step 2: Reset database (BEFORE auth to ensure clean state)
    await resetCustomer(request);

    // Step 3: Clear cookies for clean auth state (prevents test pollution)
    await page.context().clearCookies();

    // Step 4: Authenticate with mock wallet (creates customer)
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Step 5: Ensure customer has funds for subscription
    await ensureTestBalance(request, 100, { spendingLimitUsd: 250 });

    // Step 6: Subscribe to seal service via UI
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
    await page.locator('label:has-text("Agree to")').click();
    await page.getByRole('heading', { name: 'STARTER' }).click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Subscription successful/i })).toBeVisible({ timeout: 5000 });
    await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });
    await waitForToastsToDisappear(page);
    console.log('✅ Subscribed to seal service');

    // Step 7: Enable the service (toggle ON)
    const toggleSwitch = page.locator('#service-toggle');
    const toggleState = await toggleSwitch.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await toggleSwitch.click();
      await waitAfterMutation(page);
      await expect(toggleSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    }
    console.log('✅ Service enabled');

    // Step 8: Navigate to Seal Keys tab and create a seal key
    await page.goto('/services/seal/overview?tab=seal-keys');
    await page.waitForLoadState('networkidle');
    const addKeyButton = page.locator('button:has-text("Add New Seal Key")');
    await addKeyButton.click();
    await waitAfterMutation(page);
    await expect(page.locator('text=/Seal key created successfully/i')).toBeVisible({ timeout: 5000 });
    await waitForToastsToDisappear(page);
    console.log('✅ Created seal key');

    // Step 9: Add a package to the seal key (triggers cpEnabled=true)
    const addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")').first();
    await expect(addPackageButton).toBeVisible({ timeout: 5000 });
    await addPackageButton.click();
    await waitAfterMutation(page);
    await expect(page.getByRole('heading', { name: 'Add Package' })).toBeVisible({ timeout: 5000 });
    await page.locator('input#packageAddress').fill('0x' + '1'.repeat(64));
    await page.locator('input#name').fill('Test Package');
    await page.locator('button:has-text("Add Package")').last().click();
    await waitAfterMutation(page);
    await expect(page.locator('text=Package added successfully').first()).toBeVisible({ timeout: 5000 });
    await waitForToastsToDisappear(page);
    console.log('✅ Added package - cpEnabled should be true now');

    // Step 10: Navigate back to overview for testing
    await page.goto('/services/seal/overview');
    await page.waitForLoadState('networkidle');
    await waitForToastsToDisappear(page);
  });

  test.afterEach(async ({ request }) => {
    // Clear any test delays from BOTH API and LM
    await request.post(`${API_URL}/test/delays/clear`);
    await request.post(`${LM_URL}/test/delays/clear`);
  });

  test('shows "Updating..." when service is toggled and LM sync is delayed', async ({ page, request }) => {
    test.setTimeout(90000); // Extended timeout for 30s polling loop
    // Verify initial state: service is ENABLED with cpEnabled=true (from UI setup)
    const initialService = await request.get(`${API_URL}/test/data/service-instance?serviceType=seal`);
    const initialData = await initialService.json();
    expect(initialData.isUserEnabled).toBe(true);
    expect(initialData.cpEnabled).toBe(true);
    console.log(`✅ Initial state: ENABLED with cpEnabled=true, smaConfigChangeVaultSeq=${initialData.smaConfigChangeVaultSeq}`);

    // Wait for LM to sync the initial vault (from setup)
    // This ensures the baseline is synced before we set the delay
    await page.waitForTimeout(2000);

    // Set a 5-second delay in LM BEFORE applying vault changes
    // This will keep the "Updating..." status visible while LM is processing
    const delayResponse = await request.post(`${LM_URL}/test/delays`, {
      data: {
        beforeApply: 5000, // 5 seconds
      },
    });
    expect(delayResponse.ok()).toBe(true);
    console.log('✅ LM delay set to 5 seconds');

    // Toggle service OFF (this triggers a new vault since cpEnabled=true)
    const toggleSwitch = page.locator('#service-toggle');
    await toggleSwitch.click();

    // Wait for API mutation to complete (this happens fast)
    await waitAfterMutation(page);
    console.log('✅ Toggle mutation completed');

    // Now check for "Updating..." text - this should be visible because:
    // 1. The API has updated the configChangeVaultSeq
    // 2. The LM is delayed (5s) before marking the vault as applied
    // 3. The sync status should be "pending" which shows "Updating..."
    const updatingIndicator = page.locator('text=Updating...');

    // Retry logic: The "Updating..." indicator may not appear on the first reload
    // depending on how the periodic audit aligns. Retry up to 10 times.
    const maxRetries = 10;
    let updatingAppeared = false;

    for (let retry = 1; retry <= maxRetries; retry++) {
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Check if "Updating..." is visible (quick check, no long timeout)
      const isVisible = await updatingIndicator.isVisible();
      if (isVisible) {
        updatingAppeared = true;
        console.log(`✅ "Updating..." indicator is visible (retry ${retry}/${maxRetries})`);
        break;
      }

      console.log(`Retry ${retry}/${maxRetries}: "Updating..." not visible yet, waiting...`);
      await page.waitForTimeout(500); // Short wait before next retry
    }

    // Fail if "Updating..." never appeared after all retries
    expect(updatingAppeared).toBe(true);

    // Poll once per second for up to 30 seconds to detect when "Updating..." disappears
    // This gives LM time to complete the sync (5s delay + processing time)
    const maxAttempts = 30;
    let updatingDisappeared = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await page.waitForTimeout(1000); // Wait 1 second
      await page.reload();
      await page.waitForLoadState('networkidle');

      const isUpdatingVisible = await updatingIndicator.isVisible();

      // Debug: check seq numbers
      const serviceState = await request.get(`${API_URL}/test/data/service-instance?serviceType=seal`);
      const serviceData = await serviceState.json();
      const lmHealth = await request.get(`${LM_URL}/health`);
      const lmData = await lmHealth.json();
      console.log(`Attempt ${attempt}/${maxAttempts}: "Updating..." visible = ${isUpdatingVisible}, smaConfigChangeVaultSeq=${serviceData.smaConfigChangeVaultSeq}, LM applied seq=${lmData.vaults?.[0]?.applied?.seq}`);

      if (!isUpdatingVisible) {
        updatingDisappeared = true;
        console.log(`✅ "Updating..." indicator disappeared after ${attempt} seconds`);
        break;
      }
    }

    // Fail if "Updating..." never disappeared after 30 seconds
    expect(updatingDisappeared).toBe(true);
  });

  test('syncs without artificial delay (fast LM status polling)', async ({ page, request }) => {
    test.setTimeout(60000); // GM polls LM status every 5s, should complete quickly
    // This test verifies sync completes without artificial LM delay
    // GM polls LM status every 5 seconds for fast "Updating..." feedback

    // Verify initial state: service is ENABLED with cpEnabled=true (from UI setup)
    const initialService = await request.get(`${API_URL}/test/data/service-instance?serviceType=seal`);
    const initialData = await initialService.json();
    expect(initialData.isUserEnabled).toBe(true);
    expect(initialData.cpEnabled).toBe(true);
    console.log(`✅ Initial state: ENABLED with cpEnabled=true, smaConfigChangeVaultSeq=${initialData.smaConfigChangeVaultSeq}`);

    // Wait for LM to sync the initial vault (from setup)
    await page.waitForTimeout(2000);

    // NO LM delay set - sync should complete within ~10 seconds (LM applies + 5s GM poll)

    // Toggle service OFF (this triggers a new vault)
    const toggleSwitch = page.locator('#service-toggle');
    await toggleSwitch.click();

    // Wait for mutation to complete
    await waitAfterMutation(page);
    console.log('✅ Toggle mutation completed');

    // Poll for sync to complete - should complete within ~10 seconds with 5s LM polling
    const updatingIndicator = page.locator('text=Updating...');
    const maxAttempts = 30;
    let syncCompleted = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await page.waitForTimeout(1000);
      await page.reload();
      await page.waitForLoadState('networkidle');

      const isUpdatingVisible = await updatingIndicator.isVisible();

      // Only log every 10 seconds to reduce noise
      if (attempt % 10 === 0 || !isUpdatingVisible) {
        const serviceState = await request.get(`${API_URL}/test/data/service-instance?serviceType=seal`);
        const serviceData = await serviceState.json();
        const lmHealth = await request.get(`${LM_URL}/health`);
        const lmData = await lmHealth.json();
        console.log(`Attempt ${attempt}/${maxAttempts}: "Updating..." visible = ${isUpdatingVisible}, smaConfigChangeVaultSeq=${serviceData.smaConfigChangeVaultSeq}, LM applied seq=${lmData.vaults?.[0]?.applied?.seq}`);
      }

      if (!isUpdatingVisible) {
        syncCompleted = true;
        console.log(`✅ Sync completed after ${attempt} seconds (no artificial delay)`);
        break;
      }
    }

    // Verify sync completed within expected time (5s LM polling + processing)
    expect(syncCompleted).toBe(true);
  });
});
