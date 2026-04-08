/**
 * Seal Service Configuration Page
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { SealInteractiveForm } from '../../components/services/SealInteractiveForm';
import { Switch } from '../../components/ui/switch';
import { TextRoute } from '../../components/ui/text-route';

import { AlertCircle, PauseCircle, AlertTriangle, Loader2, Clock, Lock } from 'lucide-react';
import { type ServiceState, type ServiceTier } from '@suiftly/shared/constants';
import { trpc } from '../../lib/trpc';
import { toast } from 'sonner';
import { useServicesStatus } from '../../hooks/useServicesStatus';
import { ServiceStatusIndicator } from '../../components/ui/service-status-indicator';

export const Route = createLazyFileRoute('/services/seal/overview')({
  component: SealOverviewPage,
});

function SealOverviewPage() {
  const [isToggling, setIsToggling] = useState(false);
  const [localIsEnabled, setLocalIsEnabled] = useState(false);

  // Fetch services using React Query hook
  const { data: services, isLoading, refetch } = trpc.services.list.useQuery();

  // Unified status tracking with adaptive polling
  const {
    getServiceStatus,
    refetch: refetchStatus,
  } = useServicesStatus();

  // Get seal service status from unified query
  const sealStatus = getServiceStatus('seal');
  const isSyncing = sealStatus?.syncStatus === 'pending';

  // Toggle service mutation
  const toggleServiceMutation = trpc.services.toggleService.useMutation({
    onSuccess: () => {
      refetch();
      refetchStatus();
      setIsToggling(false);
    },
    onError: (error) => {
      console.error('Toggle service error:', error);
      toast.error(error.message || 'Failed to toggle service');
      setIsToggling(false);
      setLocalIsEnabled(isUserEnabled);
      refetch();
    },
  });

  // Find seal service
  const sealService = services?.find(s => s.serviceType === 'seal');

  // Platform subscription data from billing.getBalance (customer-level)
  const { data: balanceData } = trpc.billing.getBalance.useQuery();

  // Sync local toggle state with server state
  const isUserEnabled = sealService?.isUserEnabled ?? false;

  useEffect(() => {
    setLocalIsEnabled(isUserEnabled);
  }, [isUserEnabled]);

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading...</div>
        </div>
      </DashboardLayout>
    );
  }

  const serviceState: ServiceState = (sealService?.state as ServiceState) ?? 'not_provisioned';

  // Derive effective tier from platform subscription (seal has no own tier)
  const platformTier: ServiceTier = (balanceData?.platformTier as ServiceTier) ?? 'starter';

  // Platform gating: check if platform subscription is active
  const hasPlatform = balanceData?.platformTier != null && balanceData?.pendingInvoiceId == null;
  const blockedByPlatform = !hasPlatform;

  const getStatusBanner = () => {
    switch (serviceState) {
      case 'disabled':
        return {
          icon: PauseCircle,
          bgColor: 'bg-amber-50 dark:bg-amber-900/20',
          borderColor: 'border-amber-200 dark:border-amber-900',
          iconColor: 'text-amber-600 dark:text-amber-500',
          textColor: 'text-amber-900 dark:text-amber-200',
          message: 'Service is currently OFF. Switch to ON to start serving traffic.',
        };
      case 'enabled':
        return null;
      case 'suspended_maintenance':
        return {
          icon: AlertTriangle,
          bgColor: 'bg-blue-50 dark:bg-blue-900/20',
          borderColor: 'border-blue-200 dark:border-blue-900',
          iconColor: 'text-blue-600 dark:text-blue-500',
          textColor: 'text-blue-900 dark:text-blue-200',
          message: 'Service suspended for maintenance. Configuration and keys preserved. Resume anytime.',
        };
      case 'suspended_no_payment':
        return {
          icon: AlertCircle,
          bgColor: 'bg-red-50 dark:bg-red-900/20',
          borderColor: 'border-red-200 dark:border-red-900',
          iconColor: 'text-red-600 dark:text-red-500',
          textColor: 'text-red-900 dark:text-red-200',
          message: 'Service suspended due to payment issues. Contact support or deposit to your account to restore service.',
        };
      case 'cancellation_pending':
        return {
          icon: Clock,
          bgColor: 'bg-gray-50 dark:bg-gray-900/20',
          borderColor: 'border-gray-300 dark:border-gray-700',
          iconColor: 'text-gray-600 dark:text-gray-400',
          textColor: 'text-gray-900 dark:text-gray-200',
          message: 'Cancellation in progress. Service will be deleted in 7 days. Contact support if you need to restore access.',
        };
      default:
        return null;
    }
  };

  const banner = getStatusBanner();

  const handleToggleService = async (enabled: boolean) => {
    setLocalIsEnabled(enabled);
    setIsToggling(true);

    toggleServiceMutation.mutate({
      serviceType: 'seal',
      enabled,
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-2">
        {/* Header with service toggle */}
        <div className="pb-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">
              Seal Service
            </h1>
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 flex items-center justify-center">
                {isToggling && <Loader2 className="h-3 w-3 animate-spin text-gray-500 dark:text-gray-400" />}
              </div>
              <Switch
                id="service-toggle"
                checked={localIsEnabled}
                onCheckedChange={handleToggleService}
                disabled={isToggling || serviceState === 'not_provisioned' || blockedByPlatform}
              />
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                {localIsEnabled ? "ON" : "OFF"}
              </span>
            </div>
          </div>
          {/* Status indicator */}
          <div data-testid="service-status" className="mt-1">
            <ServiceStatusIndicator
              operationalStatus={sealStatus?.operationalStatus}
              isSyncing={isSyncing}
              fallbackIsEnabled={localIsEnabled}
              showLabel
            />
          </div>
        </div>

        {/* Platform subscription required — takes precedence over all other banners */}
        {blockedByPlatform ? (
          <div data-testid="platform-required-banner" className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-900 rounded-lg px-3 py-2 flex gap-3">
            <Lock className="h-5 w-5 text-orange-600 dark:text-orange-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm text-orange-900 dark:text-orange-200">
                <span className="font-semibold">Platform subscription required</span>
                {' — '}
                <TextRoute to="/billing">Subscribe on the Billing page</TextRoute>
                {' to unlock these features.'}
              </div>
            </div>
          </div>
        ) : (
          /* Status Banner — only shown when platform is active */
          banner && (
            <div data-testid="banner-section" className={`${banner.bgColor} border ${banner.borderColor} rounded-lg px-3 py-2 flex gap-3`}>
              <banner.icon className={`h-5 w-5 ${banner.iconColor} flex-shrink-0 mt-0.5`} />
              <div className="flex-1">
                <div className={`text-sm ${banner.textColor}`}>
                  {banner.message}
                </div>
              </div>
            </div>
          )
        )}

        {/* Config Needed Banner — API key error takes priority over seal key error (backend enforces order) */}
        {!blockedByPlatform && sealStatus?.operationalStatus === 'config_needed' && sealStatus.configNeededReason && (() => {
          const isApiKeyError = sealStatus.configNeededReason === 'No active API key';
          const tab = isApiKeyError ? 'x-api-key' : 'seal-keys';
          const tabLabel = isApiKeyError ? 'API Key tab' : 'Seal Keys tab';
          return (
            <div data-testid="config-needed-banner" className="rounded-lg border border-yellow-200 dark:border-yellow-900 bg-yellow-50 dark:bg-yellow-900/20 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">
                    Configuration Required
                  </p>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                    {sealStatus.configNeededReason}. <TextRoute to="/services/seal/overview" search={{ tab }}>Go to {tabLabel}</TextRoute>
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Two states: paid (platform active) → full interactive; everything else → gated preview.
            "Everything else" covers: no subscription, subscription pending payment, seal not yet
            provisioned (transient). The customer can always see their API key and config. */}
        {sealService && !blockedByPlatform ? (
          <SealInteractiveForm
            serviceState={serviceState}
            tier={platformTier}
            isEnabled={isUserEnabled}
            isToggling={isToggling}
            onToggleService={handleToggleService}
          />
        ) : (
          <SealInteractiveForm
            serviceState="not_provisioned"
            tier={platformTier}
            isEnabled={false}
            isGated={true}
          />
        )}
      </div>
    </DashboardLayout>
  );
}
