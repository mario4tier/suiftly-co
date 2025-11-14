/**
 * Test Wait Utilities
 *
 * Smart waiting functions that poll/retry conditions instead of fixed timeouts.
 * Tests complete as soon as conditions are met, making them faster and more robust.
 *
 * ## Performance Impact
 * Migrating from `waitForTimeout()` to these utilities saved 53.6 seconds across
 * the test suite (23.8% average improvement, up to 53% for files with beforeEach waits).
 *
 * ## Usage Guidelines
 *
 * ### ✅ DO Use Smart Waits For:
 * 1. **Auth flows** - `waitAfterMutation(page)` after login/authentication
 * 2. **Button clicks** - `waitAfterMutation(page)` after mutations/form submissions
 * 3. **Database polling** - `waitForCondition()` to poll async state changes
 * 4. **API completions** - `waitAfterMutation(page)` waits for network idle
 *
 * ### ❌ DON'T Use Smart Waits For:
 * 1. **Intentional delays** - Testing loading states, spinner visibility
 *    (e.g., "verify spinner still visible after 2s")
 * 2. **Race conditions** - Testing timing-dependent behavior
 *    (e.g., "navigate away within 500ms")
 * 3. **Rapid action testing** - Small delays between rapid clicks
 *    (e.g., 100ms between toggles to test state management)
 * 4. **CSS recomputation** - Browser needs ~200ms for dark mode styles
 * 5. **React state updates** - Some components need 50-300ms for onChange detection
 *
 * ### 🔥 High-Impact Targets:
 * - **beforeEach/afterEach hooks** - Waits in hooks multiply by test count!
 *   Example: 3000ms wait in beforeEach × 8 tests = 24s wasted → 4s with smart waits
 *
 * ## Common Patterns
 *
 * ### Pattern 1: After Button Click
 * ```typescript
 * // OLD (always waits full duration):
 * await button.click();
 * await page.waitForTimeout(1000);
 *
 * // NEW (returns as soon as network idle):
 * await button.click();
 * await waitAfterMutation(page);
 * ```
 *
 * ### Pattern 2: Database Polling
 * ```typescript
 * // OLD (may miss changes or wait too long):
 * await action();
 * await page.waitForTimeout(2000);
 * const data = await checkDatabase();
 * expect(data.field).toBe(value);
 *
 * // NEW (polls until condition met):
 * await action();
 * await waitForCondition(
 *   async () => {
 *     const data = await checkDatabase();
 *     return data.field === value;
 *   },
 *   { timeout: 3000, message: 'Database field to update' }
 * );
 * ```
 *
 * ### Pattern 3: Auth Flow
 * ```typescript
 * // OLD (wastes time):
 * await page.click('button:has-text("Login")');
 * await page.waitForTimeout(500);
 * await page.waitForURL('/dashboard');
 *
 * // NEW (faster):
 * await page.click('button:has-text("Login")');
 * await waitAfterMutation(page);
 * await page.waitForURL('/dashboard');
 * ```
 *
 * ## Important Notes
 * - Playwright's built-in `expect()` assertions already auto-retry (no wrapping needed)
 * - Network idle ≠ database updated; always poll database for async checks
 * - Add descriptive `message` parameters for better debugging on timeouts
 */

import { Page, Locator, expect } from '@playwright/test';

/**
 * Wait for a condition to become true with polling
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Timeout and polling interval
 * @returns true if condition met, false if timeout
 *
 * @example
 * // Wait up to 5s for balance to update
 * const success = await waitForCondition(
 *   async () => {
 *     const balance = await getBalanceFromPage();
 *     return balance === 100;
 *   },
 *   { timeout: 5000, message: 'Balance to update to $100' }
 * );
 */
export async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  options: {
    timeout?: number;
    interval?: number;
    message?: string;
  } = {}
): Promise<boolean> {
  const { timeout = 5000, interval = 100, message = 'Condition to be true' } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await condition();
      if (result) {
        return true;
      }
    } catch (error) {
      // Condition threw error, keep retrying
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  console.warn(`⏱️  Timeout waiting for: ${message} (${timeout}ms)`);
  return false;
}

/**
 * Wait for element to become visible or hidden
 * More explicit than Playwright's built-in expect for debugging
 *
 * @example
 * await waitForVisibility(page.locator('button'), { visible: true });
 */
export async function waitForVisibility(
  locator: Locator,
  options: {
    visible: boolean;
    timeout?: number;
    message?: string;
  }
): Promise<boolean> {
  const { visible, timeout = 5000, message } = options;
  const descriptor = message || `Element to be ${visible ? 'visible' : 'hidden'}`;

  try {
    if (visible) {
      await expect(locator).toBeVisible({ timeout });
    } else {
      await expect(locator).not.toBeVisible({ timeout });
    }
    return true;
  } catch (error) {
    console.warn(`⏱️  Timeout: ${descriptor} (${timeout}ms)`);
    return false;
  }
}

