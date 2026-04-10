/**
 * Billing utility functions
 *
 * Formatting helpers for billing UI. The core line item formatter lives in
 * @suiftly/shared/billing and is re-exported here for convenience.
 */

import { SERVICE_TIER } from '@suiftly/shared/constants';
import type { ServiceTier } from '@suiftly/shared/types';

// Re-export the single source of truth for line item descriptions
export { formatLineItemDescription } from '@suiftly/shared/billing';

/**
 * Format USD amount: "$39" for whole dollars, "$13.09" when there are cents.
 * Handles negative amounts: "-$5" or "-$5.23".
 */
export function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs % 1 === 0 ? `$${abs}` : `$${abs.toFixed(2)}`;
  return amount < 0 ? `-${formatted}` : formatted;
}

/**
 * Tier display names (Title case)
 * Use .toUpperCase() for button/badge display
 */
const TIER_DISPLAY_NAMES: Record<ServiceTier, string> = {
  [SERVICE_TIER.STARTER]: 'Starter',
  [SERVICE_TIER.PRO]: 'Pro',
};

/**
 * Format a tier for display (Title case)
 * @example formatTierName('starter') => 'Starter'
 * @example formatTierName('pro').toUpperCase() => 'PRO'
 */
export function formatTierName(tier: ServiceTier): string {
  return TIER_DISPLAY_NAMES[tier] ?? tier;
}

/**
 * Format a date for billing display (UTC, long month format)
 * @example formatBillingDate('2025-04-30') => 'April 30, 2025'
 */
export function formatBillingDate(date: string | Date | null | undefined): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
