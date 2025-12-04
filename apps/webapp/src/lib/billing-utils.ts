/**
 * Billing utility functions
 *
 * Shared formatting logic for invoice line items used across:
 * - Billing page
 * - Payment success pages
 * - Invoice PDF generation
 * - Email templates
 */

import { INVOICE_LINE_ITEM_TYPE } from '@suiftly/shared/constants';
import type { InvoiceLineItem } from '@suiftly/shared/types';

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
      return `${serviceName} Starter tier`;
    case INVOICE_LINE_ITEM_TYPE.SUBSCRIPTION_PRO:
      return `${serviceName} Pro tier`;
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
      return 'Charge';
  }
}
