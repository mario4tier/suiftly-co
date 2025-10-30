/**
 * API Keys Page
 * Cloudflare-inspired with Tailwind + shadcn/ui
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card } from '@/components/ui/card';

export const Route = createLazyFileRoute('/api-keys')({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-cf-lg font-semibold text-charcoal">API Keys</h1>
          <p className="text-cf-sm text-storm mt-1">
            Manage authentication keys for your services
          </p>
        </div>

        <Card className="p-12 border-dust shadow-cf-sm text-center">
          <div className="text-6xl mb-4">🔑</div>
          <h2 className="text-cf-base font-semibold text-charcoal mb-2">
            No API Keys
          </h2>
          <p className="text-cf-sm text-storm">
            Configure a service to generate API keys
          </p>
        </Card>
      </div>
    </DashboardLayout>
  );
}
