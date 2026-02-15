/**
 * Stripe Mock Service
 *
 * Mock implementation of IStripeService for development and testing.
 * Uses in-memory state to simulate Stripe API behavior.
 *
 * Usage:
 *   import { getStripeService } from '@suiftly/database/stripe-mock';
 *   const stripeService = getStripeService();
 */

import type { IStripeService } from '@suiftly/shared/stripe-service';
import { mockStripeService } from './mock.js';

export { stripeMockConfig } from './mock-config.js';
export type { StripeMockConfig } from './mock-config.js';
export { MockStripeService, mockStripeService } from './mock.js';

/**
 * Get Stripe service instance
 * Returns mock for now, will return real implementation in production later
 */
export function getStripeService(): IStripeService {
  // For now, always return mock
  // TODO: In production, check environment variable and return real service
  // if (process.env.NODE_ENV === 'production' && !process.env.USE_MOCK_STRIPE) {
  //   return realStripeService;
  // }
  return mockStripeService;
}

/**
 * Re-export types for convenience
 */
export type {
  IStripeService,
  StripeChargeParams,
  StripeChargeResult,
  StripePaymentMethod,
} from '@suiftly/shared/stripe-service';
