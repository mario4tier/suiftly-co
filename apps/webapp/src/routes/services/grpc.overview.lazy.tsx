/**
 * gRPC Service Overview Page
 */

import { createLazyFileRoute, useSearch, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useMemo } from 'react';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { Switch } from '../../components/ui/switch';
import { TextRoute } from '../../components/ui/text-route';
import { ApiKeysSection } from '../../components/services/ApiKeysSection';
import { IpAllowlistSection } from '../../components/services/IpAllowlistSection';
import { SettingsLink } from '../../components/ui/settings-link';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Button } from '../../components/ui/button';
import { Label } from '../../components/ui/label';
import {
  AlertCircle, PauseCircle, AlertTriangle, Loader2, Clock, Lock, Info,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../components/ui/popover';
import { type ServiceState, type ServiceTier, USAGE_PRICING_CENTS_PER_1000 } from '@suiftly/shared/constants';
import { trpc } from '../../lib/trpc';
import { toast } from 'sonner';
import { useServicesStatus } from '../../hooks/useServicesStatus';
import { ServiceStatusIndicator } from '../../components/ui/service-status-indicator';
import type { InvoiceLineItem } from '@suiftly/shared/types';

export const Route = createLazyFileRoute('/services/grpc/overview')({
  component: GrpcOverviewPage,
});

function GrpcOverviewPage() {
  const [isToggling, setIsToggling] = useState(false);
  const [localIsEnabled, setLocalIsEnabled] = useState(false);

  // Fetch services
  const { data: services, isLoading, refetch } = trpc.services.list.useQuery();

  // Unified status tracking
  const { getServiceStatus, refetch: refetchStatus } = useServicesStatus();
  const grpcStatus = getServiceStatus('grpc');
  const isSyncing = grpcStatus?.syncStatus === 'pending';

  // Toggle service mutation
  const toggleServiceMutation = trpc.services.toggleService.useMutation({
    onSuccess: () => {
      refetch();
      refetchStatus();
      setIsToggling(false);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to toggle service');
      setIsToggling(false);
      setLocalIsEnabled(isUserEnabled);
      refetch();
    },
  });

  // Find gRPC service
  const grpcService = services?.find(s => s.serviceType === 'grpc');

  // Platform subscription data
  const { data: balanceData } = trpc.billing.getBalance.useQuery();

  const isUserEnabled = grpcService?.isUserEnabled ?? false;

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

  const serviceState: ServiceState = (grpcService?.state as ServiceState) ?? 'not_provisioned';
  const platformTier: ServiceTier = (balanceData?.platformTier as ServiceTier) ?? 'starter';
  const hasPlatform = balanceData?.platformTier != null && balanceData?.pendingInvoiceId == null;
  const blockedByPlatform = !hasPlatform;
  const isGated = blockedByPlatform || !grpcService;

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
          message: 'Service suspended for maintenance.',
        };
      case 'suspended_no_payment':
        return {
          icon: AlertCircle,
          bgColor: 'bg-red-50 dark:bg-red-900/20',
          borderColor: 'border-red-200 dark:border-red-900',
          iconColor: 'text-red-600 dark:text-red-500',
          textColor: 'text-red-900 dark:text-red-200',
          message: 'Service suspended due to payment issues.',
        };
      default:
        return null;
    }
  };

  const banner = getStatusBanner();

  const handleToggleService = async (enabled: boolean) => {
    setLocalIsEnabled(enabled);
    setIsToggling(true);
    toggleServiceMutation.mutate({ serviceType: 'grpc', enabled });
  };

  return (
    <DashboardLayout>
      <div className="space-y-2">
        {/* Header with service toggle */}
        <div className="pb-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">
              gRPC Service
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
                {localIsEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
          <div data-testid="service-status" className="mt-1">
            <ServiceStatusIndicator
              operationalStatus={grpcStatus?.operationalStatus}
              isSyncing={isSyncing}
              fallbackIsEnabled={localIsEnabled}
              showLabel
            />
          </div>
        </div>

        {/* Platform subscription required banner */}
        {blockedByPlatform ? (
          <div data-testid="platform-required-banner" className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-900 rounded-lg px-3 py-2 flex gap-3">
            <Lock className="h-5 w-5 text-orange-600 dark:text-orange-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm text-orange-900 dark:text-orange-200">
                <span className="font-semibold">Platform subscription required</span>
                {' -- '}
                <TextRoute to="/billing">Subscribe on the Billing page</TextRoute>
                {' to unlock these features.'}
              </div>
            </div>
          </div>
        ) : banner && (
          <div className={`${banner.bgColor} border ${banner.borderColor} rounded-lg px-3 py-2 flex gap-3`}>
            <banner.icon className={`h-5 w-5 ${banner.iconColor} flex-shrink-0 mt-0.5`} />
            <div className="flex-1">
              <div className={`text-sm ${banner.textColor}`}>{banner.message}</div>
            </div>
          </div>
        )}

        {/* Config Needed Banner */}
        {!blockedByPlatform && grpcStatus?.operationalStatus === 'config_needed' && grpcStatus.configNeededReason && (
          <div data-testid="config-needed-banner" className="rounded-lg border border-yellow-200 dark:border-yellow-900 bg-yellow-50 dark:bg-yellow-900/20 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-yellow-800 dark:text-yellow-200">Configuration Required</p>
                <p className="text-sm text-yellow-700 dark:text-yellow-300 mt-1">
                  {grpcStatus.configNeededReason}. <TextRoute to="/services/grpc/overview" search={{ tab: 'x-api-key' }}>Go to API Key tab</TextRoute>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Interactive Form */}
        <GrpcInteractiveForm
          serviceState={serviceState}
          tier={platformTier}
          isEnabled={isUserEnabled}
          isGated={isGated}
        />
      </div>
    </DashboardLayout>
  );
}

// ============================================================================
// gRPC Interactive Form (simplified version of SealInteractiveForm)
// ============================================================================

interface GrpcInteractiveFormProps {
  serviceState: ServiceState;
  tier: ServiceTier;
  isEnabled: boolean;
  isGated?: boolean;
}

function GrpcInteractiveForm({ serviceState, tier, isEnabled, isGated = false }: GrpcInteractiveFormProps) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();

  // Read tab from URL query parameter for deep linking
  const searchParams = useSearch({ strict: false }) as { tab?: string };
  const validTabs = ['overview', 'x-api-key', 'settings'];
  const currentTab = validTabs.includes(searchParams.tab || '') ? searchParams.tab! : 'overview';

  const handleTabChange = (tab: string) => {
    navigate({ to: '/services/grpc/overview', search: { tab } });
  };

  // API Keys
  const { data: apiKeysData } = trpc.grpc.listApiKeys.useQuery(undefined, { enabled: !isGated });
  const { data: usageStats } = trpc.grpc.getUsageStats.useQuery(undefined, { enabled: !isGated });
  const { data: moreSettings } = trpc.grpc.getMoreSettings.useQuery(undefined, { enabled: !isGated });

  // Draft invoice for usage display
  const { data: nextPayment } = trpc.billing.getNextScheduledPayment.useQuery(undefined, { enabled: !isGated });

  const createApiKeyMutation = trpc.grpc.createApiKey.useMutation({
    onSuccess: (data) => {
      toast.success('API key created');
      utils.grpc.listApiKeys.invalidate();
      utils.grpc.getUsageStats.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const revokeApiKeyMutation = trpc.grpc.revokeApiKey.useMutation({
    onSuccess: () => {
      toast.success('API key revoked');
      utils.grpc.listApiKeys.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const reEnableApiKeyMutation = trpc.grpc.reEnableApiKey.useMutation({
    onSuccess: () => {
      toast.success('API key re-enabled');
      utils.grpc.listApiKeys.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteApiKeyMutation = trpc.grpc.deleteApiKey.useMutation({
    onSuccess: () => {
      toast.success('API key deleted');
      utils.grpc.listApiKeys.invalidate();
      utils.grpc.getUsageStats.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const updateBurstMutation = trpc.grpc.updateBurstSetting.useMutation({
    onSuccess: () => {
      toast.success('Burst setting updated');
      utils.grpc.getMoreSettings.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const updateIpAllowlistMutation = trpc.grpc.updateIpAllowlist.useMutation({
    onSuccess: () => {
      utils.grpc.getMoreSettings.invalidate();
      utils.services.getServicesStatus.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  // Transform API keys for ApiKeysSection
  const transformedApiKeys = useMemo(() => {
    if (!apiKeysData) return [];
    return apiKeysData.map(key => ({
      id: String(key.apiKeyFp),
      key: key.keyPreview,
      fullKey: key.fullKey,
      isRevoked: !key.isUserEnabled,
      createdAt: key.createdAt ? new Date(key.createdAt).toLocaleDateString() : undefined,
    }));
  }, [apiKeysData]);

  const maxApiKeys = usageStats?.apiKeys.total ?? 2;

  // Extract gRPC usage from draft invoice
  const grpcUsageItem = useMemo(() => {
    if (!nextPayment?.lineItems) return null;
    return (nextPayment.lineItems as InvoiceLineItem[]).find(
      item => item.service === 'grpc' && item.itemType === 'requests'
    );
  }, [nextPayment]);

  return (
    <Tabs value={currentTab} onValueChange={handleTabChange} className="mt-4">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="x-api-key">X-API-Key</TabsTrigger>
        <TabsTrigger value="settings">More Settings</TabsTrigger>
      </TabsList>

      {/* Overview Tab */}
      <TabsContent value="overview" className="mt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Service Overview */}
          <div className="rounded-lg border p-4 dark:border-gray-800">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Service Overview</h3>
            <table className="w-full text-sm">
              <tbody>
                {/* API Keys */}
                <tr>
                  <td className="py-1.5 text-gray-500 dark:text-gray-400">API Keys</td>
                  <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                    {usageStats?.apiKeys.used ?? 0} of {usageStats?.apiKeys.total ?? 2}
                  </td>
                  <td className="py-1.5 pl-2 w-6">
                    <SettingsLink to="/services/grpc/overview" search={{ tab: 'x-api-key' }} />
                  </td>
                </tr>
                {/* Burst */}
                <tr>
                  <td className="py-1.5 text-gray-500 dark:text-gray-400">Burst</td>
                  <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                    {tier === 'starter'
                      ? <span className="text-gray-400 dark:text-gray-500">Pro only</span>
                      : (moreSettings?.burstEnabled ? 'Enabled' : 'Disabled')}
                  </td>
                  <td className="py-1.5 pl-2 w-6">
                    {tier !== 'starter' && (
                      <SettingsLink to="/services/grpc/overview" search={{ tab: 'settings' }} />
                    )}
                  </td>
                </tr>
                {/* IPv4 Allowlist */}
                <tr>
                  <td className="py-1.5 text-gray-500 dark:text-gray-400">IPv4 Allowlist</td>
                  <td className="py-1.5 text-gray-900 dark:text-gray-100 text-right">
                    {tier === 'starter'
                      ? <span className="text-gray-400 dark:text-gray-500">Pro only</span>
                      : (moreSettings?.ipAllowlistEnabled
                          ? `${usageStats?.allowlist.used ?? 0} / ${usageStats?.allowlist.total ?? 2}`
                          : 'Disabled')}
                  </td>
                  <td className="py-1.5 pl-2 w-6">
                    {tier !== 'starter' && (
                      <SettingsLink to="/services/grpc/overview" search={{ tab: 'settings' }} />
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Usage This Month */}
          <div className="rounded-lg border p-4 dark:border-gray-800">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">Usage This Month</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Requests</span>
                <span className="text-gray-900 dark:text-gray-100">
                  {grpcUsageItem ? grpcUsageItem.quantity.toLocaleString() : '0'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Price per request</span>
                <span className="text-gray-900 dark:text-gray-100">
                  ${(USAGE_PRICING_CENTS_PER_1000.grpc / 100000).toFixed(4)}
                </span>
              </div>
              <div className="flex justify-between font-medium border-t pt-2 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400">Total</span>
                <span className="text-gray-900 dark:text-gray-100">
                  ${grpcUsageItem ? (grpcUsageItem.amountCents / 100).toFixed(2) : '0.00'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </TabsContent>

      {/* API Keys Tab */}
      <TabsContent value="x-api-key" className="mt-4">
        <ApiKeysSection
          apiKeys={transformedApiKeys}
          maxApiKeys={maxApiKeys}
          isReadOnly={isGated}
          onAddKey={() => createApiKeyMutation.mutate()}
          onRevokeKey={(id) => revokeApiKeyMutation.mutate({ apiKeyFp: parseInt(id) })}
          onReEnableKey={(id) => reEnableApiKeyMutation.mutate({ apiKeyFp: parseInt(id) })}
          onDeleteKey={(id) => deleteApiKeyMutation.mutate({ apiKeyFp: parseInt(id) })}
        />
      </TabsContent>

      {/* More Settings Tab */}
      <TabsContent value="settings" className="mt-4">
        <div className="space-y-6">
          {/* Burst Setting */}
          <div className="rounded-lg border p-4 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label htmlFor="burst-toggle" className="text-sm font-medium">
                  Burst Allowed
                </Label>
                <Popover>
                  <PopoverTrigger>
                    <Info className="h-4 w-4 text-gray-400" />
                  </PopoverTrigger>
                  <PopoverContent className="text-sm max-w-xs">
                    When enabled, allows temporary traffic bursts beyond guaranteed bandwidth. Burst traffic is billed per-request.
                  </PopoverContent>
                </Popover>
              </div>
              <Switch
                id="burst-toggle"
                checked={moreSettings?.burstEnabled ?? false}
                onCheckedChange={(checked) => updateBurstMutation.mutate({ enabled: checked })}
                disabled={isGated || tier === 'starter'}
              />
            </div>
            {tier === 'starter' && (
              <p className="text-xs text-gray-500 mt-2">Available on Pro tier only</p>
            )}
          </div>

          {/* IP Allowlist (shared component) */}
          <IpAllowlistSection
            tier={tier}
            isGated={isGated}
            ipAllowlistEnabled={moreSettings?.ipAllowlistEnabled ?? false}
            ipAllowlist={moreSettings?.ipAllowlist ?? []}
            maxIpv4={usageStats?.allowlist.total ?? 2}
            isPending={updateIpAllowlistMutation.isPending}
            onToggle={(enabled) => updateIpAllowlistMutation.mutate({ enabled })}
            onSave={async (enabled, entries) => {
              const result = await updateIpAllowlistMutation.mutateAsync({ enabled, entries });
              return { entries: result.entries };
            }}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