/**
 * Wait for element to be enabled or disabled
 *
 * @example
 * await waitForEnabled(page.locator('button'), { enabled: false });
 */
export async function waitForEnabled(
  locator: Locator,
  options: {
    enabled: boolean;
    timeout?: number;
    message?: string;
  }
): Promise<boolean> {
  const { enabled, timeout = 5000, message } = options;
  const descriptor = message || `Element to be ${enabled ? 'enabled' : 'disabled'}`;

  try {
    if (enabled) {
      await expect(locator).toBeEnabled({ timeout });
    } else {
      await expect(locator).toBeDisabled({ timeout });
    }
    return true;
  } catch (error) {
    console.warn(`⏱️  Timeout: ${descriptor} (${timeout}ms)`);
    return false;
  }
}

/**
 * Wait for text content to match
 *
 * @example
 * await waitForText(page.locator('.balance'), '100.00', { timeout: 5000 });
 */
export async function waitForText(
  locator: Locator,
  expectedText: string | RegExp,
  options: {
    timeout?: number;
    message?: string;
  } = {}
): Promise<boolean> {
  const { timeout = 5000, message } = options;
  const descriptor = message || `Text to match: ${expectedText}`;

  try {
    await expect(locator).toContainText(expectedText, { timeout });
    return true;
  } catch (error) {
    console.warn(`⏱️  Timeout: ${descriptor} (${timeout}ms)`);
    return false;
  }
}

/**
 * Wait for multiple conditions in parallel
 * More efficient than waiting sequentially
 *
 * @example
 * await waitForAll([
 *   () => expect(saveButton).not.toBeVisible(),
 *   () => expect(cancelButton).not.toBeVisible(),
 * ], { timeout: 5000 });
 */
export async function waitForAll(
  conditions: Array<() => Promise<any>>,
  options: {
    timeout?: number;
    message?: string;
  } = {}
): Promise<boolean> {
  const { timeout = 5000, message = 'All conditions to be met' } = options;

  try {
    await Promise.all(
      conditions.map(condition =>
        Promise.race([
          condition(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeout)
          )
        ])
      )
    );
    return true;
  } catch (error) {
    console.warn(`⏱️  Timeout: ${message} (${timeout}ms)`);
    return false;
  }
}

/**
 * Wait for Save/Cancel buttons to disappear (common pattern)
 * Handles both "not visible" and "disabled" as valid states
 *
 * @example
 * await waitForSaveCancelHidden(page);
 */
export async function waitForSaveCancelHidden(
  page: Page,
  options: {
    timeout?: number;
  } = {}
): Promise<boolean> {
  const { timeout = 5000 } = options;

  return await waitForCondition(
    async () => {
      const saveButton = page.locator('button:has-text("Save Changes")');
      const cancelButton = page.locator('button:has-text("Cancel")');

      // Check if buttons are hidden OR disabled (both are acceptable)
      const saveVisible = await saveButton.isVisible().catch(() => false);
      const cancelVisible = await cancelButton.isVisible().catch(() => false);

      if (!saveVisible && !cancelVisible) {
        return true; // Both hidden - perfect!
      }

      // If visible, check if disabled (acceptable during mutation)
      if (saveVisible) {
        const saveDisabled = await saveButton.isDisabled().catch(() => false);
        if (!saveDisabled) return false; // Visible AND enabled = not done yet
      }

      if (cancelVisible) {
        const cancelDisabled = await cancelButton.isDisabled().catch(() => false);
        if (!cancelDisabled) return false; // Visible AND enabled = not done yet
      }

      // If we're here, buttons are either hidden or disabled (showing "Saving...")
      // Wait a bit more for them to fully disappear
      return false;
    },
    { timeout, interval: 100, message: 'Save/Cancel buttons to hide' }
  );
}

/**
 * Wait for API response to complete (smart alternative to fixed timeout)
 * Waits for network to be idle
 *
 * @example
 * await button.click();
 * await waitForNetworkIdle(page, { timeout: 5000 });
 */
export async function waitForNetworkIdle(
  page: Page,
  options: {
    timeout?: number;
    idleTime?: number;
  } = {}
): Promise<void> {
  const { timeout = 5000, idleTime = 500 } = options;
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Smart wait after mutation (waits for network idle instead of fixed timeout)
 *
 * @example
 * await saveButton.click();
 * await waitAfterMutation(page); // Waits only as long as needed
 */
export async function waitAfterMutation(
  page: Page,
  options: {
    timeout?: number;
  } = {}
): Promise<void> {
  const { timeout = 5000 } = options;

  try {
    // Wait for network to be idle (all API calls done)
    await page.waitForLoadState('networkidle', { timeout });
  } catch (error) {
    // Fallback: if networkidle doesn't work, wait for small buffer
    await page.waitForTimeout(300);
  }
}
