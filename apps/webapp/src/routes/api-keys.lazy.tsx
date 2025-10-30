/**
 * API Keys Page
 */

import { createLazyFileRoute } from '@tanstack/react-router';
import { DashboardLayout } from '../components/layout/DashboardLayout';
import { Card, CardContent } from '@/components/ui/card';

export const Route = createLazyFileRoute('/api-keys')({
  component: ApiKeysPage,
});

function ApiKeysPage() {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">API Keys</h2>
          <p className="text-muted-foreground mt-2">
            Manage authentication keys for your services
          </p>
        </div>

        <Card>
          <CardContent className="pt-12 pb-12 text-center">
            <div className="text-6xl mb-4">🔑</div>
            <h3 className="text-xl font-semibold mb-2">No API Keys</h3>
            <p className="text-muted-foreground">
              Configure a service to generate API keys
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
