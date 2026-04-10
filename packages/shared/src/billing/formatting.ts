/**
 * Invoice line item formatting
 *
 * Single source of truth for human-readable line item descriptions.
 * Used by both API (billing history) and webapp (invoice display).
 */

import { INVOICE_LINE_ITEM_TYPE, SERVICE_TYPE } from '../constants';
import type { InvoiceLineItem } from '../types';

/**
 * TypeScript exhaustiveness check helper.
 * If a new enum value is added, TypeScript will error here at compile time.
 */
function assertNever(value: never, context: string): string {
  console.error(`[billing] Unhandled ${context}: ${JSON.stringify(value)}`);
  return 'Charge'; // Graceful fallback for runtime
}

/**
 * Format an invoice line item for display.
 * Converts structured data to a human-readable description.
 */
export function formatLineItemDescription(item: Omit<InvoiceLineItem, 'amountUsd'>): string {
  const serviceName = item.service
    ? item.service.charAt(0).toUpperCase() + item.service.slice(1)
    : '';

  switch (item.itemType) {
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER:
      return item.service === SERVICE_TYPE.PLATFORM ? 'Platform Starter plan' : `${serviceName} Starter tier`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO:
      return item.service === SERVICE_TYPE.PLATFORM ? 'Platform Pro plan' : `${serviceName} Pro tier`;
    case INVOICE_LINE_ITEM_TYPE.TIER_UPGRADE: {
      const base = `${serviceName} tier upgrade (adjustment)`;
      return item.description ? `${base}: ${item.description}` : base;
    }
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
      return assertNever(item.itemType as never, `itemType in formatLineItemDescription`);
  }
}
