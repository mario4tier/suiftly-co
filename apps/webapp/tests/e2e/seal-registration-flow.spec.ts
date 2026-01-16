/**
 * Seal Key Registration Flow E2E Test
 * Tests the Sui blockchain registration state machine and UI display
 */

import { test, expect, Page } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { waitForToastsToDisappear } from '../helpers/locators';
import { db } from '@suiftly/database';
import { sealKeys, sealRegistrationOps } from '@suiftly/database/schema';
import { eq, desc } from 'drizzle-orm';

// GM URL for triggering sync-all (processes seal registration ops)
const GM_URL = 'http://localhost:22600';

// Helper function to create a seal key via UI
async function createSealKeyViaUI(page: Page): Promise<void> {
  const addKeyButton = page.locator('button:has-text("Add New Seal Key")');
  await addKeyButton.click();
  await waitAfterMutation(page);
  await expect(page.locator('text=/Seal key created successfully/i')).toBeVisible({ timeout: 5000 });
}

// Helper function to get the most recent seal key for a customer
async function getLatestSealKey(customerId: number) {
  return db.query.sealKeys.findFirst({
    where: eq(sealKeys.customerId, customerId),
    orderBy: [desc(sealKeys.createdAt)],
  });
}

// Helper function to get customer ID from test API
async function getCustomerId(page: Page): Promise<number> {
  const response = await page.request.get('http://localhost:22700/test/data/customer');
  const userData = await response.json();
  return userData.customer.customerId;
}

