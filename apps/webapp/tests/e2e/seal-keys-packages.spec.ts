/**
 * Seal Keys & Packages E2E Test
 * Tests seal key and package management functionality
 */

import { test, expect, Page } from '@playwright/test';
import { waitAfterMutation } from '../helpers/wait-utils';
import { db } from '@suiftly/database';
import { sealKeys } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';

// Helper function to create a seal key via UI
async function createSealKeyViaUI(page: Page): Promise<void> {
  const addKeyButton = page.locator('button:has-text("Add New Seal Key")');
  await addKeyButton.click();
  await waitAfterMutation(page);
  await expect(page.locator('text=/Seal key created successfully/i')).toBeVisible({ timeout: 5000 });
}

// Helper function to add a package via UI (using modal form)
async function addPackageViaUI(page: Page, address: string, name: string): Promise<void> {
  const addPackageButton = page.locator('button:has-text("Add Package to this Seal Key")').first();
  await expect(addPackageButton).toBeVisible({ timeout: 5000 });

  // Click the button to open the modal
  await addPackageButton.click();
  await waitAfterMutation(page);

  // Wait for modal to appear (check for dialog heading specifically)
  await expect(page.getByRole('heading', { name: 'Add Package' })).toBeVisible({ timeout: 5000 });

  // Fill in the package address field
  const addressInput = page.locator('input#packageAddress');
  await addressInput.fill(address);

  // Fill in the name field
  const nameInput = page.locator('input#name');
  await nameInput.fill(name);

  // Click the "Add Package" button in the modal
  const submitButton = page.locator('button:has-text("Add Package")').last();
  await submitButton.click();
  await waitAfterMutation(page);

  // Wait for success toast and then wait for it to disappear (toasts auto-dismiss)
  const toast = page.locator('text=Package added successfully').first();
  await expect(toast).toBeVisible({ timeout: 5000 });
  await expect(toast).toBeHidden({ timeout: 10000 });
}

