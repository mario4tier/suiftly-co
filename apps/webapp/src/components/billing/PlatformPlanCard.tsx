/**
 * Platform Plan Card
 *
 * Shows platform subscription status and plan selection on the billing page.
 * Only rendered when freq_platform_sub is enabled.
 * Includes Terms of Service acceptance (persisted server-side).
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Check, Loader2, AlertCircle, Download, Settings } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';
import { fpsubs_usd_sta, fpsubs_usd_pro } from '@/lib/config';
import { formatTierName } from '@/lib/billing-utils';
import { TermsOfServiceContent } from '@/components/content/TermsOfServiceContent';
import { ChangeTierModal } from '@/components/services/ChangeTierModal';
import { SubscriptionStatusBanners } from '@/components/billing/SubscriptionStatusBanners';
import type { ServiceTier } from '@suiftly/shared/constants';

interface PlatformPlanCardProps {
  /** The platform service instance from services.list, or undefined if not subscribed */
  platformService: {
    tier: string;
    state: string;
    subPendingInvoiceId: unknown;
    scheduledTier: string | null;
    scheduledTierEffectiveDate: string | Date | null;
    cancellationScheduledFor: string | Date | null;
  } | undefined;
}

const PLATFORM_TIERS = [
  {
    id: 'starter' as ServiceTier,
    label: 'Starter',
    price: fpsubs_usd_sta,
    features: ['1 region', '50 RPS', 'Docs + Community support'],
  },
  {
    id: 'pro' as ServiceTier,
    label: 'Pro',
    price: fpsubs_usd_pro,
    features: ['All regions', '200 RPS/region', 'Burst allowed', '99.9% SLA', 'Email support (48h)'],
  },
];

export function PlatformPlanCard({ platformService }: PlatformPlanCardProps) {
  const [selectedTier, setSelectedTier] = useState<ServiceTier>('starter');
  const [tosChecked, setTosChecked] = useState(false);
  const [tosModalOpen, setTosModalOpen] = useState(false);
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const utils = trpc.useUtils();

  const acceptTosMutation = trpc.billing.acceptTos.useMutation({
    onSuccess: () => {
      utils.billing.getBalance.invalidate();
    },
  });

  const subscribeMutation = trpc.services.subscribe.useMutation({
    onSuccess: (data) => {
      utils.services.list.invalidate();
      utils.billing.getNextScheduledPayment.invalidate();
      if (data.paymentPending) {
        toast.warning('Platform subscription created. Payment pending.');
      } else {
        toast.success(`Subscribed to Platform ${formatTierName(selectedTier)} plan!`);
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Subscription failed');
    },
  });

  const handleSubscribe = () => {
    subscribeMutation.mutate({
      serviceType: 'platform',
      tier: selectedTier,
    });
  };

  const handleDownloadPDF = () => {
    const link = document.createElement('a');
    link.href = '/terms-of-service.pdf';
    link.download = 'suiftly-terms-of-service.pdf';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const isPending = platformService?.subPendingInvoiceId != null;
  const isActive = platformService && !isPending;

  // Active platform subscription
  if (isActive) {
    return (
      <>
        <Card className="p-6 border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-900/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <h3 className="font-semibold text-green-900 dark:text-green-100">
                  Platform {formatTierName(platformService.tier as ServiceTier)} Plan
                </h3>
                <p className="text-sm text-green-700 dark:text-green-300">
                  Active &mdash; you have access to all Suiftly services
                </p>
              </div>
            </div>
            <button
              onClick={() => setChangePlanOpen(true)}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex items-center gap-1"
            >
              <Settings className="w-3.5 h-3.5" />
              Change Plan
            </button>
          </div>

          <div className="mt-3">
            <SubscriptionStatusBanners
              scheduledTier={(platformService.scheduledTier as ServiceTier) ?? null}
              scheduledTierEffectiveDate={platformService.scheduledTierEffectiveDate}
              cancellationScheduledFor={platformService.cancellationScheduledFor}
              onManagePlan={() => setChangePlanOpen(true)}
            />
          </div>
        </Card>
        <ChangeTierModal
          isOpen={changePlanOpen}
          onClose={() => setChangePlanOpen(false)}
          serviceType="platform"
          onSuccess={() => utils.services.list.invalidate()}
        />
      </>
    );
  }

  // Pending payment
  if (isPending) {
    return (
      <Card className="p-6 border-orange-200 dark:border-orange-900 bg-orange-50/50 dark:bg-orange-900/10">
        <div className="flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-orange-600 dark:text-orange-400 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-orange-900 dark:text-orange-100">
              Platform {formatTierName(platformService!.tier as ServiceTier)} Plan &mdash; Payment Pending
            </h3>
            <p className="text-sm text-orange-700 dark:text-orange-300">
              Add a payment method or deposit funds to activate your platform subscription.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  // No subscription — show plan selection with ToS
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-1">Choose a Platform Plan</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        A platform subscription is required to use Suiftly services.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-4">
        {PLATFORM_TIERS.map((tier) => {
          const isSelected = selectedTier === tier.id;
          return (
            <div
              key={tier.id}
              onClick={() => setSelectedTier(tier.id)}
              className={`
                relative cursor-pointer rounded-lg transition-all border-2 p-4
                ${isSelected
                  ? 'border-[#f38020] bg-[#f38020]/5'
                  : 'border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500'
                }
              `}
            >
              {isSelected && (
                <div className="absolute top-2 right-2">
                  <Check className="w-4 h-4 text-[#f38020]" />
                </div>
              )}
              <div className="font-semibold text-gray-900 dark:text-gray-100">
                {tier.label}
              </div>
              <div className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-1">
                ${tier.price}<span className="text-sm font-normal text-gray-500">/mo</span>
              </div>
              <ul className="text-xs text-gray-500 dark:text-gray-400 mt-2 space-y-0.5">
                {tier.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* Terms of Service */}
      <div className="flex items-center space-x-2 mb-4">
        <Checkbox
          id="platform-tos"
          checked={tosChecked}
          onCheckedChange={(checked) => {
            setTosChecked(!!checked);
            if (checked) {
              acceptTosMutation.mutate();
            }
          }}
          disabled={acceptTosMutation.isPending}
        />
        <Label htmlFor="platform-tos" className="text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
          Agree to{' '}
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); setTosModalOpen(true); }}
            className="text-[#f38020] hover:underline"
          >
            terms of service
          </button>
          {' '}including subscription and per-request charges
        </Label>
      </div>

      <Button
        onClick={handleSubscribe}
        disabled={!tosChecked || subscribeMutation.isPending}
        className="w-full bg-[#f38020] hover:bg-[#d96e1a] text-white"
      >
        {subscribeMutation.isPending ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Subscribing...
          </>
        ) : (
          `Subscribe to ${formatTierName(selectedTier)} Plan — $${PLATFORM_TIERS.find(t => t.id === selectedTier)!.price}/mo`
        )}
      </Button>

      {/* Terms of Service Modal */}
      <Dialog open={tosModalOpen} onOpenChange={setTosModalOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4 mb-2">
              <div className="flex-1 min-w-0">
                <DialogTitle>Terms of Service</DialogTitle>
              </div>
              <Button variant="ghost" size="sm" onClick={handleDownloadPDF} className="flex-shrink-0">
                <Download className="h-4 w-4 mr-1" /> PDF
              </Button>
            </div>
          </DialogHeader>
          <div className="overflow-y-auto max-h-[60vh] pr-2">
            <TermsOfServiceContent />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTosModalOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