test.describe('Seal Key Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer test data
    const resetResponse = await page.request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 100000,
        spendingLimitUsdCents: 25000,
      },
    });

    if (!resetResponse.ok()) {
      throw new Error(`Failed to reset test data: ${await resetResponse.text()}`);
    }

    // Authenticate
    await page.goto('/');
    await page.click('button:has-text("Mock Wallet")');
    await waitAfterMutation(page);
    await page.waitForURL('/dashboard', { timeout: 10000 });

    // Navigate to Seal service configuration
    await page.goto('/services/seal');
    await waitAfterMutation(page);

    // Subscribe to PRO tier (if not already subscribed)
    const subscribeButton = page.locator('button:has-text("Subscribe to Service")');
    if (await subscribeButton.isVisible()) {
      await page.locator('label:has-text("Agree to")').click();
      await waitAfterMutation(page);
      await subscribeButton.click();
      await waitAfterMutation(page);
      await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });
    }

    // Enable the service
    const serviceToggle = page.locator('button[role="switch"]');
    const toggleState = await serviceToggle.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await serviceToggle.click();
      await waitAfterMutation(page);
      await expect(serviceToggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    }

    // Navigate to Seal Keys tab
    await page.goto('/services/seal/overview?tab=seal-keys');
    await waitAfterMutation(page);
  });

  test('new seal key shows registration status badge', async ({ page }) => {
    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Should see either "On-chain Registering..." or "On-chain Registered" badge
    // (new keys start in registering state, but may complete quickly due to mock + polling)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');

    // Either badge should be visible
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Verify in database that status is valid
    const customerId = await getCustomerId(page);
    const sealKey = await getLatestSealKey(customerId);
    expect(sealKey).toBeTruthy();
    expect(['registering', 'registered']).toContain(sealKey!.registrationStatus);

    console.log(`Registration status badge displayed: ${sealKey!.registrationStatus}`);
  });

  test('registration completes successfully via mock Sui service', async ({ page }) => {
    // This test verifies the full registration flow works in development:
    // 1. Create seal key (queues registration op)
    // 2. Status transitions to 'registered' (via polling or sync-all)
    // 3. Object ID is populated

    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Should see a status badge (may already be registered due to fast polling)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Ensure registration is complete (trigger sync-all if still registering)
    const customerId = await getCustomerId(page);
    let sealKey = await getLatestSealKey(customerId);

    if (sealKey?.registrationStatus !== 'registered') {
      // Trigger GM sync-all to process the registration op
      const syncResponse = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);

      // Refetch key status
      sealKey = await getLatestSealKey(customerId);
    }

    // Should now see "On-chain Registered" badge
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // Badge should have green color styling
    await expect(registeredBadge).toHaveClass(/bg-green/);

    // Object ID should be displayed (populated by mock)
    await expect(page.locator('text=Object ID:')).toBeVisible({ timeout: 5000 });

    // Verify in database that registration completed
    expect(sealKey).toBeTruthy();
    expect(sealKey!.registrationStatus).toBe('registered');
    expect(sealKey!.objectId).toBeTruthy();
    expect(sealKey!.registrationError).toBeNull();

    console.log('Registration completed successfully via mock Sui service');
  });

  test('registration op is created when creating seal key', async ({ page }) => {
    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Get the customer ID and latest seal key
    const customerId = await getCustomerId(page);
    const sealKey = await getLatestSealKey(customerId);

    expect(sealKey).toBeTruthy();
    // Key should be either registering or already registered (if GM processed quickly)
    expect(['registering', 'registered']).toContain(sealKey!.registrationStatus);

    // Verify registration op was created
    const ops = await db.query.sealRegistrationOps.findMany({
      where: eq(sealRegistrationOps.sealKeyId, sealKey!.sealKeyId),
    });

    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0].opType).toBe('register');
    // Op should be either queued or completed (if GM processed it already)
    expect(['queued', 'completed']).toContain(ops[0].status);

    console.log('Registration op created correctly for new seal key');
  });

  test('registered key shows On-chain Registered badge with green styling', async ({ page }) => {
    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Should see a status badge (may already be registered due to fast polling)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Ensure registration is complete
    const customerId = await getCustomerId(page);
    let sealKey = await getLatestSealKey(customerId);

    if (sealKey?.registrationStatus !== 'registered') {
      // Trigger sync-all to complete registration
      const syncResponse = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);
    }

    // Should see "On-chain Registered" badge
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // Badge should have green color styling
    await expect(registeredBadge).toHaveClass(/bg-green/);

    // Should also see Object ID displayed
    await expect(page.locator('text=Object ID:')).toBeVisible();

    console.log('On-chain Registered badge displayed correctly for registered key');
  });

  test('package actions disabled/enabled matches registration state', async ({ page }) => {
    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Check current registration state
    const customerId = await getCustomerId(page);
    const sealKey = await getLatestSealKey(customerId);
    expect(sealKey).toBeTruthy();

    const addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")');
    const disableKeyButton = page.locator('button:has-text("Disable")').first();

    if (sealKey!.registrationStatus === 'registering') {
      // During registration: actions should be disabled
      const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
      await expect(registeringBadge).toBeVisible({ timeout: 5000 });
      await expect(addPackageButton).toBeDisabled();
      await expect(disableKeyButton).toBeDisabled();
      console.log('Package actions correctly disabled during registration');
    } else {
      // After registration: actions should be enabled
      const registeredBadge = page.locator('span:has-text("On-chain Registered")');
      await expect(registeredBadge).toBeVisible({ timeout: 5000 });
      await expect(addPackageButton).toBeEnabled();
      await expect(disableKeyButton).toBeEnabled();
      console.log('Package actions correctly enabled after registration');
    }
  });

  test('actions enabled after registration completes', async ({ page }) => {
    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Should see a status badge (may already be registered due to fast polling)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Ensure registration is complete
    const customerId = await getCustomerId(page);
    let sealKey = await getLatestSealKey(customerId);

    if (sealKey?.registrationStatus !== 'registered') {
      // Trigger sync-all to complete registration
      const syncResponse = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);
    }

    // Should see "On-chain Registered" badge
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // The "Add Package" button should be enabled
    const addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")');
    await expect(addPackageButton).toBeEnabled({ timeout: 5000 });

    // The "Disable" button for the seal key should also be enabled
    const disableKeyButton = page.locator('button:has-text("Disable")').first();
    await expect(disableKeyButton).toBeEnabled({ timeout: 5000 });

    console.log('Actions enabled after registration completes');
  });

  test('adding two packages auto-names them correctly (package-1, package-2)', async ({ page }) => {
    // This test verifies the package auto-naming from a user perspective:
    // 1. Create seal key and wait for registration to complete
    // 2. Add first package WITHOUT a name -> should be "package-1"
    // 3. Wait for update to complete
    // 4. Add second package WITHOUT a name -> should be "package-2"

    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Should see a status badge (may already be registered due to fast polling)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');
    const updatingBadge = page.locator('span:has-text("On-chain Updating...")');
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Ensure registration is complete
    const customerId = await getCustomerId(page);
    let sealKey = await getLatestSealKey(customerId);

    if (sealKey?.registrationStatus !== 'registered') {
      // Trigger sync-all to complete registration
      const syncResponse1 = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse1.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);

      sealKey = await getLatestSealKey(customerId);
    }

    // Should now see "On-chain Registered" badge
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // Add first package WITHOUT a name (should auto-generate "package-1")
    // Button should be enabled now that key is registered
    let addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")').first();
    await expect(addPackageButton).toBeEnabled({ timeout: 5000 });
    await addPackageButton.click();
    await waitAfterMutation(page);

    // Wait for modal and fill in ONLY the address (no name - test auto-naming)
    await expect(page.getByRole('heading', { name: 'Add Package' })).toBeVisible({ timeout: 5000 });
    await page.locator('input#packageAddress').fill('0x' + '1'.repeat(64));
    // Note: NOT filling in the name field to test auto-generation
    await page.locator('button:has-text("Add Package")').last().click();
    await waitAfterMutation(page);

    // Wait for success toast
    await expect(page.locator('text=Package added successfully')).toBeVisible({ timeout: 5000 });
    await waitForToastsToDisappear(page);

    // Verify first package was auto-named "package-1"
    await expect(page.locator('text=package-1')).toBeVisible({ timeout: 5000 });

    // Wait for update to complete before adding second package
    await expect(updatingBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    if (await updatingBadge.isVisible()) {
      // Trigger sync-all to process the update op
      const syncResponse2 = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse2.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);
    }

    // Wait for key to be back to registered state
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // Re-locate button after potential reload
    addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")').first();
    await expect(addPackageButton).toBeEnabled({ timeout: 5000 });

    // Add second package WITHOUT a name (should auto-generate "package-2")
    await addPackageButton.click();
    await waitAfterMutation(page);

    await expect(page.getByRole('heading', { name: 'Add Package' })).toBeVisible({ timeout: 5000 });
    await page.locator('input#packageAddress').fill('0x' + '2'.repeat(64));
    // Note: NOT filling in the name field to test auto-generation
    await page.locator('button:has-text("Add Package")').last().click();
    await waitAfterMutation(page);

    await expect(page.locator('text=Package added successfully')).toBeVisible({ timeout: 5000 });
    await waitForToastsToDisappear(page);

    // Verify second package was auto-named "package-2"
    await expect(page.locator('text=package-2')).toBeVisible({ timeout: 5000 });

    // Both packages should be visible
    await expect(page.locator('text=package-1')).toBeVisible();
    await expect(page.locator('text=package-2')).toBeVisible();

    console.log('Auto-naming works correctly: package-1 and package-2 created');
  });

  test('updating state transitions back to registered after sync', async ({ page }) => {
    // This test verifies the full package update flow:
    // 1. Create seal key and ensure registration is complete
    // 2. Add a package (puts key in "updating" state)
    // 3. Trigger sync-all to process the update
    // 4. Verify state transitions back to "On-chain Registered"

    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Should see a status badge (may already be registered due to fast polling)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Ensure registration is complete
    const customerId = await getCustomerId(page);
    let sealKey = await getLatestSealKey(customerId);

    if (sealKey?.registrationStatus !== 'registered') {
      // Trigger sync-all to complete registration
      const syncResponse1 = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse1.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);

      sealKey = await getLatestSealKey(customerId);
    }

    // Should now see "On-chain Registered" badge
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // Add a package
    const addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")').first();
    await addPackageButton.click();
    await waitAfterMutation(page);

    // Wait for modal and fill in the form
    await expect(page.getByRole('heading', { name: 'Add Package' })).toBeVisible({ timeout: 5000 });
    await page.locator('input#packageAddress').fill('0x' + '2'.repeat(64));
    await page.locator('input#name').fill('Update Test Package');
    await page.locator('button:has-text("Add Package")').last().click();
    await waitAfterMutation(page);

    // Wait for success toast
    await expect(page.locator('text=Package added successfully')).toBeVisible({ timeout: 5000 });
    await waitForToastsToDisappear(page);

    // Should see a status badge (may already be back to registered due to fast polling)
    const updatingBadge = page.locator('span:has-text("On-chain Updating...")');
    await expect(updatingBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // If still in updating state, trigger sync-all to process the update op
    if (await updatingBadge.isVisible()) {
      const syncResponse2 = await page.request.post(`${GM_URL}/api/queue/sync-all?source=test`);
      expect(syncResponse2.ok()).toBe(true);

      // Reload to get fresh data
      await page.reload();
      await waitAfterMutation(page);
    }

    // Should transition back to "On-chain Registered" badge
    await expect(registeredBadge).toBeVisible({ timeout: 10000 });

    // Verify in database that key is registered again
    sealKey = await getLatestSealKey(customerId);

    expect(sealKey).toBeTruthy();
    expect(sealKey!.registrationStatus).toBe('registered');

    console.log('Updating state successfully transitions back to registered');
  });

  test('error state shows popover with details', async ({ page }) => {
    // Create a seal key via UI
    await createSealKeyViaUI(page);
    await waitForToastsToDisappear(page);

    // Wait for any status badge to appear (confirming key is visible on page)
    const registeringBadge = page.locator('span:has-text("On-chain Registering...")');
    const registeredBadge = page.locator('span:has-text("On-chain Registered")');
    await expect(registeringBadge.or(registeredBadge)).toBeVisible({ timeout: 5000 });

    // Get the customer ID and latest seal key
    const customerId = await getCustomerId(page);
    const sealKey = await getLatestSealKey(customerId);

    // Simulate a registration error (force back to registering state with error)
    await db.update(sealKeys)
      .set({
        registrationStatus: 'registering',
        registrationError: 'Insufficient gas funds',
        registrationAttempts: 2,
        nextRetryAt: new Date(Date.now() + 30000), // 30 seconds from now
        // Clear objectId to indicate not yet registered
        objectId: null,
      })
      .where(eq(sealKeys.sealKeyId, sealKey!.sealKeyId));

    // Reload page to fetch updated data
    await page.reload();
    await waitAfterMutation(page);

    // Should see "On-chain Registering..." badge with error indicator (AlertCircle icon)
    await expect(registeringBadge).toBeVisible({ timeout: 5000 });

    // Click on the badge to open the popover
    await registeringBadge.click();

    // Should see the error popover with details
    await expect(page.locator('text=Registration Error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Insufficient gas funds')).toBeVisible();
    await expect(page.locator('text=/Attempt 2/i')).toBeVisible();

    console.log('Error state popover displays correctly');
  });

  test.afterEach(async ({ page }) => {
    // Cleanup: Delete test seal keys and registration ops
    const customerId = await getCustomerId(page);

    // Delete registration ops first (foreign key constraint)
    const keys = await db.query.sealKeys.findMany({
      where: eq(sealKeys.customerId, customerId),
    });

    for (const key of keys) {
      await db.delete(sealRegistrationOps).where(eq(sealRegistrationOps.sealKeyId, key.sealKeyId));
    }

    // Delete seal keys
    await db.delete(sealKeys).where(eq(sealKeys.customerId, customerId));
  });
});
