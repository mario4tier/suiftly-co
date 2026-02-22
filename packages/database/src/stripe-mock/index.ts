/**
 * Stripe Service Factory
 *
 * Returns either the real Stripe API client or the mock implementation,
 * depending on whether STRIPE_SECRET_KEY is configured.
 *
 * Usage:
 *   import { getStripeService } from '@suiftly/database/stripe-mock';
 *   const stripeService = getStripeService();
 */

import type { IStripeService } from '@suiftly/shared/stripe-service';
import { StripeService } from '../stripe-service/stripe-service.js';
import { mockStripeService } from './mock.js';

export { stripeMockConfig } from './mock-config.js';
export type { StripeMockConfig } from './mock-config.js';
export { MockStripeService, mockStripeService } from './mock.js';

/** Cached real service instance (created once, reused) */
let realStripeService: IStripeService | null = null;

/** When true, getStripeService() returns mock regardless of STRIPE_SECRET_KEY */
let forceMock = false;

/**
 * Get Stripe service instance.
 *
 * Selection logic:
 * - If forceMock is set (via test endpoint) → mock
 * - If STRIPE_SECRET_KEY is set and non-empty → real Stripe API client
 * - Otherwise → mock (in-memory, for development and testing)
 *
 * The real service is created lazily and cached as a singleton.
 */
export function getStripeService(): IStripeService {
  if (forceMock) {
    return mockStripeService;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (secretKey && secretKey.length > 0) {
    if (!realStripeService) {
      realStripeService = new StripeService(secretKey);
      console.log('[STRIPE] Using real Stripe service (API key configured)');
    }
    return realStripeService;
  }

  return mockStripeService;
}

/**
 * Force mock mode for tests. When true, getStripeService() returns
 * MockStripeService even if STRIPE_SECRET_KEY is configured.
 */
export function setStripeForceMock(value: boolean): void {
  forceMock = value;
  if (value) {
    console.log('[STRIPE] Force-mock mode enabled (tests)');
  } else {
    console.log('[STRIPE] Force-mock mode disabled');
  }
}

/**
 * Reset the cached real service instance.
 * Only needed for tests that switch between real and mock.
 */
export function resetStripeServiceCache(): void {
  realStripeService = null;
}

/**
 * Re-export types for convenience
 */
export type {
  IStripeService,
  StripeChargeParams,
  StripeChargeResult,
  StripePaymentMethod,
  StripeRefundParams,
  StripeRefundResult,
} from '@suiftly/shared/stripe-service';
