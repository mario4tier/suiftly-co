/**
 * Seal Service Stats Page
 * Placeholder for future implementation
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../../components/layout/DashboardLayout';
import { BarChart3 } from 'lucide-react';

export const Route = createLazyFileRoute('/services/seal/stats')({
  component: SealStatsPage,
});

function SealStatsPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="pb-6 border-b border-gray-200 dark:border-gray-800">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">Seal Statistics</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Monitor usage and performance metrics for your Seal service
          </p>
        </div>

        {/* Coming Soon Message */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded-lg p-8 text-center">
          <BarChart3 className="h-16 w-16 text-blue-600 dark:text-blue-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-50 mb-2">
            Statistics Coming Soon
          </h2>
          <p className="text-gray-600 dark:text-gray-400">
            Detailed usage analytics, performance metrics, and monitoring dashboards will be available here.
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}
