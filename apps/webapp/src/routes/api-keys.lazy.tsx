/**
 * API Keys Page
 * Global view of all API keys across services
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LinkButton } from '@/components/ui/link-button';
import { trpc } from '@/lib/trpc';

export const Route = createLazyFileRoute('/api-keys')({
  component: ApiKeysPage,
});

// Helper function to format relative time
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

function ApiKeysPage() {
  // Fetch Seal services and API keys
  const { data: services, isLoading: servicesLoading } = trpc.services.list.useQuery();
  const { data: apiKeys, isLoading: apiKeysLoading } = trpc.seal.listApiKeys.useQuery();

  // Find first Seal service for Manage button
  const sealService = services?.find(s => s.serviceType === 'seal');

  const isLoading = servicesLoading || apiKeysLoading;
  const isSealSubscribed = !!sealService;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold tracking-tight">API Keys</h2>
          <p className="text-muted-foreground mt-2">
            Pass these keys in the X-API-Key header for authentication.
          </p>
        </div>

        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">
            Loading API keys...
          </div>
        ) : (
          <div className="space-y-6">
            {/* Seal Section */}
            <Card>
              <CardHeader className="flex flex-row items-center gap-3 space-y-0 p-4">
                <CardTitle className="text-lg font-semibold">Seal</CardTitle>
                {isSealSubscribed && (
                  <LinkButton to="/services/seal/overview" search={{ tab: 'x-api-key' }}>
                    Manage
                  </LinkButton>
                )}
              </CardHeader>
              <CardContent className="p-4 pt-0">
                {apiKeys && apiKeys.length > 0 ? (
                  <div className="rounded-lg border">
                    <table className="w-full">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-3 py-2 text-left text-sm font-semibold">API Key</th>
                          <th className="px-3 py-2 text-left text-sm font-semibold">Created</th>
                          <th className="px-3 py-2 text-left text-sm font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {apiKeys.map((key) => (
                          <tr key={key.apiKeyId}>
                            <td className="px-3 py-2">
                              <code className="text-sm font-mono">{key.keyPreview}</code>
                            </td>
                            <td className="px-3 py-2 text-sm text-muted-foreground">
                              {formatRelativeTime(new Date(key.createdAt))}
                            </td>
                            <td className="px-3 py-2">
                              {key.isActive ? (
                                <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                  Active
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full px-2 py-1 text-xs font-medium bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                                  Revoked
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : isSealSubscribed ? (
                  <p className="text-sm text-muted-foreground">
                    No API keys used yet.
                  </p>
                ) : (
                  <div>
                    <LinkButton to="/services/seal/overview">
                      Subscribe To Seal Service
                    </LinkButton>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* gRPC Section */}
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-lg font-semibold">gRPC</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-sm text-muted-foreground">
                  No API keys used yet.
                </p>
              </CardContent>
            </Card>

            {/* GraphQL Section */}
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-lg font-semibold">GraphQL</CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <p className="text-sm text-muted-foreground">
                  No API keys used yet.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
