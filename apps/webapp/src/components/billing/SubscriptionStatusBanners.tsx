/**
 * Subscription Status Banners
 *
 * Reusable notification banners for scheduled downgrades and cancellations.
 * Used by both platform (billing page) and per-service (seal overview page) subscriptions.
 */

import { Clock, AlertTriangle } from 'lucide-react';
import type { ServiceTier } from '@suiftly/shared/constants';
import { formatTierName, formatBillingDate } from '@/lib/billing-utils';

interface SubscriptionStatusBannersProps {
  scheduledTier: ServiceTier | null;
  scheduledTierEffectiveDate: string | Date | null | undefined;
  cancellationScheduledFor: string | Date | null | undefined;
  onManagePlan: () => void;
}

export function SubscriptionStatusBanners({
  scheduledTier,
  scheduledTierEffectiveDate,
  cancellationScheduledFor,
  onManagePlan,
}: SubscriptionStatusBannersProps) {
  return (
    <>
      {/* Scheduled Cancellation Banner */}
      {cancellationScheduledFor && (
        <div data-testid="cancellation-scheduled-banner" className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                Cancellation Scheduled
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                Your subscription will end on {formatBillingDate(cancellationScheduledFor)}.{' '}
                <button onClick={onManagePlan} className="text-[#f38020] hover:underline">
                  Undo cancellation
                </button>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Scheduled Downgrade Banner — only when no cancellation is pending */}
      {scheduledTier && scheduledTierEffectiveDate && !cancellationScheduledFor && (
        <div data-testid="downgrade-scheduled-banner" className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-4">
          <div className="flex items-start gap-3">
            <Clock className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                Downgrade Scheduled
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                Your plan will change to {formatTierName(scheduledTier)} on {formatBillingDate(scheduledTierEffectiveDate)}.{' '}
                <button onClick={onManagePlan} className="text-[#f38020] hover:underline">
                  Cancel scheduled change
                </button>
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
