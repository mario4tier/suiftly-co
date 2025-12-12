/**
 * Dashboard Route
 * Shows service overview with 24h stats summary
 * Auth guard handled by __root.tsx global guard
 */

import { createFileRoute, Link } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { ServiceStatusIndicator } from '../components/ui/service-status-indicator';
import { trpc } from '../lib/trpc';
import { useServicesStatus } from '../hooks/useServicesStatus';
import {
  Activity,
  ArrowRight,
  BarChart3,
  Loader2,
  Shield,
} from 'lucide-react';

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

// Service type configuration
const SERVICE_CONFIGS = {
  seal: {
    name: 'Seal',
    description: 'Encrypted blob storage with privacy-preserving access control',
    icon: Shield,
    statsPath: '/services/seal/stats',
    overviewPath: '/services/seal/overview',
  },
  grpc: {
    name: 'gRPC',
    description: 'High-performance RPC service',
    icon: Activity,
    statsPath: '/services/grpc',
    overviewPath: '/services/grpc',
  },
  graphql: {
    name: 'GraphQL',
    description: 'Flexible query API service',
    icon: Activity,
    statsPath: '/services/graphql',
    overviewPath: '/services/graphql',
  },
} as const;

type ServiceType = keyof typeof SERVICE_CONFIGS;

function ServiceCard({ serviceType }: { serviceType: ServiceType }) {
  const config = SERVICE_CONFIGS[serviceType];
  const Icon = config.icon;

  // Fetch services list to get service status
  const { data: services, isLoading: servicesLoading } = trpc.services.list.useQuery();

  // Unified status from backend with adaptive polling
  const { getServiceStatus } = useServicesStatus();
  const serviceStatus = getServiceStatus(serviceType as 'seal' | 'grpc' | 'graphql');

  // Fetch 24h stats summary
  const { data: stats, isLoading: statsLoading } = trpc.stats.getSummary.useQuery(
    { serviceType },
    { enabled: !!services }
  );

  const service = services?.find(s => s.serviceType === serviceType);
  const isProvisioned = service?.state !== 'not_provisioned' && service?.state !== undefined;
  const isEnabled = service?.isUserEnabled ?? false;

  // Format large numbers
  const formatNumber = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  if (servicesLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      </Card>
    );
  }

  // Service not provisioned
  if (!isProvisioned) {
    return (
      <Card className="p-6 opacity-60">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-gray-100 dark:bg-gray-800 rounded-lg">
            <Icon className="h-6 w-6 text-gray-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 dark:text-gray-50">{config.name}</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Not configured
            </p>
            <Link
              to={config.overviewPath}
              className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline mt-3"
            >
              Set up service <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  const successCount = stats?.successCount ?? 0;
  const totalRequests = stats?.totalRequests ?? 0;

  return (
    <Card className="p-6">
      <div className="flex items-start gap-4">
        <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
          <Icon className="h-6 w-6 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-900 dark:text-gray-50">{config.name}</h3>
            <ServiceStatusIndicator
              operationalStatus={serviceStatus?.operationalStatus}
              isSyncing={serviceStatus?.syncStatus === 'pending'}
              fallbackIsEnabled={isEnabled}
              size="sm"
            />
          </div>

          {/* 24h Stats Summary */}
          <div className="mt-4">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">Last 24 hours</div>
            {statsLoading ? (
              <div className="flex items-center gap-2 text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading stats...</span>
              </div>
            ) : totalRequests === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No requests yet</p>
            ) : (
              <p className="text-sm text-gray-900 dark:text-gray-50">
                <span className="font-medium">{formatNumber(totalRequests)}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {' '}reqs ({(() => {
                    const successRate = (successCount / totalRequests) * 100;
                    if (successRate > 99) return '>99';
                    return Math.round(successRate);
                  })()}% success)
                </span>
              </p>
            )}
          </div>

          {/* Links */}
          <div className="flex items-center gap-4 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
            <Link
              to={config.statsPath}
              className="inline-flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              <BarChart3 className="h-3 w-3" />
              View Stats
            </Link>
            <Link
              to={config.overviewPath}
              className="inline-flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:underline"
            >
              Configure <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

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

        {/* Services Grid */}
        <div>
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-50 mb-4">Services</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            <ServiceCard serviceType="seal" />
            <ServiceCard serviceType="grpc" />
            <ServiceCard serviceType="graphql" />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
