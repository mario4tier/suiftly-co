/**
 * Service State Transitions E2E Test
 * Tests the service state machine: NotProvisioned → Disabled → Enabled
 * Note: Provisioning state is reserved for future use - services go directly to disabled state
 * See docs/UI_DESIGN.md for complete state machine documentation
 */

import { test, expect } from '@playwright/test';

test.describe('Service State Transitions', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer test data (delete all services, reset balance)
    await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // Will be set via deposit
        spendingLimitUsdCents: 25000, // $250
      },
    });

    // Create escrow account and deposit funds
    const depositResponse = await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 1000, // $1000
        initialSpendingLimitUsd: 250, // $250
      },
    });
    const depositData = await depositResponse.json();
    if (!depositData.success) {
      throw new Error('Failed to create escrow account');
    }

    // Authenticate with mock wallet
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');

    // Wait for redirect to /dashboard after auth
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to seal service page
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    // Clear test delays after each test
    await page.request.post('http://localhost:3000/test/delays/clear');
  });

  test('State 1: Service starts in NotProvisioned state', async ({ page }) => {
    // Should show onboarding form (State 1 UI)
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).toBeVisible();

    // Should see tier selection cards (use heading to avoid strict mode violations)
    await expect(page.locator('h4:has-text("STARTER")')).toBeVisible();
    await expect(page.locator('h4:has-text("PRO")')).toBeVisible();
    await expect(page.locator('h4:has-text("ENTERPRISE")')).toBeVisible();

    // Should see Subscribe button (disabled until terms accepted)
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeVisible();
    await expect(subscribeButton).toBeDisabled();

    // Should NOT see service toggle (only in State 3+)
    await expect(page.locator('role=switch[name=/enable|disable/i]')).not.toBeVisible();

    // Should NOT see tabs (Overview/X-API-Key/Seal Keys/More Settings - only in State 3+)
    await expect(page.locator('role=tab[name="Overview"]')).not.toBeVisible();
    await expect(page.locator('role=tab[name="X-API-Key"]')).not.toBeVisible();
    await expect(page.locator('role=tab[name="Seal Keys"]')).not.toBeVisible();
    await expect(page.locator('role=tab[name="More Settings"]')).not.toBeVisible();

    console.log('✅ State 1 (NotProvisioned): Onboarding form displayed correctly');
  });

  test('State 1 → 3: Clicking Subscribe transitions directly to Disabled state', async ({ page }) => {
    // Accept terms to enable subscribe button
    await page.locator('label:has-text("Agree to")').click();

    // Subscribe button should now be enabled
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeEnabled();

    // Click subscribe button
    await subscribeButton.click();

    // Wait for success toast (subscription completes immediately - no provisioning state)
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should transition directly to State 3 (Disabled) - service management UI
    // Onboarding form should disappear
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    // Should see service state banner (disabled state)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    console.log('✅ State 1 → 3 transition: Service created in Disabled state (no provisioning state)');
  });

  test('State 3: After subscription, service is in Disabled state', async ({ page }) => {
    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for success toast
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Service should now be in State 3 (Disabled)
    // Note: There is no State 2 (Provisioning) - services go directly from not_provisioned → disabled

    // Expected State 3 UI indicators:
    // - Banner: "Service is currently OFF. Switch to ON to start serving traffic."
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    // - Onboarding form should be gone
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    // TODO: Once service management UI is implemented, verify:
    // - Toggle switch visible: [OFF] ⟳ ON
    // - Tabs visible: Overview / X-API-Key / Seal Keys / More Settings
    // - Overview tab is editable

    console.log('✅ State 3 (Disabled): Service created in disabled state after subscription');
  });

  test('State 3: Service management UI elements', async ({ page }) => {
    // Subscribe to create service in disabled state
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Verify State 3 UI elements:
    // 1. Banner shows service is disabled
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible();

    // 2. Onboarding form is hidden
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    // TODO: Once service management UI is fully implemented, verify:
    // - Tab-based layout (Overview / X-API-Key / Seal Keys / More Settings tabs)
    // - Toggle switch visible: [OFF] ⟳ ON
    // - Overview is editable (tier, charges, etc.)
    // - More Settings tab is editable (burst, allowlist, etc.)
    // - X-API-Key tab shows API keys (can create/revoke)
    // - Seal Keys tab shows Seal keys (can create/revoke)

    console.log('✅ State 3 (Disabled): Basic UI elements verified');
  });

  test('Database: Service state is persisted correctly', async ({ page }) => {
    // This test verifies that the service state is correctly stored in the database

    // TODO: Implement test that:
    // 1. Initially no service exists (state: not_provisioned conceptually)
    // 2. Subscribe to service (State 1 → 3)
    // 3. Query database directly to verify state = 'disabled'
    // 4. Verify subscriptionChargePending = false (charge succeeded)

    // Note: There is no 'provisioning' state in the implementation
    // Services go directly from not existing → disabled state

    // This requires:
    // - Database query helper in test utils
    // - Backend API endpoint to check service state (or direct DB access)

    console.log('⚠️  Database persistence test: To be implemented');
    console.log('   Expected: No service exists initially');
    console.log('   Expected: service_instances.state = "disabled" after subscribe');
    console.log('   Expected: subscriptionChargePending = false after payment succeeds');
  });
});

test.describe('Service State - Edge Cases', () => {
  test.beforeEach(async ({ page, request }) => {
    // Reset customer test data (delete all services, reset balance, clear escrow)
    await request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 0, // Will be set via deposit
        spendingLimitUsdCents: 25000, // $250
        clearEscrowAccount: true, // Ensure fresh start
      },
    });

    // Create escrow account and deposit funds
    const depositResponse = await request.post('http://localhost:3000/test/wallet/deposit', {
      data: {
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        amountUsd: 1000, // $1000
        initialSpendingLimitUsd: 250, // $250
      },
    });
    const depositData = await depositResponse.json();
    if (!depositData.success) {
      throw new Error('Failed to create escrow account');
    }

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test('Cannot modify tier after subscription', async ({ page }) => {
    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for success
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Service should now be in disabled state
    // Onboarding form should be hidden
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    // Tier cards should not be visible (service management UI shown instead)
    await expect(page.locator('h4:has-text("STARTER")')).not.toBeVisible();

    // TODO: Verify service management UI allows tier changes through plan upgrade/downgrade feature
    console.log('✅ After subscription: Onboarding form hidden, service management UI shown');
  });

  test('Page refresh after subscription maintains service state', async ({ page }) => {
    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for success
    await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });

    // Should be in disabled state (service management UI shown)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible();

    // Refresh page
    await page.reload();

    // Should still be in disabled state (not back to onboarding)
    await expect(page.locator('text=/Service is currently OFF/i')).toBeVisible({ timeout: 5000 });

    // Onboarding form should not reappear
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).not.toBeVisible();

    console.log('✅ Service state (disabled) persists across page refresh');
  });
});
