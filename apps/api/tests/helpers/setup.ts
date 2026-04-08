/**
 * Billing test setup helper
 *
 * Consolidates the common beforeEach boilerplate for billing integration tests:
 * reset → login → fund → subscribe platform → clear notifications.
 *
 * After this call, the customer is ready to subscribe to services and make payments.
 * Platform subscription auto-provisions seal/grpc/graphql service instances.
 */

import { db } from '@suiftly/database';
import { customers } from '@suiftly/database/schema';
import { eq } from 'drizzle-orm';
import {
  resetClock,
  resetTestData,
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
 * Handles: reset state → login → fund account →
 * subscribe to platform → clear notifications.
 *
 * Platform subscription is always required. Auto-provisions seal/grpc/graphql.
 *
 * @param options.wallet      Wallet address (default: TEST_WALLET)
 * @param options.balance     Escrow balance in USD (default: 100)
 * @param options.clockTime   Mock clock for platform subscribe (default: '2025-01-01T00:00:00Z')
 */
export async function setupBillingTest(options?: {
  wallet?: string;
  balance?: number;
  clockTime?: string;
}): Promise<SetupBillingTestResult> {
  const wallet = options?.wallet ?? TEST_WALLET;
  const balance = options?.balance ?? 100;
  const clockTime = options?.clockTime ?? '2025-01-01T00:00:00Z';

  // 1. Clean slate
  await resetClock();
  await resetTestData(wallet);

  // 2. Login (creates customer)
  const accessToken = await login(wallet);

  // 3. Get customer ID for DB assertions
  const customer = await db.query.customers.findFirst({
    where: eq(customers.walletAddress, wallet),
  });
  if (!customer) throw new Error('Test customer not found after login');
  const customerId = customer.customerId;

  // 4. Fund account (also auto-adds escrow payment method)
  await ensureTestBalance(balance, { walletAddress: wallet });

  // 5. Subscribe to platform (auto-provisions seal/grpc/graphql)
  await setClockTime(clockTime);
  await subscribePlatform(accessToken);

  // 6. Clear notifications from setup activity
  await clearNotifications(customerId);

  return { accessToken, customerId };
}
