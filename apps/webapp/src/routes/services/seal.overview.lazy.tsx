/**
 * Seal Service Configuration Page
 * Premium design with professional layout
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { SealConfigForm } from '../../components/services/SealConfigForm';
import { SealInteractiveForm } from '../../components/services/SealInteractiveForm';
import { AlertCircle, CheckCircle, PauseCircle, AlertTriangle } from 'lucide-react';
import { type ServiceStatus } from '@suiftly/shared/schemas';
import { type ServiceState, type ServiceTier } from '@suiftly/shared/constants';
import { trpc } from '../../lib/trpc';

export const Route = createLazyFileRoute('/services/seal/overview')({
  component: SealOverviewPage,
});

function SealOverviewPage() {
  const [tierSelected, setTierSelected] = useState(false);

  // Fetch services using React Query hook
  const { data: services, isLoading } = trpc.services.list.useQuery();

  // Find seal service
  const sealService = services?.find(s => s.serviceType === 'seal');

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
  const tier: ServiceTier = (sealService?.tier as ServiceTier) ?? 'pro';
  const isEnabled = sealService?.isEnabled ?? false;

  // Determine which form to show based on service state
  // Note: 'provisioning' state is reserved for future use and not currently set by backend
  const showOnboardingForm = serviceState === 'not_provisioned';
  const showInteractiveForm = !showOnboardingForm;

  const getStatusBanner = () => {
    switch (serviceState) {
      case 'disabled':
        return {
          icon: PauseCircle,
          bgColor: 'bg-amber-50 dark:bg-amber-900/20',
          borderColor: 'border-amber-200 dark:border-amber-900',
          iconColor: 'text-amber-600 dark:text-amber-500',
          textColor: 'text-amber-900 dark:text-amber-200',
          message: 'Service is subscribed but currently disabled. Enable to start serving traffic.',
        };
      case 'enabled':
        return {
          icon: CheckCircle,
          bgColor: 'bg-green-50 dark:bg-green-900/20',
          borderColor: 'border-green-200 dark:border-green-900',
          iconColor: 'text-green-600 dark:text-green-500',
          textColor: 'text-green-900 dark:text-green-200',
          message: 'Service is active and serving traffic.',
        };
      case 'suspended_maintenance':
        return {
          icon: AlertTriangle,
          bgColor: 'bg-blue-50 dark:bg-blue-900/20',
          borderColor: 'border-blue-200 dark:border-blue-900',
          iconColor: 'text-blue-600 dark:text-blue-500',
          textColor: 'text-blue-900 dark:text-blue-200',
          message: 'Service suspended for maintenance. Configuration and keys preserved at $2/month. Resume anytime.',
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
      default:
        return null;
    }
  };

  const banner = getStatusBanner();

  return (
    <DashboardLayout>
      <div className="space-y-4">
        {/* Page Header */}
        <div className="pb-4 border-b border-gray-200 dark:border-gray-800">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">
            {showOnboardingForm ? 'Configure Seal Service' : 'Seal'}
          </h1>
        </div>

        {/* Status Banner - Show for State 3+ */}
        {banner && (
          <div className={`${banner.bgColor} border ${banner.borderColor} rounded-lg p-3 flex gap-3`}>
            <banner.icon className={`h-5 w-5 ${banner.iconColor} flex-shrink-0 mt-0.5`} />
            <div className="flex-1">
              <div className={`text-sm ${banner.textColor}`}>
                {banner.message}
              </div>
            </div>
          </div>
        )}

        {/* Conditional Form Rendering */}
        {showOnboardingForm ? (
          <SealConfigForm onTierChange={setTierSelected} />
        ) : (
          <SealInteractiveForm
            serviceState={serviceState}
            tier={tier}
            isEnabled={isEnabled}
            onToggleService={(enabled) => console.log('Toggle service:', enabled)}
            onChangePlan={() => console.log('Change plan')}
          />
        )}
      </div>
    </DashboardLayout>
  );
}
