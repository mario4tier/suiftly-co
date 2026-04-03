/**
 * Billing test setup helper
 *
 * Consolidates the common beforeEach boilerplate for billing integration tests:
 * reset → config flags → login → fund → subscribe platform → clear notifications.
 *
 * After this call, the customer is ready to subscribe to services and make payments.
 */

import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import {
  resetClock,
  resetTestData,
  setConfigFlags,
  setClockTime,
  ensureTestBalance,
  subscribePlatform,
} from './http.js';
import { login, TEST_WALLET } from './auth.js';
import { clearNotifications } from './notifications.js';

export interface SetupBillingTestResult {
  accessToken: string;
  customerId: number;
}

/**
 * Set up a customer ready for billing tests.
 *
 * Handles: reset state → set config flags → login → fund account →
 * subscribe to platform (if required) → clear notifications.
 *
 * @param options.wallet      Wallet address (default: TEST_WALLET)
 * @param options.balance     Escrow balance in USD (default: 100)
 * @param options.clockTime   Mock clock for platform subscribe (default: '2025-01-01T00:00:00Z')
 * @param options.mode        Subscription gating mode:
 *   - 'both' (default): platform + per-service subs required
 *   - 'platform-only':  platform required, per-service optional
 *   - 'seal-only':      no platform required, seal sub required (legacy)
 */
export async function setupBillingTest(options?: {
  wallet?: string;
  balance?: number;
  clockTime?: string;
  mode?: 'both' | 'platform-only' | 'seal-only';
}): Promise<SetupBillingTestResult> {
  const wallet = options?.wallet ?? TEST_WALLET;
  const balance = options?.balance ?? 100;
  const clockTime = options?.clockTime ?? '2025-01-01T00:00:00Z';
  const mode = options?.mode ?? 'both';

  const needsPlatform = mode === 'both' || mode === 'platform-only';

  // 1. Clean slate
  await resetClock();
  await resetTestData(wallet);

  // 2. Config flags
  const flags: Record<string, string> = {
    freq_platform_sub: needsPlatform ? '1' : '0',
    freq_seal_sub: mode === 'platform-only' ? '0' : '1',
  };
  await setConfigFlags(flags);

  // 3. Login (creates customer)
  const accessToken = await login(wallet);

  // 4. Get customer ID for DB assertions
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, wallet),
  });
  if (!customer) throw new Error('Test customer not found after login');
  const customerId = customer.customerId;

  // 5. Fund account (also auto-adds escrow payment method)
  await ensureTestBalance(balance, { walletAddress: wallet });

  // 6. Subscribe to platform (gates unlocked after this)
  if (needsPlatform) {
    await setClockTime(clockTime);
    await subscribePlatform(accessToken);
  }

  // 7. Clear notifications from setup activity
  await clearNotifications(customerId);

  return { accessToken, customerId };
}
