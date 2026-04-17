/**
 * Invoice line item formatting
 *
 * Single source of truth for human-readable line item descriptions.
 * Used by both API (billing history) and webapp (invoice display).
 */

import { INVOICE_LINE_ITEM_TYPE, SERVICE_TYPE } from '../constants';
import type { InvoiceLineItem, ServiceType } from '../types';

/** Display names for services (proper casing for UI). */
const SERVICE_DISPLAY_NAME: Record<ServiceType, string> = {
  [SERVICE_TYPE.SEAL]: 'Seal',
  [SERVICE_TYPE.GRPC]: 'gRPC',
  [SERVICE_TYPE.GRAPHQL]: 'GraphQL',
  [SERVICE_TYPE.PLATFORM]: 'Platform',
  [SERVICE_TYPE.SSFN]: 'SSFN',
  [SERVICE_TYPE.SEALO]: 'Sealo',
};

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
 *
 * @param item - The line item data (amountUsd not needed for description)
 * @param options.includeServicePrefix - Prepend the service name (e.g., "Grpc").
 *   true by default for multi-service contexts (Billing page).
 *   Pass false on service-specific pages where the prefix is redundant.
 */
export function formatLineItemDescription(
  item: Omit<InvoiceLineItem, 'amountUsd'>,
  options?: { includeServicePrefix?: boolean },
): string {
  const includePrefix = options?.includeServicePrefix ?? true;
  const serviceName = includePrefix && item.service
    ? SERVICE_DISPLAY_NAME[item.service] ?? item.service
    : '';
  const prefix = serviceName ? `${serviceName} ` : '';

  switch (item.itemType) {
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_STARTER:
      return item.service === SERVICE_TYPE.PLATFORM ? `${prefix}Starter plan` : `${prefix}Starter tier`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO:
      return item.service === SERVICE_TYPE.PLATFORM ? `${prefix}Pro plan` : `${prefix}Pro tier`;
    case INVOICE_LINE_ITEM_TYPE.TIER_UPGRADE: {
      const base = `${prefix}tier upgrade (adjustment)`;
      return item.description ? `${base}: ${item.description}` : base;
    }
    case INVOICE_LINE_ITEM_TYPE.REQUESTS:
      return `${prefix}${item.quantity.toLocaleString()} requests @ $${item.unitPriceUsd.toFixed(4)}/req`;
    case INVOICE_LINE_ITEM_TYPE.BANDWIDTH: {
      const gb = item.quantity / (1024 * 1024 * 1024);
      return `${prefix}${gb.toFixed(3)} GB @ $${item.unitPriceUsd.toFixed(2)}/GB`;
    }
    case INVOICE_LINE_ITEM_TYPE.EXTRA_API_KEYS:
      return `${prefix}extra API keys: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/key`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_SEAL_KEYS:
      return `${prefix}extra seal keys: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/key`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_ALLOWLIST_IPS:
      return `${prefix}extra allowlist IPs: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/IP`;
    case INVOICE_LINE_ITEM_TYPE.EXTRA_PACKAGES:
      return `${prefix}extra packages: ${item.quantity} @ $${item.unitPriceUsd.toFixed(2)}/pkg`;
    case INVOICE_LINE_ITEM_TYPE.CREDIT:
      return item.creditMonth
        ? `${prefix}partial month credit (${item.creditMonth})`
        : `${prefix}credit`;
    case INVOICE_LINE_ITEM_TYPE.TAX:
      return 'Tax';
    default:
      return assertNever(item.itemType as never, `itemType in formatLineItemDescription`);
  }
}
