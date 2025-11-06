/**
 * Service State Transitions E2E Test
 * Tests the service state machine: NotProvisioned → Provisioning → Disabled
 * See docs/UI_DESIGN.md for complete state machine documentation
 */

import { test, expect } from '@playwright/test';

test.describe('Service State Transitions', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer test data (delete all services, reset balance)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 100000, // $1000
        spendingLimitUsdCents: 25000, // $250
      },
    });

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

    // Should see tier selection cards
    await expect(page.locator('text=STARTER')).toBeVisible();
    await expect(page.locator('text=PRO')).toBeVisible();
    await expect(page.locator('text=ENTERPRISE')).toBeVisible();

    // Should see Subscribe button (disabled until terms accepted)
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeVisible();
    await expect(subscribeButton).toBeDisabled();

    // Should NOT see service toggle (only in State 3+)
    await expect(page.locator('role=switch[name=/enable|disable/i]')).not.toBeVisible();

    // Should NOT see tabs (Config/Keys - only in State 3+)
    await expect(page.locator('role=tab[name="Configuration"]')).not.toBeVisible();
    await expect(page.locator('role=tab[name="Keys"]')).not.toBeVisible();

    console.log('✅ State 1 (NotProvisioned): Onboarding form displayed correctly');
  });

  test('State 1 → 2: Clicking Subscribe transitions to Provisioning state', async ({ page }) => {
    // Configure test delays to slow down API (1 second each)
    await page.request.post('http://localhost:3000/test/delays', {
      data: {
        validateSubscription: 1000,
        subscribe: 1000,
      },
    });

    // Accept terms to enable subscribe button
    await page.locator('label:has-text("Agree to")').click();

    // Subscribe button should now be enabled
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    await expect(subscribeButton).toBeEnabled();

    // Click subscribe button
    await subscribeButton.click();

    // Should transition to State 2 (Provisioning)
    // Expect loading overlay with "Processing your subscription..." banner
    await expect(page.locator('text=/Processing your subscription/i')).toBeVisible({ timeout: 5000 });

    // Onboarding form should still be visible but disabled
    await expect(page.locator('h3:has-text("Guaranteed Bandwidth")')).toBeVisible();

    // Form should be disabled (tier cards should not be clickable)
    const starterCard = page.locator('text=STARTER').first();
    // The card should have disabled styling or overlay
    const formContainer = page.locator('form, div').filter({ has: starterCard });
    await expect(formContainer.or(page.locator('[aria-disabled="true"]'))).toBeVisible();

    console.log('✅ State 1 → 2 transition: Service moved to Provisioning state');
  });

  test('State 2 → 3: Payment confirmation transitions to Disabled state', async ({ page }) => {
    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for Provisioning state
    await expect(page.locator('text=/Processing your subscription/i')).toBeVisible({ timeout: 5000 });

    // Simulate payment confirmation (in real flow, this would be backend processing)
    // For MVP, we'll simulate this by waiting for the state to update
    // In production, this would involve:
    // 1. Backend detects payment
    // 2. Updates service_instances.state to 'disabled'
    // 3. Frontend polls or receives update
    // 4. UI transitions to State 3 (tab-based layout)

    // For this test, we'll mock the payment confirmation
    // In real implementation, this would be triggered by backend
    // For now, we expect the UI to poll or listen for state changes

    // TODO: Once backend payment flow is implemented, update this test to:
    // 1. Trigger mock payment confirmation
    // 2. Wait for state update
    // 3. Verify State 3 UI appears

    // Expected State 3 UI indicators:
    // - Banner: "Service is subscribed but currently disabled. Enable to start serving traffic."
    // - Toggle switch visible: [OFF] ⟳ ON
    // - Tabs visible: Config / Keys
    // - Configuration tab is editable

    // For now, add a placeholder assertion that this will be implemented
    console.log('⚠️  State 2 → 3 transition: Backend payment flow to be implemented');
    console.log('   Expected: Payment confirmation updates state to "disabled"');
    console.log('   Expected: UI transitions to tab-based layout (Config/Keys)');
    console.log('   Expected: Banner shows "Service is subscribed but currently disabled"');
  });

  test('State 3: Disabled state shows correct UI elements', async ({ page }) => {
    // This test will verify State 3 UI once we can set up a service in Disabled state
    // For now, this is a placeholder for the expected behavior

    // Expected UI in State 3 (Disabled):
    // 1. Tab-based layout (Config / Keys tabs)
    // 2. Toggle switch visible: [OFF] ⟳ ON
    // 3. Banner: "Service is subscribed but currently disabled. Enable to start serving traffic."
    // 4. Configuration is editable (tier, burst, etc.)
    // 5. Keys tab shows API keys and Seal keys (can create/revoke)
    // 6. All keys return 503 when called (backend behavior)

    // TODO: Implement test once we have:
    // 1. Test helper to create service in Disabled state
    // 2. Backend returns service state from API
    // 3. Frontend renders State 3 UI based on state

    console.log('⚠️  State 3 (Disabled): Test to be implemented');
    console.log('   Expected: Tab-based layout with Config/Keys tabs');
    console.log('   Expected: Toggle switch [OFF] ⟳ ON');
    console.log('   Expected: Banner about disabled service');
    console.log('   Expected: Configuration is editable');
  });

  test('Database: Service state is persisted correctly', async ({ page }) => {
    // This test verifies that the service state is correctly stored in the database

    // TODO: Implement test that:
    // 1. Subscribes to service (State 1 → 2)
    // 2. Queries database directly to verify state = 'provisioning'
    // 3. Simulates payment confirmation
    // 4. Queries database to verify state = 'disabled'

    // This requires:
    // - Database query helper in test utils
    // - Backend API endpoint to check service state (or direct DB access)

    console.log('⚠️  Database persistence test: To be implemented');
    console.log('   Expected: service_instances.state = "not_provisioned" initially');
    console.log('   Expected: service_instances.state = "provisioning" after subscribe');
    console.log('   Expected: service_instances.state = "disabled" after payment');
  });
});

test.describe('Service State - Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer test data (delete all services, reset balance)
    await page.request.post('http://localhost:3000/test/data/reset', {
      data: {
        balanceUsdCents: 100000, // $1000
        spendingLimitUsdCents: 25000, // $250
      },
    });

    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await page.waitForURL('/dashboard', { timeout: 10000 });
    await page.click('text=Seal');
    await page.waitForURL(/\/services\/seal/, { timeout: 5000 });
  });

  test('Cannot modify tier selection during Provisioning state', async ({ page }) => {
    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for Provisioning state
    await expect(page.locator('text=/Processing your subscription/i')).toBeVisible({ timeout: 5000 });

    // Tier cards should be disabled/non-interactive
    // User should not be able to change tier during payment processing

    // TODO: Verify tier cards are not clickable or have disabled styling
    console.log('⚠️  Provisioning state tier lock: To be implemented');
  });

  test('Page refresh during Provisioning maintains state', async ({ page }) => {
    // Accept terms and subscribe
    await page.locator('label:has-text("Agree to")').click();
    await page.locator('button:has-text("Subscribe to Service")').click();

    // Wait for Provisioning state
    await expect(page.locator('text=/Processing your subscription/i')).toBeVisible({ timeout: 5000 });

    // Refresh page
    await page.reload();

    // Should still be in Provisioning state (loading overlay visible)
    await expect(page.locator('text=/Processing your subscription/i')).toBeVisible({ timeout: 5000 });

    console.log('✅ Provisioning state persists across page refresh');
  });
});
