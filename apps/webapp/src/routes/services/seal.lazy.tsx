/**
 * Seal Service Configuration Page
 * Premium design with professional layout
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { SealConfigForm } from '../../components/services/SealConfigForm';
import { AlertCircle } from 'lucide-react';

export const Route = createLazyFileRoute('/services/seal')({
  component: SealServicePage,
});

function SealServicePage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="pb-6 border-b border-gray-200">
          <h1 className="text-2xl font-semibold text-gray-900">Seal Storage</h1>
          <p className="text-sm text-gray-600 mt-1">
            Configure your decentralized storage infrastructure powered by Walrus protocol
          </p>
        </div>

        {/* Status Alert */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-amber-900">Service not configured</div>
            <div className="text-sm text-amber-700 mt-1">
              Configure your service below to start using Seal Storage. No charges until you enable the service.
            </div>
          </div>
        </div>

        {/* Configuration Form */}
        <SealConfigForm />
      </div>
    </DashboardLayout>
  );
}
