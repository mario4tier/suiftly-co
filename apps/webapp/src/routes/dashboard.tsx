/**
 * Dashboard Route (with auth guard)
 * Redirects to /login if not authenticated
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { useAuthStore } from '../stores/auth';
import { DashboardLayout } from '../components/layout/DashboardLayout';

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ location }) => {
    const { isAuthenticated } = useAuthStore.getState();

    if (!isAuthenticated) {
      throw redirect({
        to: '/login',
        search: {
          redirect: location.href,
        },
      });
    }
  },
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div className="pb-6 border-b border-[#e5e7eb] dark:border-[#374151]">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">Dashboard</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Overview of your services and usage
          </p>
        </div>

        {/* Content - Placeholder for now */}
        <div className="bg-white dark:bg-gray-800 border border-[#e5e7eb] dark:border-[#374151] rounded-lg p-8">
          <p className="text-gray-600 dark:text-gray-400 text-center">
            Dashboard content coming soon
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}
