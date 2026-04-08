/**
 * Pricing Constants — Hardcoded Sanity Check
 *
 * This is the ONLY place where pricing values are checked against hardcoded numbers.
 * All other tests import PLATFORM_TIER_PRICES_USD_CENTS and use it as the single
 * source of truth. If someone accidentally changes the constant, this test catches it.
 */

import { describe, it, expect } from 'vitest';
import { PLATFORM_TIER_PRICES_USD_CENTS, ADDON_PRICES_USD_CENTS, getTierPriceUsdCents, getAvailableTiers } from './index';

describe('Pricing Constants', () => {
  it('platform tier prices match expected values', () => {
    expect(PLATFORM_TIER_PRICES_USD_CENTS.starter).toBe(200);  // $2.00/month
    expect(PLATFORM_TIER_PRICES_USD_CENTS.pro).toBe(3900);     // $39.00/month
  });

  it('addon prices match expected values', () => {
    expect(ADDON_PRICES_USD_CENTS.sealKey).toBe(500);  // $5.00/month
    expect(ADDON_PRICES_USD_CENTS.package).toBe(200);  // $2.00/month
    expect(ADDON_PRICES_USD_CENTS.apiKey).toBe(500);   // $5.00/month
  });

  it('getTierPriceUsdCents returns correct values', () => {
    expect(getTierPriceUsdCents('starter')).toBe(200);
    expect(getTierPriceUsdCents('pro')).toBe(3900);
    expect(getTierPriceUsdCents('Starter')).toBe(200);
    expect(getTierPriceUsdCents('PRO')).toBe(3900);
  });

  it('getTierPriceUsdCents throws for unknown tier', () => {
    expect(() => getTierPriceUsdCents('enterprise')).toThrow();
    expect(() => getTierPriceUsdCents('')).toThrow();
  });

  it('getAvailableTiers returns correct tiers', () => {
    expect(getAvailableTiers('platform')).toEqual(['starter', 'pro']);
    expect(getAvailableTiers('seal')).toEqual([]);
  });
});
