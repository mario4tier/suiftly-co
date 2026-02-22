/**
 * Real Stripe Service
 *
 * Exports the real Stripe API client implementation.
 * Used by the factory in stripe-mock/index.ts when STRIPE_SECRET_KEY is configured.
 */

export { StripeService } from './stripe-service.js';
