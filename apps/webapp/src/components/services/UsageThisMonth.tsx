/**
 * Usage This Month card
 *
 * Displays current billing period usage line items with amounts.
 * Shows a total row only when there are multiple line items.
 */

import { formatLineItemDescription } from '@/lib/billing-utils';
import type { InvoiceLineItem } from '@suiftly/shared/types';

interface UsageThisMonthProps {
  items: Omit<InvoiceLineItem, 'creditMonth' | 'description'>[];
}

export function UsageThisMonth({ items }: UsageThisMonthProps) {
  const total = items.reduce((sum, item) => sum + item.amountUsd, 0);
  const showTotal = items.length > 1;

  return (
    <div className="rounded-lg border p-4 dark:border-gray-800">
      <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
        Usage This Month
      </div>
      <div className="space-y-1.5 text-sm">
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatLineItemDescription(item, { includeServicePrefix: false })}
            </span>
            <span className="text-sm text-gray-900 dark:text-gray-100">
              ${item.amountUsd.toFixed(2)}
            </span>
          </div>
        ))}
        {showTotal && (
          <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 pt-1.5">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Total</span>
            <span data-testid="usage-total" className="text-sm font-bold text-gray-900 dark:text-gray-100">
              ${total.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
