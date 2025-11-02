/**
 * Seal Service Configuration Page
 * Premium design with professional layout
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { SealConfigForm } from '../../components/services/SealConfigForm';
import { AlertCircle, CheckCircle, PauseCircle } from 'lucide-react';
import { type ServiceStatus } from '@suiftly/shared/schemas';

export const Route = createLazyFileRoute('/services/seal/overview')({
  component: SealConfigPage,
});

function SealConfigPage() {
  const [tierSelected, setTierSelected] = useState(false);

  // TODO: This should come from the API
  const serviceStatus: ServiceStatus = 'NotProvisioned';

  const getStatusAlert = () => {
    switch (serviceStatus) {
      case 'NotProvisioned':
        return {
          icon: AlertCircle,
          bgColor: 'bg-amber-50 dark:bg-amber-900/20',
          borderColor: 'border-amber-200 dark:border-amber-900',
          iconColor: 'text-amber-600 dark:text-amber-500',
          textColor: 'text-amber-900 dark:text-amber-200',
          message: tierSelected
            ? 'Service not enabled. No charge until enabled.'
            : 'Service not configured. No charge until enabled.',
        };
      case 'Enabled':
        return {
          icon: CheckCircle,
          bgColor: 'bg-green-50 dark:bg-green-900/20',
          borderColor: 'border-green-200 dark:border-green-900',
          iconColor: 'text-green-600 dark:text-green-500',
          textColor: 'text-green-900 dark:text-green-200',
          message: 'Service is active and billing.',
        };
      case 'Disabled':
        return {
          icon: PauseCircle,
          bgColor: 'bg-gray-50 dark:bg-gray-900/20',
          borderColor: 'border-gray-200 dark:border-gray-800',
          iconColor: 'text-gray-600 dark:text-gray-500',
          textColor: 'text-gray-900 dark:text-gray-200',
          message: 'Service is paused. No billing while disabled.',
        };
    }
  };

  const alert = getStatusAlert();
  const StatusIcon = alert.icon;

  return (
    <DashboardLayout>
      <div className="space-y-4">
        {/* Page Header */}
        <div className="pb-4 border-b border-gray-200 dark:border-gray-800">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">Seal Configuration</h1>
        </div>

        {/* Status Alert */}
        <div className={`${alert.bgColor} border ${alert.borderColor} rounded-lg p-3 flex gap-3`}>
          <StatusIcon className={`h-5 w-5 ${alert.iconColor} flex-shrink-0 mt-0.5`} />
          <div className="flex-1">
            <div className={`text-sm ${alert.textColor}`}>
              {alert.message}
            </div>
          </div>
        </div>

        {/* Configuration Form */}
        <SealConfigForm onTierChange={setTierSelected} serviceStatus={serviceStatus} />
      </div>
    </DashboardLayout>
  );
}
