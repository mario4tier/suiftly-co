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
import { Check, Loader2, Download, Settings, Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { trpc } from '@/lib/trpc';
import { toast } from 'sonner';
import { fpsubs_usd_sta, fpsubs_usd_pro } from '@/lib/config';
import { formatTierName } from '@/lib/billing-utils';
import { TermsOfServiceContent } from '@/components/content/TermsOfServiceContent';
import { ChangeTierModal } from '@/components/services/ChangeTierModal';
import { SubscriptionStatusBanners } from '@/components/billing/SubscriptionStatusBanners';
import type { ServiceTier } from '@suiftly/shared/constants';

interface PlatformPlanCardProps {
  /** Platform subscription data from billing.getBalance (customer-level fields) */
  platformTier: string | null;
  paidOnce: boolean;
  pendingInvoiceId: number | null;
  scheduledPlatformTier: string | null;
  scheduledPlatformTierEffectiveDate: string | null;
  platformCancellationScheduledFor: string | null;
}

interface TierFeature {
  text: string;
  info?: string;
}

const PLATFORM_TIERS: {
  id: ServiceTier;
  label: string;
  price: number;
  features: TierFeature[];
}[] = [
  {
    id: 'starter',
    label: 'Starter',
    price: fpsubs_usd_sta,
    features: [
      { text: '1 region' },
      { text: '50 RPS' },
      { text: 'Docs + Community support' },
    ],
  },
  {
    id: 'pro',
    label: 'Pro',
    price: fpsubs_usd_pro,
    features: [
      { text: 'Global geo-steering and failover (3 regions)', info: 'Closest server automatically selected. Regional load-balancing and automatic inter-region failover ensures high availability.' },
      { text: '200 RPS/region', info: 'Per-region rate limit. Burst allowed above limit when capacity is available.' },
      { text: '99.9% SLA' },
      { text: 'Email support (48h)' },
    ],
  },
];

export function PlatformPlanCard({ platformTier, paidOnce, pendingInvoiceId, scheduledPlatformTier, scheduledPlatformTierEffectiveDate, platformCancellationScheduledFor }: PlatformPlanCardProps) {
  const [selectedTier, setSelectedTier] = useState<ServiceTier>('starter');
  const [tosModalOpen, setTosModalOpen] = useState(false);
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const utils = trpc.useUtils();

  // TOS state: checkbox shows checked on click (optimistic), but subscribe button
  // requires server-confirmed acceptance to prevent bypassing on mutation failure.
  const { data: balanceData } = trpc.billing.getBalance.useQuery();
  const tosAcceptedOnServer = !!balanceData?.tosAcceptedAt;
  const [tosUserClicked, setTosUserClicked] = useState(false);
  const tosChecked = tosAcceptedOnServer || tosUserClicked;

  const acceptTosMutation = trpc.billing.acceptTos.useMutation({
    onSuccess: () => {
      utils.billing.getBalance.invalidate();
    },
  });

  const subscribeMutation = trpc.services.subscribe.useMutation({
    onSuccess: (data) => {
      utils.services.list.invalidate();
      utils.billing.getBalance.invalidate();
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

  // Once subscribed (any state including payment pending), show the plan card
  // with Change Plan button. Only show onboarding when no tier is set.
  // Status issues (payment pending, suspended, etc.) are surfaced by the billing
  // page's own notification section — this card just shows the plan and actions.
  if (platformTier) {
    const isPendingPayment = pendingInvoiceId != null;
    const showCheck = paidOnce;
    const tierLabel = `Platform ${formatTierName(platformTier as ServiceTier)} Plan${isPendingPayment ? ' - Pending' : ''}`;

    return (
      <>
        <Card className="px-4 py-3 border-green-200 dark:border-green-900 bg-green-50/50 dark:bg-green-900/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {showCheck && (
                <Check className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
              )}
              <span className="font-semibold text-sm text-green-900 dark:text-green-100">
                {tierLabel}
              </span>
            </div>
            <button
              onClick={() => setChangePlanOpen(true)}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex items-center gap-1"
            >
              <Settings className="w-3.5 h-3.5" />
              Change Plan
            </button>
          </div>
          <SubscriptionStatusBanners
            scheduledTier={(scheduledPlatformTier as ServiceTier) ?? null}
            scheduledTierEffectiveDate={scheduledPlatformTierEffectiveDate}
            cancellationScheduledFor={platformCancellationScheduledFor}
            onManagePlan={() => setChangePlanOpen(true)}
          />
        </Card>
        <ChangeTierModal
          isOpen={changePlanOpen}
          onClose={() => setChangePlanOpen(false)}
          serviceType="platform"
          onSuccess={() => {
            utils.services.list.invalidate();
            utils.billing.getBalance.invalidate();
          }}
        />
      </>
    );
  }

  // No subscription (or pending initial payment) — show plan selection with ToS
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
                  <li key={f.text} className="flex items-center gap-1">
                    {f.text}
                    {f.info && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Info className="h-3 w-3" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64">
                          <p className="text-sm text-gray-600 dark:text-gray-300">{f.info}</p>
                        </PopoverContent>
                      </Popover>
                    )}
                  </li>
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
            setTosUserClicked(!!checked);
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
        disabled={!tosAcceptedOnServer || subscribeMutation.isPending}
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
