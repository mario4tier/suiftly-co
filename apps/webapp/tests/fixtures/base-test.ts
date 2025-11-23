/**
 * Base test fixture with automatic clock reset
 *
 * This fixture ensures every test starts with a real clock
 * unless the test explicitly sets mock time.
 */

import { test as base } from '@playwright/test';
import { resetClock } from '../helpers/clock';

/**
 * Extended test with automatic clock reset
 *
 * Usage in test files:
 * ```typescript
 * import { test } from '../fixtures/base-test';
 *
 * test('my test', async ({ page }) => {
 *   // Clock is automatically reset to real time
 *   // Your test code here
 * });
 * ```
 */
export const test = base.extend({
  // Auto-fixture that runs before each test
  page: async ({ page, request }, use) => {
    // Reset clock to real time before each test
    await resetClock(request);

    // Use the page
    await use(page);
  },
});

export { expect } from '@playwright/test';