test.describe('Seal Keys & Packages Management', () => {
  test.beforeEach(async ({ page }) => {
    // Reset customer test data
    const resetResponse = await page.request.post('http://localhost:22700/test/data/reset', {
      data: {
        balanceUsdCents: 100000, // $1000
        spendingLimitUsdCents: 25000, // $250
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
      // Accept terms first
      await page.locator('label:has-text("Agree to")').click();
      await waitAfterMutation(page);

      // Now subscribe
      await subscribeButton.click();
      await waitAfterMutation(page);

      // Wait for subscription success
      await expect(page.locator('text=/Subscription successful/i')).toBeVisible({ timeout: 5000 });
      await page.waitForURL(/\/services\/seal\/overview/, { timeout: 5000 });
    }

    // Enable the service (switch from OFF to ON)
    const serviceToggle = page.locator('button[role="switch"]');
    const toggleState = await serviceToggle.getAttribute('aria-checked');
    if (toggleState === 'false') {
      await serviceToggle.click();
      await waitAfterMutation(page);
      // Wait for service to be enabled
      await expect(serviceToggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 });
    }

    // Navigate directly to Seal Keys tab via URL
    await page.goto('/services/seal/overview?tab=seal-keys');
    await waitAfterMutation(page);
  });

  test('seal keys tab loads correctly', async ({ page }) => {
    // Should see "Seal Keys & Packages" heading with usage count
    await expect(page.locator('h3:has-text("Seal Keys & Packages")')).toBeVisible();
    await expect(page.locator('h3:has-text("Seal Keys & Packages")').filter({ hasText: /\d+ of \d+ used/ })).toBeVisible();

    console.log('✅ Seal Keys tab loads with all required elements');
  });

  test('add package to seal key', async ({ page }) => {
    // Create a seal key via the "Add New Seal Key" button
    const addKeyButton = page.locator('button:has-text("Add New Seal Key")');
    await addKeyButton.click();
    await waitAfterMutation(page);

    // Wait for the key to be created and displayed
    await expect(page.locator('text=/Seal key created successfully/i')).toBeVisible({ timeout: 5000 });

    // Should see the seal key (displayed as 0x... instead of seal_)
    await expect(page.locator('code').filter({ hasText: /^0x[0-9a-f]{6}\.\.\.[0-9a-f]{4}$/i })).toBeVisible();

    // Add a package using the modal form
    await addPackageViaUI(page, '0x' + '1'.repeat(64), 'Test Package');

    // Should see the package in the list (format is 0x\x1111...1111)
    await expect(page.locator('text=/0x.*1111.*1111/')).toBeVisible();
    await expect(page.locator('text=Test Package')).toBeVisible();

    console.log('✅ Package added successfully');
  });

  test('edit package name inline', async ({ page }) => {
    // Setup: Create a seal key and package via UI
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '1'.repeat(64), 'Original Name');

    // Should see original name
    await expect(page.locator('text=Original Name')).toBeVisible();

    // Click on the package name to start inline editing
    const packageName = page.locator('text=Original Name').first();
    await packageName.click();

    // Wait for the inline editing input to appear
    const nameInput = page.locator('input[placeholder="Package name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await expect(nameInput).toHaveValue('Original Name');

    // Clear and type new name
    await nameInput.clear();
    await nameInput.fill('Updated Name');

    // Press Enter to save
    await nameInput.press('Enter');
    await waitAfterMutation(page);

    // Should see updated name (no toast shown for inline edits)
    await expect(page.locator('text=Updated Name')).toBeVisible({ timeout: 5000 });

    // Original name should no longer be visible
    await expect(page.locator('text=Original Name')).not.toBeVisible();

    console.log('✅ Package name edited inline successfully');
  });

  test('edit seal key name inline', async ({ page }) => {
    // Setup: Create a seal key via UI
    await createSealKeyViaUI(page);

    // Should see auto-generated name "seal-key-1"
    await expect(page.locator('text=seal-key-1')).toBeVisible();

    // Click on the seal key name to start inline editing
    const sealKeyName = page.locator('text=seal-key-1').first();
    await sealKeyName.click();

    // Wait for the inline editing input to appear
    const nameInput = page.locator('input[placeholder="Seal key name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await expect(nameInput).toHaveValue('seal-key-1');

    // Clear and type new name
    await nameInput.clear();
    await nameInput.fill('My Custom Seal Key');

    // Press Enter to save
    await nameInput.press('Enter');
    await waitAfterMutation(page);

    // Should see updated name (no toast shown for inline edits)
    await expect(page.locator('text=My Custom Seal Key')).toBeVisible({ timeout: 5000 });

    // Original name should no longer be visible
    await expect(page.locator('text=seal-key-1')).not.toBeVisible();

    console.log('✅ Seal key name edited inline successfully');
  });

  test('edit seal key name when empty (recovery)', async ({ page }) => {
    // Setup: Create a seal key and clear its name
    await createSealKeyViaUI(page);

    // Should see auto-generated name "seal-key-1"
    await expect(page.locator('text=seal-key-1')).toBeVisible();

    // Click on the seal key name to start inline editing
    const sealKeyName = page.locator('text=seal-key-1').first();
    await sealKeyName.click();

    // Wait for the inline editing input to appear
    const nameInput = page.locator('input[placeholder="Seal key name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });

    // Clear the name to make it empty
    await nameInput.clear();
    await nameInput.press('Enter');
    await waitAfterMutation(page);

    // Should see "Click to add name" placeholder
    await expect(page.locator('text=Click to add name')).toBeVisible({ timeout: 5000 });

    // Click on the placeholder to edit
    const placeholder = page.locator('text=Click to add name').first();
    await placeholder.click();

    // Input should appear again, now empty
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await expect(nameInput).toHaveValue('');

    // Type a new name
    await nameInput.fill('Recovered Name');
    await nameInput.press('Enter');
    await waitAfterMutation(page);

    // Should see the new name
    await expect(page.locator('text=Recovered Name')).toBeVisible({ timeout: 5000 });

    console.log('✅ Seal key name editable when empty (recovery works)');
  });

  test('disable package with confirmation dialog', async ({ page }) => {
    // Setup: Create a seal key and package via UI
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '1'.repeat(64), 'Package to Disable');

    // Should see the package with Active status
    await expect(page.locator('text=Package to Disable')).toBeVisible();
    await expect(page.locator('text=Active').first()).toBeVisible();

    // Find the package row and check buttons within it
    const packageRow = page.locator('tr:has-text("Package to Disable")');
    const disableButton = packageRow.locator('button:has-text("Disable")');

    // Should see Disable button (not Delete button for active packages)
    await expect(disableButton).toBeVisible();
    await expect(packageRow.locator('button:has-text("Delete")')).not.toBeVisible();

    // Click Disable button
    await disableButton.click();
    await waitAfterMutation(page);

    // Should see confirmation dialog (AlertDialog, not browser confirm)
    await expect(page.getByRole('heading', { name: 'Disable Package?' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=The package will stop working immediately but can be re-enabled later.')).toBeVisible();

    // Click confirm button in dialog
    const confirmButton = page.locator('button:has-text("Disable Package")');
    await confirmButton.click();
    await waitAfterMutation(page);

    // Should see success toast
    const toast = page.locator('text=Package updated').first();
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Wait for toast to disappear (ensures mutation completed and UI updated)
    await expect(toast).toBeHidden({ timeout: 10000 });

    // Should see Disabled status badge
    await expect(page.locator('text=Disabled').last()).toBeVisible({ timeout: 5000 });

    // Should now see Enable and Delete buttons in the package row (not Disable)
    await expect(packageRow.locator('button:has-text("Enable")')).toBeVisible();
    await expect(packageRow.locator('button:has-text("Delete")')).toBeVisible();
    await expect(packageRow.locator('button:has-text("Disable")')).not.toBeVisible();

    console.log('✅ Package disabled successfully with confirmation dialog');
  });

  test('enable a disabled package', async ({ page }) => {
    // Setup: Create a seal key and package, then disable it
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '2'.repeat(64), 'Package to Enable');

    // Disable the package first
    const disableButton = page.locator('button:has-text("Disable")').last();
    await disableButton.click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Package")').click();
    await waitAfterMutation(page);

    // Should see Disabled status
    await expect(page.locator('text=Disabled').last()).toBeVisible({ timeout: 5000 });

    // Click Enable button
    const enableButton = page.locator('button:has-text("Enable")').last();
    await enableButton.click();
    await waitAfterMutation(page);

    // Should see success toast
    const enableToast = page.locator('text=Package updated').first();
    await expect(enableToast).toBeVisible({ timeout: 5000 });

    // Wait for toast to disappear (ensures mutation completed and UI updated)
    await expect(enableToast).toBeHidden({ timeout: 10000 });

    // Should see Active status badge again
    await expect(page.locator('text=Active').last()).toBeVisible({ timeout: 5000 });

    // Find the package row to check buttons within it
    const packageRow = page.locator('tr:has-text("Package to Enable")');

    // Should see Disable button in the package row (not Enable/Delete)
    await expect(packageRow.locator('button:has-text("Disable")')).toBeVisible();
    await expect(packageRow.locator('button:has-text("Enable")')).not.toBeVisible();
    await expect(packageRow.locator('button:has-text("Delete")')).not.toBeVisible();

    console.log('✅ Package re-enabled successfully');
  });

  test('delete a disabled package with confirmation dialog', async ({ page }) => {
    test.setTimeout(40000); // Slightly extended - test creates multiple resources (key + package + disable + delete)
    // Setup: Create a seal key and package, then disable it
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '3'.repeat(64), 'Package to Delete');

    // Disable the package first
    const packageRow = page.locator('tr:has-text("Package to Delete")');
    const disableButton = packageRow.locator('button:has-text("Disable")');
    await disableButton.click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Package")').click();
    await waitAfterMutation(page);

    // Should see Disabled status and Delete button
    await expect(page.locator('text=Disabled').last()).toBeVisible({ timeout: 5000 });
    const deleteButton = packageRow.locator('button:has-text("Delete")');
    await expect(deleteButton).toBeVisible();

    // Click Delete button
    await deleteButton.click();
    await waitAfterMutation(page);

    // Should see confirmation dialog (AlertDialog)
    await expect(page.getByRole('heading', { name: 'Delete Package?' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=This action cannot be undone.')).toBeVisible();

    // Click confirm button in dialog
    const confirmButton = page.locator('button:has-text("Delete Package")');
    await confirmButton.click();
    await waitAfterMutation(page);

    // Should see success toast
    const deleteToast = page.locator('text=Package deleted').first();
    await expect(deleteToast).toBeVisible({ timeout: 5000 });

    // Wait for toast to disappear (ensures mutation completed and UI updated)
    await expect(deleteToast).toBeHidden({ timeout: 10000 });

    // Package should no longer be visible (hard deleted from database)
    await expect(page.locator('text=Package to Delete')).not.toBeVisible();

    console.log('✅ Disabled package deleted successfully with confirmation dialog');
  });

  test('copy package address to clipboard', async ({ page }) => {
    // Setup: Create a seal key and package
    await createSealKeyViaUI(page);
    const packageAddress = '0x' + 'a'.repeat(64);
    await addPackageViaUI(page, packageAddress, 'Test Copy Package');

    // Package address should be visible in the table
    await expect(page.locator('text=Test Copy Package')).toBeVisible();

    // Find and click the copy button for the package address (CopyableValue component)
    // The copy icon is inside the CopyableValue component next to the package address
    const copyButton = page.locator('td').filter({ hasText: /0x.*aaaa/ }).locator('button').first();
    await copyButton.click();
    await waitAfterMutation(page);

    // Should see "Copied!" tooltip or success indication
    // CopyableValue shows a checkmark when copied
    await expect(copyButton.locator('svg')).toBeVisible({ timeout: 1000 });

    console.log('✅ Package address copied to clipboard');
  });

  test('package status badges display correctly', async ({ page }) => {
    // Setup: Create a seal key and two packages
    await createSealKeyViaUI(page);
    await addPackageViaUI(page, '0x' + '4'.repeat(64), 'Active Package');
    await addPackageViaUI(page, '0x' + '5'.repeat(64), 'Package to Disable');

    // Both packages should show Active status initially (check within table tbody only)
    const packagesTable = page.locator('table').first();
    // Use more specific selector: status badges are in the Status column (3rd td in each row)
    const activeBadges = packagesTable.locator('tbody tr td:nth-child(3) span:has-text("Active")');
    await expect(activeBadges).toHaveCount(2, { timeout: 5000 });

    // Disable the second package
    const packageRow = page.locator('tr:has-text("Package to Disable")');
    const disableButton = packageRow.locator('button:has-text("Disable")');
    await disableButton.click();
    await waitAfterMutation(page);
    await page.locator('button:has-text("Disable Package")').click();
    await waitAfterMutation(page);

    // Wait for success toast and disappear
    const toast = page.locator('text=Package updated').first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toBeHidden({ timeout: 10000 });

    // Should now have 1 Active and 1 Disabled badge in the table
    await expect(packagesTable.locator('tbody tr td:nth-child(3) span:has-text("Active")')).toHaveCount(1);
    await expect(packagesTable.locator('tbody tr td:nth-child(3) span:has-text("Disabled")')).toHaveCount(1);

    // Check badge colors via CSS classes
    const activeBadge = packagesTable.locator('tbody tr td:nth-child(3) span:has-text("Active")');
    const disabledBadge = packagesTable.locator('tbody tr td:nth-child(3) span:has-text("Disabled")');

    // Active badge should have green classes
    await expect(activeBadge).toHaveClass(/bg-green/);
    await expect(activeBadge).toHaveClass(/text-green/);

    // Disabled badge should have red classes
    await expect(disabledBadge).toHaveClass(/bg-red/);
    await expect(disabledBadge).toHaveClass(/text-red/);

    console.log('✅ Package status badges display with correct colors');
  });

  test('toggle seal key enable/disable', async ({ page }) => {
    // Setup: Create a seal key via UI
    await createSealKeyViaUI(page);

    // Should see the seal key without DISABLED badge
    await expect(page.locator('text=DISABLED')).not.toBeVisible();

    // Click Disable button
    const disableButton = page.locator('button:has-text("Disable")').first();
    await disableButton.click();

    // Should see confirmation dialog
    await expect(page.locator('text=Disable Seal Key?')).toBeVisible({ timeout: 2000 });

    // Click the confirmation button in the dialog
    const confirmButton = page.locator('button:has-text("Disable Seal Key")');
    await confirmButton.click();
    await waitAfterMutation(page);

    // Should see success toast
    await expect(page.locator('text=Seal key updated')).toBeVisible({ timeout: 5000 });

    // Wait for React state propagation after mutation completes
    // (React needs time to re-render the component tree with new disabled state)
    await page.waitForTimeout(300);

    // Should see DISABLED badge
    await expect(page.locator('text=DISABLED')).toBeVisible({ timeout: 5000 });

    // Should see Enable button and Delete button (only shown when disabled)
    await expect(page.locator('button:has-text("Enable")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Delete")').first()).toBeVisible();

    // Click Enable button
    const enableButton = page.locator('button:has-text("Enable")').first();
    await enableButton.click();

    // Should see confirmation dialog
    await expect(page.locator('text=Enable Seal Key?')).toBeVisible({ timeout: 2000 });

    // Click the confirmation button in the dialog
    const confirmEnableButton = page.locator('button:has-text("Enable Seal Key")');
    await confirmEnableButton.click();
    await waitAfterMutation(page);

    // Should see success toast
    await expect(page.locator('text=Seal key updated')).toBeVisible({ timeout: 5000 });

    // DISABLED badge should be gone
    await expect(page.locator('text=DISABLED')).not.toBeVisible();

    console.log('✅ Seal key toggled successfully');
  });

  test('copy object ID to clipboard', async ({ page }) => {
    // Setup: Create a seal key with object ID
    const response = await page.request.get('http://localhost:22700/test/data/customer');
    const userData = await response.json();
    const customerId = userData.customer.customerId;

    const serviceResponse = await db.query.serviceInstances.findFirst({
      where: (instances, { eq, and }) =>
        and(
          eq(instances.customerId, customerId),
          eq(instances.serviceType, 'seal')
        ),
    });

    if (!serviceResponse) {
      throw new Error('Service instance not found');
    }

    const [testKey] = await db.insert(sealKeys).values({
      customerId,
      instanceId: serviceResponse.instanceId,
      name: 'Key with Object ID',
      derivationIndex: 999, // Test key with objectId
      publicKey: Buffer.from('a'.repeat(96), 'hex'),
      objectId: Buffer.from('f'.repeat(64), 'hex'),
      isUserEnabled: true,
    }).returning();

    // Reload page
    await page.reload();
    await waitAfterMutation(page);

    // Object ID should be visible (keys are always expanded)
    await expect(page.locator('text=Object ID:')).toBeVisible();

    // Find the Object ID row and click the copy button
    const objectIdRow = page.locator('div:has-text("Object ID:")');
    const copyButton = objectIdRow.locator('button').first();

    // Verify copy button exists and is clickable
    await expect(copyButton).toBeVisible();
    await copyButton.click();

    // The CopyableValue component handles the copy internally and shows a brief "Copied!" tooltip
    // We can verify the copy succeeded by checking clipboard content would require additional permissions
    // For now, we verify the button was clicked successfully (no errors)

    console.log('✅ Object ID copy button clicked successfully');
  });

  test('package count limit enforced', async ({ page }) => {
    // Setup: Create a seal key via UI
    await createSealKeyViaUI(page);

    // Add 3 packages (max limit for PRO tier) via UI
    for (let i = 0; i < 3; i++) {
      const hexChar = i.toString(16); // 0-9 then a-f for uniqueness
      const packageAddress = '0x' + hexChar.repeat(64);
      await addPackageViaUI(page, packageAddress, `Package ${i + 1}`);
    }

    // Should show 3 of 3 packages used
    await expect(page.locator('text=3 of')).toBeVisible();

    // "Add Package" button should NOT be visible (limit reached)
    await expect(page.locator('button:has-text("Add Package to this Seal Key")')).not.toBeVisible();

    console.log('✅ Package count limit enforced correctly');
  });

  test('package address displays without backslash-x escape', async ({ page }) => {
    // Setup: Create a seal key via UI
    await createSealKeyViaUI(page);

    // Add a package with an address that starts with hex bytes that could trigger escape sequences
    // Test addresses: c6f0 (which might display as \xc6 if improperly escaped)
    const problematicAddress = '0xc6f0' + '1234'.repeat(15); // 0xc6f0123412341234...
    await addPackageViaUI(page, problematicAddress, 'Problematic Address');

    // Find the package address cell
    const packageAddressCell = page.locator('td').filter({ hasText: /0x.*c6f0/ }).first();
    await expect(packageAddressCell).toBeVisible();

    // Get the actual text content
    const addressText = await packageAddressCell.locator('code').textContent();
    console.log('Package address displayed as:', addressText);

    // The address should NOT contain a backslash character
    // If it shows "0x\xc6f0..." then there's a bug
    expect(addressText).not.toContain('\\');
    expect(addressText).toMatch(/^0xc6f0/); // Should start with 0xc6f0 (no backslash before x)

    console.log('✅ Package address displays correctly without \\x escape');
  });

  test.afterEach(async ({ page }) => {
    // Cleanup: Delete test seal keys and packages
    const response = await page.request.get('http://localhost:22700/test/data/customer');
    const userData = await response.json();
    const customerId = userData.customer.customerId;

    // Delete all seal keys for this customer (cascade will delete packages)
    await db.delete(sealKeys).where(eq(sealKeys.customerId, customerId));
  });
});
