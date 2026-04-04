/**
 * Billing utility functions
 *
 * Shared formatting logic for invoice line items used across:
 * - Billing page
 * - Payment success pages
 * - Invoice PDF generation
 * - Email templates
 */

import { INVOICE_LINE_ITEM_TYPE, SERVICE_TIER, SERVICE_TYPE } from '@suiftly/shared/constants';

/**
 * Format USD amount: "$29" for whole dollars, "$13.09" when there are cents.
 * Handles negative amounts: "-$5" or "-$5.23".
 */
export function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs % 1 === 0 ? `$${abs}` : `$${abs.toFixed(2)}`;
  return amount < 0 ? `-${formatted}` : formatted;
}
import type { InvoiceLineItem, ServiceTier } from '@suiftly/shared/types';

/**
 * TypeScript exhaustiveness check helper.
 * If a new enum value is added, TypeScript will error here at compile time.
 */
function assertNever(value: never, context: string): string {
  console.error(`[billing-utils] Unhandled ${context}: ${JSON.stringify(value)}`);
  return 'Charge'; // Graceful fallback for runtime
}

/**
 * Tier display names (Title case)
 * Use .toUpperCase() for button/badge display
 */
const TIER_DISPLAY_NAMES: Record<ServiceTier, string> = {
  [SERVICE_TIER.STARTER]: 'Starter',
  [SERVICE_TIER.PRO]: 'Pro',
  [SERVICE_TIER.ENTERPRISE]: 'Enterprise',
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

/**
 * Format an invoice line item for display
 * Converts structured data to human-readable description
 */
export function formatLineItemDescription(item: InvoiceLineItem): string {
  const serviceName = item.service
    ? item.service.charAt(0).toUpperCase() + item.service.slice(1)
    : '';

  switch (item.itemType) {
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER:
      return item.service === SERVICE_TYPE.PLATFORM ? 'Platform Starter plan' : `${serviceName} Starter tier`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO:
      return item.service === SERVICE_TYPE.PLATFORM ? 'Platform Pro plan' : `${serviceName} Pro tier`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_ENTERPRISE:
      return `${serviceName} Enterprise tier`;
    case INVOICE_LINE_ITEM_TYPE.TIER_UPGRADE:
      return `${serviceName} tier upgrade (pro-rated)`;
    case INVOICE_LINE_ITEM_TYPE.REQUESTS:
      return `${serviceName} usage: ${item.quantity.toLocaleString()} req @ $${item.unitPriceUsd.toFixed(4)}/req`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_API_KEYS:
      return `${serviceName} extra API keys: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/key`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_SEAL_KEYS:
      return `${serviceName} extra seal keys: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/key`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_ALLOWLIST_IPS:
      return `${serviceName} extra allowlist IPs: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/IP`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_PACKAGES:
      return `${serviceName} extra packages: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/pkg`;
    case INVOICE_LINE_ITEM_TYPE.CREDIT:
      return item.creditMonth
        ? `${serviceName ? serviceName + ' ' : ''}partial month credit (${item.creditMonth})`
        : `${serviceName ? serviceName + ' ' : ''}credit`;
    case INVOICE_LINE_ITEM_TYPE.TAX:
      return 'Tax';
    default:
      // TypeScript exhaustiveness check - will error at compile time if new enum values are added
      return assertNever(item.itemType as never, `itemType in formatLineItemDescription`);
  }
}
